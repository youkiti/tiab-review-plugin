import { state } from '../../state';
import { mlClient } from '../../../lib/ml/worker-client';
import { Decision } from '../../../lib/types';
import type { Label } from '../../../lib/ml/types';
import { t } from '../../../lib/i18n';
import {
    loadProjectSnapshot,
    selectReferencesWithStatus,
    getDecisions,
    appendDecisions,
    updateDecisionsBatch,
} from '../../../lib/sheets-api';
import { renderMlSection } from './render';
import { showToast, showLoading } from '../../ui/feedback';
import { enqueueDecision } from '../../utils/offline-queue';
import { getMlClientVersion } from './version';

// Store互換レイヤー（Phase 5）
import {
    setReferences as syncSetReferences,
    setMlState as syncSetMlState,
} from '../../store/compat';

// Map ML Label type
function mapDecisionToLabel(decision: 'include' | 'exclude'): 1 | 0 {
    return decision === 'include' ? 1 : 0;
}

export function buildMlLabelsFromReferences(): Record<string, Label> {
    const labels: Record<string, Label> = {};

    state.references.forEach((ref) => {
        const decision = ref.myDecision?.decision;
        if (decision === 'include' || decision === 'exclude') {
            labels[ref.ref_id] = mapDecisionToLabel(decision);
        }
    });

    return labels;
}

export async function initMlWorker(): Promise<void> {
    const mlRecords = state.references.map(r => ({
        refId: r.ref_id,
        title: r.title || '',
        abstract: r.abstract || ''
    }));

    const labels = buildMlLabelsFromReferences();
    mlClient.init(mlRecords, labels);
}

/**
 * 残りの未判定レコードを一括でexcludeとして保存
 * @param onProgress 進捗コールバック (current, total)
 * @returns 保存成功件数
 */
export async function bulkExcludeRemaining(
    onProgress?: (current: number, total: number) => void
): Promise<{ successCount: number; totalCount: number }> {
    const unlabeledRefs = state.references.filter(r =>
        !r.myDecision || r.status === 'pending'
    );

    const totalCount = unlabeledRefs.length;
    if (totalCount === 0) return { successCount: 0, totalCount: 0 };

    let processedCount = 0;
    let successCount = 0;

    let myDecisionsMap = new Map<string, { rowIndex: number; decisionId: string }>();
    try {
        const allDecisions = await getDecisions(state.spreadsheetId);
        allDecisions.forEach(({ decision, rowIndex }) => {
            if (decision.reviewer_id === state.userEmail) {
                myDecisionsMap.set(decision.ref_id, {
                    rowIndex,
                    decisionId: decision.decision_id
                });
            }
        });
    } catch (err) {
        console.error('Failed to pre-fetch decisions:', err);
        throw new Error(t('ml_preFetchFailed'));
    }

    const toAppend: { ref: any; decision: Decision }[] = [];
    const toUpdate: { ref: any; rowIndex: number; decision: Decision }[] = [];

    const now = new Date().toISOString();
    const clientVersion = getMlClientVersion('-ml-auto');

    for (const ref of unlabeledRefs) {
        const existing = myDecisionsMap.get(ref.ref_id);
        const decisionId = existing ? existing.decisionId : crypto.randomUUID();

        const decision: Decision = {
            decision_id: decisionId,
            ref_id: ref.ref_id,
            reviewer_id: state.userEmail,
            decision: 'exclude',
            note: 'ML stopping rule - auto excluded',
            decided_at: now,
            client_version: clientVersion,
        };

        if (existing) {
            toUpdate.push({ ref, rowIndex: existing.rowIndex, decision });
        } else {
            toAppend.push({ ref, decision });
        }
    }

    const BATCH_SIZE = 100;

    for (let i = 0; i < toAppend.length; i += BATCH_SIZE) {
        const chunk = toAppend.slice(i, i + BATCH_SIZE);
        try {
            await appendDecisions(state.spreadsheetId, chunk.map(c => c.decision));

            chunk.forEach(item => {
                item.ref.myDecision = item.decision;
                item.ref.status = 'exclude';
            });
            successCount += chunk.length;
        } catch (err) {
            console.error('Batch append failed:', err);
            await Promise.all(
                chunk.map(item => enqueueDecision(state.spreadsheetId, state.userEmail, item.decision))
            );
        }

        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount, totalCount);
    }

    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const chunk = toUpdate.slice(i, i + BATCH_SIZE);
        try {
            await updateDecisionsBatch(
                state.spreadsheetId,
                chunk.map(c => ({ rowIndex: c.rowIndex, decision: c.decision }))
            );

            chunk.forEach(item => {
                item.ref.myDecision = item.decision;
                item.ref.status = 'exclude';
            });
            successCount += chunk.length;
        } catch (err) {
            console.error('Batch update failed:', err);
            await Promise.all(
                chunk.map(item => enqueueDecision(state.spreadsheetId, state.userEmail, item.decision))
            );
        }

        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount, totalCount);
    }

    return { successCount, totalCount };
}

/**
 * 現在のML状態の統計を取得
 */
export function getMlStats(): {
    include: number;
    exclude: number;
    autoExcluded: number;
    remaining: number;
} {
    let include = 0;
    let exclude = 0;
    let autoExcluded = 0;
    let remaining = 0;

    state.references.forEach(ref => {
        if (!ref.myDecision || ref.status === 'pending') {
            remaining++;
        } else if (ref.myDecision.decision === 'include') {
            include++;
        } else if (ref.myDecision.decision === 'exclude') {
            if (ref.myDecision.client_version?.includes('-ml-auto')) {
                autoExcluded++;
            }
            exclude++;
        }
    });

    return { include, exclude, autoExcluded, remaining };
}

/**
 * MLレビューをリセットして新規開始
 */
export async function resetAndStartNewMlReview() {
    showLoading(true);

    try {
        const snapshot = await loadProjectSnapshot(state.spreadsheetId, state.userEmail, { history: false, duplicateCandidates: false });
        if (snapshot.spreadsheetId !== state.spreadsheetId) return;
        const refs = selectReferencesWithStatus(snapshot, state.userEmail, false);
        syncSetReferences(refs);

        const { createInitialMlState } = await import('../../../lib/ml/types');
        syncSetMlState(createInitialMlState());

        await initMlWorker();
        renderMlSection();

        showToast(t('ml_newReviewStarted'));
    } catch (err) {
        console.error('Failed to reset ML review:', err);
        showToast(t('ml_resetFailed'));
    } finally {
        showLoading(false);
    }
}
