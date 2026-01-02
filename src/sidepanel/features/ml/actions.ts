import { state } from '../../state';
import { mlClient } from '../../../lib/ml/worker-client';
import {
    saveDecision as apiSaveDecision,
    getReferencesWithStatus
} from '../../../lib/sheets-api';
import { Decision } from '../../../lib/types';
import { MlRecord, Label, createStoppingRule } from '../../../lib/ml/types';
import { renderMlSection, renderMlStats } from './render';
import { showStoppingSettingsDialog, showStoppingReachedDialog, showInitialStoppingRuleDialog } from './stopping';
import { updateStoppingProgress, isStoppingReached } from '../../../lib/ml/stopping-rules';
import { showToast, showLoading } from '../../ui/feedback';

// Map ML Label type
function mapDecisionToLabel(decision: 'include' | 'exclude'): 1 | 0 {
    return decision === 'include' ? 1 : 0;
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
        state.setMlState({
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
    state.setCurrentTab('ml');
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

                // 停止基準を設定
                state.setMlState({
                    ...state.mlState,
                    stoppingRule: createStoppingRule(threshold)
                });

                await initMlWorker();
                renderMlSection();  // UI全体を更新
            });
        } else {
            // 2回目以降: 保存された設定を使用
            if (!state.mlState.stoppingRule) {
                state.setMlState({
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
    const labels: Record<string, 1 | 0 | -1> = {};

    // We should use references' status if available
    state.references.forEach(r => {
        if (r.myDecision?.decision === 'include') labels[r.ref_id] = 1;
        else if (r.myDecision?.decision === 'exclude') labels[r.ref_id] = 0;
    });

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
        state.setMlState({
            ...state.mlState,
            stoppingRule: newRule
        });

        // Check stopping condition
        if (isStoppingReached(newRule)) {
            showStoppingReachedDialog(
                (addCount) => {
                    // Extend threshold
                    const extendedRule = { ...newRule, threshold: newRule.threshold + addCount };
                    state.setMlState({
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
    const labels: Record<string, 1 | 0 | -1> = {};
    labels[ref.ref_id] = mapDecisionToLabel(decision);
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
    const ranking = state.mlState.ranking;
    if (!ranking || ranking.length === 0) {
        // Fallback to simple index increment of state.references?
        // But render uses ranking.
        return;
    }

    let currentIndex = state.mlState.currentIndex;

    // Start searching from current + 1
    // But we need to check if current item is labeled.
    // The ranking might change asynchronously.
    // Strategy: scan ranking from top (0) until we find an unlabeled item.
    // This ensures we always pick the highest prob unlabeled item.

    let foundIndex = -1;
    for (let i = 0; i < ranking.length; i++) {
        const refId = ranking[i];
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
        state.setMlState({
            ...state.mlState,
            currentIndex: foundIndex
        });
    } else {
        // All labeled?
        // Keep index at end or show finished?
        state.setMlState({
            ...state.mlState,
            currentIndex: ranking.length
        });
    }
}

function getCurrentMlReference() {
    const ranking = state.mlState.ranking;
    const index = state.mlState.currentIndex;

    if (ranking.length > 0) {
        if (index >= ranking.length) return null;
        const refId = ranking[index];
        return state.references.find(r => r.ref_id === refId) || null;
    }

    // Fallback
    if (state.references.length > 0 && index < state.references.length) {
        return state.references[index];
    }
    return null;
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
    let successCount = 0;
    const batchSize = 10; // 並列処理数

    for (let i = 0; i < unlabeledRefs.length; i += batchSize) {
        const batch = unlabeledRefs.slice(i, i + batchSize);

        await Promise.all(batch.map(async (ref) => {
            const decision: Decision = {
                decision_id: crypto.randomUUID(),
                ref_id: ref.ref_id,
                reviewer_id: state.userEmail,
                decision: 'exclude',
                note: 'ML stopping rule - auto excluded',
                decided_at: new Date().toISOString(),
                client_version: '0.7.0-ml-auto',  // Auto-exclude marker
            };

            try {
                await apiSaveDecision(state.spreadsheetId, decision);
                ref.myDecision = decision;
                ref.status = 'exclude';
                successCount++;
            } catch (err) {
                console.error('Failed to auto-exclude:', ref.ref_id, err);
            }
        }));

        // 進捗コールバック
        if (onProgress) {
            onProgress(Math.min(i + batchSize, totalCount), totalCount);
        }
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
        state.setReferences(refs);

        // 2. ML状態をリセット
        const { createInitialMlState } = await import('../../../lib/ml/types');
        state.setMlState(createInitialMlState());

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
