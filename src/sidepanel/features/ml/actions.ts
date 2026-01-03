import { state } from '../../state';
import { dom } from '../../dom';

import { mlClient } from '../../../lib/ml/worker-client';
import { saveDecision as apiSaveDecision } from '../../../lib/sheets-api';
import { Decision } from '../../../lib/types';
import { createStoppingRule } from '../../../lib/ml/types';
import { renderMlSection, renderMlStats } from './render';
import { showStoppingSettingsDialog, showStoppingReachedDialog, showInitialStoppingRuleDialog } from './stopping';
import { updateStoppingProgress, isStoppingReached } from '../../../lib/ml/stopping-rules';
import { showToast } from '../../ui/feedback';
import { getMlFilteredRanking, parseMlSearchQuery, resolveMlRanking } from './search';
import { buildMlLabelsFromReferences, initMlWorker } from './operations';
import { enqueueDecision, flushDecisionQueue } from '../../utils/offline-queue';
import { getMlClientVersion } from './version';

// Store互換レイヤー（Phase 5）
import {
    changeTab as syncChangeTab,
    setMlState as syncSetMlState,
} from '../../store/compat';

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
        stoppingSettings: () => document.getElementById('ml-stopping-settings-btn'),
        back: () => document.getElementById('ml-back-btn'),
    }
};

export function initMlHandlers() {
    // Buttons
    elements.buttons.include()?.addEventListener('click', () => handleMlDecision('include'));
    elements.buttons.exclude()?.addEventListener('click', () => handleMlDecision('exclude'));

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

async function saveMlDecisionWithQueue(decision: Decision) {
    try {
        await apiSaveDecision(state.spreadsheetId, decision);
    } catch (err) {
        console.error('Failed to save decision', err);
        await enqueueDecision(state.spreadsheetId, state.userEmail, decision);
        showToast('オフラインのため判定をキューに保存しました');
        return;
    }

    try {
        await flushDecisionQueue(state.spreadsheetId, state.userEmail, (queued) =>
            apiSaveDecision(state.spreadsheetId, queued)
        );
    } catch (err) {
        console.error('Queue flush error:', err);
    }
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
        note: dom.mlNoteInput.value || undefined,
        decided_at: new Date().toISOString(),
        client_version: getMlClientVersion('-ml'),
    };

    ref.myDecision = decisionObj;
    ref.status = decision; // Local update

    // API Save (background)
    saveMlDecisionWithQueue(decisionObj);

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
            case 'arrowleft': // 前へ（MLでは未対応）
            case 'k':
                // MLモードでは「前へ」は未対応
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
