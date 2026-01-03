import { state } from '../../state';
import { mlClient } from '../../../lib/ml/worker-client';
import {
    saveDecision as apiSaveDecision,
    getReferencesWithStatus,
    getDecisions,
    appendDecisions,
    updateDecisionsBatch
} from '../../../lib/sheets-api';
import { Decision } from '../../../lib/types';
import { MlRecord, Label, createStoppingRule } from '../../../lib/ml/types';
import { renderMlSection, renderMlStats } from './render';
import { showStoppingSettingsDialog, showStoppingReachedDialog, showInitialStoppingRuleDialog } from './stopping';
import { updateStoppingProgress, isStoppingReached } from '../../../lib/ml/stopping-rules';
import { showToast, showLoading } from '../../ui/feedback';
import { getMlFilteredRanking, parseMlSearchQuery, resolveMlRanking } from './search';

// Store互換レイヤー（Phase 5）
import {
    changeTab as syncChangeTab,
    setMlState as syncSetMlState,
    setReferences as syncSetReferences,
} from '../../store/compat';

// Map ML Label type
function mapDecisionToLabel(decision: 'include' | 'exclude'): 1 | 0 {
    return decision === 'include' ? 1 : 0;
}

function buildMlLabelsFromReferences(): Record<string, Label> {
    const labels: Record<string, Label> = {};

    state.references.forEach((ref) => {
        const decision = ref.myDecision?.decision;
        if (decision === 'include' || decision === 'exclude') {
            labels[ref.ref_id] = mapDecisionToLabel(decision);
        }
    });

    return labels;
}

// ========== ストレージ関数 ==========

/**
 * 停止基準の設定をブラウザに保存（プロジェクトごと）
 */
async function saveStoppingRuleToStorage(threshold: number): Promise<void> {
    const key = `mlStoppingRule_${state.spreadsheetId}`;
    await chrome.storage.local.set({
        [key]: { confirmed: true, threshold }
    });
}

/**
 * 停止基準の設定をブラウザから読み込み（プロジェクトごと）
 */
async function loadStoppingRuleFromStorage(): Promise<{ confirmed: boolean; threshold: number }> {
    const key = `mlStoppingRule_${state.spreadsheetId}`;
    const result = await chrome.storage.local.get([key]);
    const data = result[key];

    if (data && data.confirmed) {
        return {
            confirmed: true,
            threshold: data.threshold || 50
        };
    }

    return {
        confirmed: false,
        threshold: 50
    };
}


// ========== 要素 ==========

const elements = {
    buttons: {
        include: () => document.getElementById('ml-btn-include'),
        exclude: () => document.getElementById('ml-btn-exclude'),
        skip: () => document.getElementById('ml-btn-skip'),
        stoppingSettings: () => document.getElementById('ml-stopping-settings-btn'),
        back: () => document.getElementById('ml-back-btn'),
    }
};

export function initMlHandlers() {
    // Buttons
    elements.buttons.include()?.addEventListener('click', () => handleMlDecision('include'));
    elements.buttons.exclude()?.addEventListener('click', () => handleMlDecision('exclude'));
    elements.buttons.skip()?.addEventListener('click', () => handleMlNext());

    elements.buttons.stoppingSettings()?.addEventListener('click', () => {
        showStoppingSettingsDialog();
    });

    elements.buttons.back()?.addEventListener('click', () => {
        // Go back to screening tab (handled by external router logic usually, but here simple switch)
        // Assuming there is a global tab switcher, but for now specific back button logic
        document.getElementById('tab-screening')?.click();
    });

    // Subscribe to Worker updates
    mlClient.subscribe((newState) => {
        const currentState = state.mlState;
        // Store経由で両方に同期
        syncSetMlState({
            ...currentState,
            status: newState.status,
            labeledCount: newState.labeledCount,
            ranking: newState.ranking,
            errorMessage: newState.errorMessage,
            lastUpdated: newState.lastUpdated
        });
        renderMlStats();

        // If ranking updated, re-render current reference (might change)
        if (state.currentTab === 'ml') {
            // If we are showing 'No more records' or similar, check if new ranking helps
            // But mainly just refresh the view
            // Note: Changing reference under user's eyes might be jarring?
            // ASReview updates ranking in background but doesn't swap current card unless user clicks next?
            // But if we are at list head, the head changes.
            // We should only update if we are not interacting. 
            // For now simple re-render.
            renderMlSection();
        }
    });
}

export async function activateMlTab() {
    // Store経由で両方に同期
    syncChangeTab('ml');
    renderMlSection();

    // Check if initialization needed
    if (state.mlState.status === 'idle') {
        // ストレージから設定を読み込み
        const savedRule = await loadStoppingRuleFromStorage();

        if (!savedRule.confirmed) {
            // 初回: ダイアログを表示
            showInitialStoppingRuleDialog(async (threshold) => {
                // 設定をブラウザに保存
                await saveStoppingRuleToStorage(threshold);

                // 停止基準を設定（Store経由で両方に同期）
                syncSetMlState({
                    ...state.mlState,
                    stoppingRule: createStoppingRule(threshold)
                });

                await initMlWorker();
                renderMlSection();  // UI全体を更新
            });
        } else {
            // 2回目以降: 保存された設定を使用
            if (!state.mlState.stoppingRule) {
                // Store経由で両方に同期
                syncSetMlState({
                    ...state.mlState,
                    stoppingRule: createStoppingRule(savedRule.threshold)
                });
            }
            await initMlWorker();
            renderMlSection();  // UI全体を更新
        }
    }
}


async function initMlWorker() {
    // 1. Prepare records for Worker (mlRecord format)
    // We use all references currently loaded
    const mlRecords = state.references.map(r => ({
        refId: r.ref_id, // Map id to refId
        title: r.title || '',
        abstract: r.abstract || ''
    }));

    // 2. Prepare Labels
    // We need to fetch current labels map
    const labels = buildMlLabelsFromReferences();

    mlClient.init(mlRecords, labels);
}

async function handleMlDecision(decision: 'include' | 'exclude') {
    // 1. Identify current record
    const ref = getCurrentMlReference();
    if (!ref) return;

    // 2. Save decision
    const decisionObj: Decision = {
        decision_id: ref.myDecision?.decision_id || crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: state.userEmail,
        decision,
        decided_at: new Date().toISOString(),
        client_version: '0.7.0-ml',  // ML Enhanced marker
    };
    ref.myDecision = decisionObj;
    ref.status = decision; // Local update

    // API Save (background)
    apiSaveDecision(state.spreadsheetId, decisionObj).catch(err => {
        console.error('Failed to save decision', err);
        showToast('保存に失敗しました'); // Fixed: removed 'error'
    });

    // 3. Update Stopping Rule
    if (state.mlState.stoppingRule) {
        // Pass decision ('include' | 'exclude') directly as expected by updateStoppingProgress
        const newRule = updateStoppingProgress(state.mlState.stoppingRule, decision);
        // Store経由で両方に同期
        syncSetMlState({
            ...state.mlState,
            stoppingRule: newRule
        });

        // Check stopping condition
        if (isStoppingReached(newRule)) {
            showStoppingReachedDialog(
                (addCount) => {
                    // Extend threshold（Store経由で両方に同期）
                    const extendedRule = { ...newRule, threshold: newRule.threshold + addCount };
                    syncSetMlState({
                        ...state.mlState,
                        stoppingRule: extendedRule
                    });
                    renderMlStats();
                    handleMlNext(); // Continue to next
                },
                () => {
                    // Finish
                    showToast('スクリーニングを終了します');
                    // Maybe redirect or show summary?
                }
            );
            return; // Don't move next automatically if dialog shown?
            // Actually ASReview shows dialog. User chooses.
        }
    }

    // 4. Update Worker (NB model)
    const labels = buildMlLabelsFromReferences();
    mlClient.updateLabels(labels);

    // 5. Move next
    handleMlNext();
}

function handleMlNext() {
    // Advance index to next UNLABELED item in ranking
    moveToNextUnlabeled();
    renderMlSection();
}

function moveToNextUnlabeled() {
    const filteredRanking = getCurrentMlFilteredRanking();
    if (filteredRanking.length === 0) {
        // Store経由で両方に同期
        syncSetMlState({
            ...state.mlState,
            currentIndex: 0
        });
        return;
    }

    // 検索条件に合致したランキング内で未判定を探す
    let foundIndex = -1;
    for (let i = 0; i < filteredRanking.length; i++) {
        const refId = filteredRanking[i];
        const ref = state.references.find(r => r.ref_id === refId);
        if (ref) {
            // Check if labeled by ME
            // We use ref.status or ref.myDecision
            const isLabeled = ref.myDecision && ref.myDecision.decision !== 'pending';
            if (!isLabeled) {
                foundIndex = i;
                break;
            }
        }
    }

    if (foundIndex !== -1) {
        // Store経由で両方に同期
        syncSetMlState({
            ...state.mlState,
            currentIndex: foundIndex
        });
    } else {
        // All labeled?
        // Keep index at end or show finished?
        // Store経由で両方に同期
        syncSetMlState({
            ...state.mlState,
            currentIndex: filteredRanking.length
        });
    }
}

function getCurrentMlReference() {
    const filteredRanking = getCurrentMlFilteredRanking();
    const index = state.mlState.currentIndex;
    if (index >= filteredRanking.length) return null;
    const refId = filteredRanking[index];
    return state.references.find(r => r.ref_id === refId) || null;
}

function getCurrentMlFilteredRanking(): string[] {
    const searchInput = document.getElementById('ml-search-input') as HTMLInputElement | null;
    const searchKeyword = searchInput?.value.trim() || '';
    const ranking = resolveMlRanking(state.references, state.mlState.ranking);
    const { terms, mode } = parseMlSearchQuery(searchKeyword, state.termFilterUseAnd);
    return getMlFilteredRanking(ranking, state.references, terms, mode);
}

/**
 * ML画面用キーボードショートカットハンドラ
 */
export function handleMlKeydown(e: KeyboardEvent) {
    // 入力フォーム内では無効
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
    }

    // MLタブがアクティブでない場合は処理しない
    if (state.currentTab !== 'ml') {
        return;
    }

    // 修飾キーなし
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
            case 'i': // Include
                handleMlDecision('include');
                e.preventDefault();
                break;
            case 'e': // Exclude
                handleMlDecision('exclude');
                e.preventDefault();
                break;
            case 'arrowright': // Next (Skip)
            case 'j':
            case 's': // Skip
            case 'n': // Next
                handleMlNext();
                e.preventDefault();
                break;
            case 'arrowleft': // Prev (undo-like, but for ML we just skip)
            case 'k':
                // ML mode doesn't have a "previous" concept in the same way
                // For now, we can skip this or show a toast
                showToast('MLモードでは「前へ」はありません');
                e.preventDefault();
                break;
        }
    }
}

/**
 * 残りの未判定レコードを一括でexcludeとして保存
 * @param onProgress 進捗コールバック (current, total)
 * @returns 保存成功件数
 */
export async function bulkExcludeRemaining(
    onProgress?: (current: number, total: number) => void
): Promise<{ successCount: number; totalCount: number }> {
    // 未判定レコードを取得
    const unlabeledRefs = state.references.filter(r =>
        !r.myDecision || r.status === 'pending'
    );

    const totalCount = unlabeledRefs.length;
    if (totalCount === 0) return { successCount: 0, totalCount: 0 };

    let processedCount = 0;
    let successCount = 0;

    // 1. 現在の決定状況を一括取得（UpdateかAppendか判断するため）
    // 個別にapiSaveDecisionを呼ぶと、都度読み込みが発生して遅い＆API制限にかかるため
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
        // 失敗した場合でも続行不能とするか、個別処理にフォールバックするか？
        // ここではエラーとして終了
        throw new Error('事前データの取得に失敗しました');
    }

    // 2. 更新用・追加用リストを作成
    const toAppend: { ref: any; decision: Decision }[] = [];
    const toUpdate: { ref: any; rowIndex: number; decision: Decision }[] = [];

    const now = new Date().toISOString();

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
            client_version: '0.7.0-ml-auto',
        };

        if (existing) {
            toUpdate.push({ ref, rowIndex: existing.rowIndex, decision });
        } else {
            toAppend.push({ ref, decision });
        }
    }

    // 3. バッチ実行（チャンク分割して進捗報告できるようにする）
    const BATCH_SIZE = 100; // API制限を回避しつつ高速化

    // Append実行
    for (let i = 0; i < toAppend.length; i += BATCH_SIZE) {
        const chunk = toAppend.slice(i, i + BATCH_SIZE);
        try {
            await appendDecisions(state.spreadsheetId, chunk.map(c => c.decision));

            // ローカル状態更新
            chunk.forEach(item => {
                item.ref.myDecision = item.decision;
                item.ref.status = 'exclude';
            });
            successCount += chunk.length;
        } catch (err) {
            console.error('Batch append failed:', err);
        }

        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount, totalCount);
    }

    // Update実行
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const chunk = toUpdate.slice(i, i + BATCH_SIZE);
        try {
            await updateDecisionsBatch(
                state.spreadsheetId,
                chunk.map(c => ({ rowIndex: c.rowIndex, decision: c.decision }))
            );

            // ローカル状態更新
            chunk.forEach(item => {
                item.ref.myDecision = item.decision;
                item.ref.status = 'exclude';
            });
            successCount += chunk.length;
        } catch (err) {
            console.error('Batch update failed:', err);
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
        // 1. 参照データを再読み込み（最新の判定情報込み）
        const refs = await getReferencesWithStatus(state.spreadsheetId, state.userEmail);
        // Store経由で両方に同期
        syncSetReferences(refs);

        // 2. ML状態をリセット
        const { createInitialMlState } = await import('../../../lib/ml/types');
        // Store経由で両方に同期
        syncSetMlState(createInitialMlState());

        // 3. ML Workerを再初期化
        await initMlWorker();

        // 4. UI更新
        renderMlSection();

        showToast('新しいMLレビューを開始しました');
    } catch (err) {
        console.error('Failed to reset ML review:', err);
        showToast('リセットに失敗しました');
    } finally {
        showLoading(false);
    }
}
