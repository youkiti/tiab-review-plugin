/**
 * 互換レイヤー: 既存state.tsとの橋渡し
 * 段階的移行のため、両方のstateを同期する
 */

import { state as legacyState } from '../state';
import { getStore, dispatch, getState } from './index';
import type { AppState, Action } from './types';
import type { ReferenceWithStatus, Decision, LlmConfig } from '../../lib/types';
import type { MlState } from '../../lib/ml/types';
import type { HighlightKeywords } from '../../lib/sheets-api';

/**
 * 既存stateからAppStateへ変換
 */
export function legacyToAppState(): AppState {
    return {
        data: {
            references: legacyState.references,
            spreadsheetId: legacyState.spreadsheetId,
            userEmail: legacyState.userEmail,
            highlightKeywords: legacyState.highlightKeywords,
            llmConfig: legacyState.llmConfig,
            mlState: legacyState.mlState,
            recentSheets: [], // 既存stateにはない
            isAdmin: legacyState.isAdmin,
            sourceFiles: legacyState.sourceFiles,
            selectedSourceFiles: legacyState.selectedSourceFiles,
            availableReviewers: legacyState.availableReviewers,
            enabledReviewers: legacyState.enabledReviewers,
            activeLlmExecutionIds: legacyState.activeLlmExecutionIds,
            currentBatchDecisions: legacyState.currentBatchDecisions,
            failedRefIds: legacyState.failedRefIds,
        },
        ui: {
            view: 'screening', // 既存stateにはviewがないため、デフォルト値
            currentTab: legacyState.currentTab,
            screening: {
                currentIndex: legacyState.currentIndex,
                currentFilter: legacyState.currentFilter,
                searchQuery: '', // DOMから取得すべき
                isKeyOpened: legacyState.isKeyOpened,
                activeTermFilters: legacyState.activeTermFilters,
            },
            ml: {
                currentIndex: legacyState.mlState.currentIndex,
                searchQuery: '',
            },
            llm: {
                batchRunning: legacyState.batchAbortController !== null,
                currentExecutionId: legacyState.currentExecutionId,
            },
            flags: {
                loading: false,
                exportMenuOpen: false,
                shareInputOpen: false,
                settingsOpen: false,
            },
            settings: {
                autoNavigateAfterDecision: legacyState.autoNavigateAfterDecision,
                showRecordCountBelow: legacyState.showRecordCountBelow,
                termFilterUseAnd: legacyState.termFilterUseAnd,
                treatMlAsManual: legacyState.treatMlAsManual,
                showAiHighlights: legacyState.showAiHighlights,
                aiDecisionFilter: legacyState.aiDecisionFilter,
            },
            toast: null,
        },
    };
}

/**
 * AppStateから既存stateへ同期
 * 注意: 一部のプロパティは既存stateの構造と異なるため、
 * 互換性のために変換が必要
 */
export function syncToLegacyState(appState: AppState): void {
    // データ層
    legacyState.setReferences(appState.data.references);
    legacyState.setSpreadsheetId(appState.data.spreadsheetId);
    legacyState.setUserEmail(appState.data.userEmail);
    legacyState.setHighlightKeywords(appState.data.highlightKeywords);
    legacyState.setLlmConfig(appState.data.llmConfig);
    legacyState.setMlState(appState.data.mlState);
    legacyState.setIsAdmin(appState.data.isAdmin);
    legacyState.setSourceFiles(appState.data.sourceFiles);
    legacyState.setSelectedSourceFiles(appState.data.selectedSourceFiles);
    legacyState.setAvailableReviewers(appState.data.availableReviewers);
    legacyState.setEnabledReviewers(appState.data.enabledReviewers);
    legacyState.setActiveLlmExecutionIds(appState.data.activeLlmExecutionIds);
    legacyState.setCurrentBatchDecisions(appState.data.currentBatchDecisions);
    legacyState.setFailedRefIds(appState.data.failedRefIds);

    // UI層
    legacyState.setCurrentTab(appState.ui.currentTab);
    legacyState.setCurrentIndex(appState.ui.screening.currentIndex);
    legacyState.setCurrentFilter(appState.ui.screening.currentFilter);
    legacyState.setIsKeyOpened(appState.ui.screening.isKeyOpened);
    legacyState.setActiveTermFilters(appState.ui.screening.activeTermFilters);

    // 設定
    legacyState.setAutoNavigateAfterDecision(appState.ui.settings.autoNavigateAfterDecision);
    legacyState.setShowRecordCountBelow(appState.ui.settings.showRecordCountBelow);
    legacyState.setTermFilterUseAnd(appState.ui.settings.termFilterUseAnd);
    legacyState.setTreatMlAsManual(appState.ui.settings.treatMlAsManual);
    legacyState.setShowAiHighlights(appState.ui.settings.showAiHighlights);
    legacyState.setAiDecisionFilter(appState.ui.settings.aiDecisionFilter);
}

// ========== ラッパー関数: 両方のstateに同期 ==========

/**
 * References を設定（両方に同期）
 */
export function setReferences(refs: ReferenceWithStatus[]): void {
    legacyState.setReferences(refs);
    dispatch({ type: 'data/setReferences', refs });
}

/**
 * SpreadsheetId を設定（両方に同期）
 */
export function setSpreadsheetId(id: string): void {
    legacyState.setSpreadsheetId(id);
    dispatch({ type: 'data/setSpreadsheetId', id });
}

/**
 * UserEmail を設定（両方に同期）
 */
export function setUserEmail(email: string): void {
    legacyState.setUserEmail(email);
    dispatch({ type: 'data/setUserEmail', email });
}

/**
 * Keywords を設定（両方に同期）
 */
export function setKeywords(keywords: HighlightKeywords): void {
    legacyState.setHighlightKeywords(keywords);
    dispatch({ type: 'data/setKeywords', keywords });
}

/**
 * LlmConfig を設定（両方に同期）
 */
export function setLlmConfig(config: LlmConfig): void {
    legacyState.setLlmConfig(config);
    dispatch({ type: 'data/setLlmConfig', config });
}

/**
 * MlState を設定（両方に同期）
 */
export function setMlState(mlState: MlState): void {
    legacyState.setMlState(mlState);
    dispatch({ type: 'data/setMlState', mlState });
}

/**
 * CurrentIndex を設定（両方に同期）
 */
export function setCurrentIndex(index: number): void {
    legacyState.setCurrentIndex(index);
    dispatch({ type: 'screening/setIndex', index });
}

/**
 * CurrentFilter を設定（両方に同期）
 */
export function setCurrentFilter(filter: AppState['ui']['screening']['currentFilter']): void {
    legacyState.setCurrentFilter(filter);
    dispatch({ type: 'screening/setFilter', filter });
}

/**
 * IsKeyOpened を設定（両方に同期）
 */
export function setIsKeyOpened(opened: boolean): void {
    legacyState.setIsKeyOpened(opened);
    dispatch({ type: 'screening/setKeyOpened', opened });
}

/**
 * Loading を設定（両方に同期）
 */
export function setLoading(loading: boolean): void {
    // 既存stateにはloadingがないため、新storeのみ
    dispatch({ type: 'ui/setLoading', loading });
}

/**
 * Toast を表示（両方に同期）
 */
export function showToast(message: string, duration?: number): void {
    dispatch({ type: 'ui/showToast', message, duration });
    // 自動で非表示
    setTimeout(() => {
        dispatch({ type: 'ui/hideToast' });
    }, duration ?? 3000);
}

/**
 * View を変更
 */
export function changeView(view: AppState['ui']['view']): void {
    dispatch({ type: 'view/change', view });
}

/**
 * Tab を変更（両方に同期）
 */
export function changeTab(tab: AppState['ui']['currentTab']): void {
    legacyState.setCurrentTab(tab);
    dispatch({ type: 'tab/change', tab });
}

/**
 * ナビゲーション（両方に同期）
 */
export function navigate(direction: 1 | -1): void {
    // 新storeで計算してから既存stateに同期
    dispatch({ type: 'screening/navigate', direction });
    const newState = getState();
    legacyState.setCurrentIndex(newState.ui.screening.currentIndex);
}

/**
 * リセット（ログアウト時）
 */
export function resetForLogout(): void {
    legacyState.resetForLogout();
    dispatch({ type: 'reset/logout' });
}

/**
 * リセット（戻る時）
 */
export function resetForBack(): void {
    legacyState.resetForBack();
    dispatch({ type: 'reset/back' });
}

// ========== 初期同期 ==========

/**
 * 既存stateの値で新storeを初期化
 */
export function initializeFromLegacy(): void {
    const appState = legacyToAppState();

    // 各値をdispatchで設定
    dispatch({ type: 'data/setReferences', refs: appState.data.references });
    dispatch({ type: 'data/setSpreadsheetId', id: appState.data.spreadsheetId });
    dispatch({ type: 'data/setUserEmail', email: appState.data.userEmail });
    dispatch({ type: 'data/setKeywords', keywords: appState.data.highlightKeywords });
    dispatch({ type: 'data/setLlmConfig', config: appState.data.llmConfig });
    dispatch({ type: 'data/setMlState', mlState: appState.data.mlState });
    dispatch({ type: 'data/setIsAdmin', isAdmin: appState.data.isAdmin });
    dispatch({ type: 'data/setSourceFiles', files: appState.data.sourceFiles });
    dispatch({ type: 'data/setSelectedSourceFiles', files: appState.data.selectedSourceFiles });
    dispatch({ type: 'data/setAvailableReviewers', reviewers: appState.data.availableReviewers });
    dispatch({ type: 'data/setEnabledReviewers', reviewers: appState.data.enabledReviewers });

    // UI
    dispatch({ type: 'tab/change', tab: appState.ui.currentTab });
    dispatch({ type: 'screening/setIndex', index: appState.ui.screening.currentIndex });
    dispatch({ type: 'screening/setFilter', filter: appState.ui.screening.currentFilter });
    dispatch({ type: 'screening/setKeyOpened', opened: appState.ui.screening.isKeyOpened });

    // 設定
    dispatch({ type: 'settings/setAutoNavigate', value: appState.ui.settings.autoNavigateAfterDecision });
    dispatch({ type: 'settings/setShowRecordCountBelow', value: appState.ui.settings.showRecordCountBelow });
    dispatch({ type: 'settings/setTermFilterUseAnd', value: appState.ui.settings.termFilterUseAnd });
    dispatch({ type: 'settings/setTreatMlAsManual', value: appState.ui.settings.treatMlAsManual });
    dispatch({ type: 'settings/setShowAiHighlights', value: appState.ui.settings.showAiHighlights });
    dispatch({ type: 'settings/setAiDecisionFilter', filter: appState.ui.settings.aiDecisionFilter });
}
