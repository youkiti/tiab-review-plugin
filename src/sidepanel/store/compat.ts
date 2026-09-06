/**
 * 互換レイヤー: 既存state.tsとの橋渡し
 * 設定・絞り込み・現在文献・referencesはStoreが所有し、未移行領域のみ双方向同期する。
 */

import { state as legacyState } from '../state';
import { dispatch } from './index';
import type { UserSettings } from '../../lib/user-settings';
import type { AppState } from './types';
import type { ReferenceWithStatus, LlmConfig, AssignmentConfig } from '../../lib/types';
import type { MlState } from '../../lib/ml/types';
import type { HighlightKeywords } from '../../lib/sheets-api';
import type { FulltextPoolRule } from '../../lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../../lib/fulltext-assignment';

/**
 * 既存stateから未移行のAppState領域へ変換する（設定・絞り込み・現在文献・referencesは含めない）。
 */
export function legacyToAppState(): {
    data: Omit<AppState['data'], 'references' | 'sourceFiles' | 'selectedSourceFiles'
        | 'assignmentConfig' | 'assignmentSets' | 'selectedAssignmentSets' | 'selectedFulltextSets'>;
    ui: Omit<AppState['ui'], 'settings' | 'screening'>;
} {
    return {
        data: {
            spreadsheetId: legacyState.spreadsheetId,
            userEmail: legacyState.userEmail,
            highlightKeywords: legacyState.highlightKeywords,
            llmConfig: legacyState.llmConfig,
            mlState: legacyState.mlState,
            recentSheets: [], // 既存stateにはない
            isAdmin: legacyState.isAdmin,
            fulltextPoolRule: legacyState.fulltextPoolRule,
            fulltextAssignment: legacyState.fulltextAssignment,
            availableReviewers: legacyState.availableReviewers,
            enabledReviewers: legacyState.enabledReviewers,
            activeLlmExecutionIds: legacyState.activeLlmExecutionIds,
            currentBatchDecisions: legacyState.currentBatchDecisions,
            failedRefIds: legacyState.failedRefIds,
        },
        ui: {
            view: 'screening', // 既存stateにはviewがないため、デフォルト値
            currentTab: legacyState.currentTab,
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
    legacyState.setSpreadsheetId(appState.data.spreadsheetId);
    legacyState.setUserEmail(appState.data.userEmail);
    legacyState.setHighlightKeywords(appState.data.highlightKeywords);
    legacyState.setLlmConfig(appState.data.llmConfig);
    legacyState.setMlState(appState.data.mlState);
    legacyState.setIsAdmin(appState.data.isAdmin);
    legacyState.setFulltextPoolRule(appState.data.fulltextPoolRule);
    legacyState.setFulltextAssignment(appState.data.fulltextAssignment);
    legacyState.setAvailableReviewers(appState.data.availableReviewers);
    legacyState.setEnabledReviewers(appState.data.enabledReviewers);
    legacyState.setActiveLlmExecutionIds(appState.data.activeLlmExecutionIds);
    legacyState.setCurrentBatchDecisions(appState.data.currentBatchDecisions);
    legacyState.setFailedRefIds(appState.data.failedRefIds);

    // UI層
    legacyState.setCurrentTab(appState.ui.currentTab);
}

// ========== ラッパー関数: 移行済み領域はdispatchのみ ==========

/**
 * References を設定（Storeのみ）
 */
export function setReferences(refs: ReferenceWithStatus[]): void {
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
 * CurrentIndex を設定（Storeのみ）
 */
export function setCurrentIndex(index: number): void {
    dispatch({ type: 'screening/setIndex', index });
}

/**
 * CurrentFilter を設定（Storeのみ）
 */
export function setCurrentFilter(filter: AppState['ui']['screening']['currentFilter']): void {
    dispatch({ type: 'screening/setFilter', filter });
}

/**
 * IsKeyOpened を設定（Storeのみ）
 */
export function setIsKeyOpened(opened: boolean): void {
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
 * ナビゲーション（Storeのみ）
 */
export function navigate(direction: 1 | -1): void {
    dispatch({ type: 'screening/navigate', direction });
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
    dispatch({ type: 'data/setSpreadsheetId', id: appState.data.spreadsheetId });
    dispatch({ type: 'data/setUserEmail', email: appState.data.userEmail });
    dispatch({ type: 'data/setKeywords', keywords: appState.data.highlightKeywords });
    dispatch({ type: 'data/setLlmConfig', config: appState.data.llmConfig });
    dispatch({ type: 'data/setMlState', mlState: appState.data.mlState });
    dispatch({ type: 'data/setIsAdmin', isAdmin: appState.data.isAdmin });
    dispatch({ type: 'data/setAvailableReviewers', reviewers: appState.data.availableReviewers });
    dispatch({ type: 'data/setEnabledReviewers', reviewers: appState.data.enabledReviewers });

    // UI
    dispatch({ type: 'tab/change', tab: appState.ui.currentTab });
}

// ========== Phase 3: 既存モジュール用ブリッジ関数 ==========

/**
 * ログイン画面を表示
 */
export function showLoginView(): void {
    dispatch({ type: 'view/change', view: 'login' });
}

/**
 * プロジェクト選択画面を表示
 */
export function showProjectView(): void {
    dispatch({ type: 'view/change', view: 'project' });
}

/**
 * スクリーニング画面を表示
 */
export function showScreeningView(): void {
    dispatch({ type: 'view/change', view: 'screening' });
}

/**
 * 設定画面を表示/非表示
 */
export function toggleSettingsView(): void {
    dispatch({ type: 'ui/toggleSettings' });
}

/**
 * 設定画面を閉じる
 */
export function closeSettingsView(): void {
    dispatch({ type: 'ui/closeSettings' });
}

/**
 * Admin状態を設定（両方に同期）
 */
export function setIsAdmin(isAdmin: boolean): void {
    legacyState.setIsAdmin(isAdmin);
    dispatch({ type: 'data/setIsAdmin', isAdmin });
}

/**
 * フルテキスト候補ルールを設定（両方に同期）
 */
export function setFulltextPoolRule(rule: FulltextPoolRule | null): void {
    legacyState.setFulltextPoolRule(rule);
    dispatch({ type: 'data/setFulltextPoolRule', rule });
}

/**
 * フルテキスト担当割り振りを設定（両方に同期）
 */
export function setFulltextAssignment(config: FulltextAssignmentConfig): void {
    legacyState.setFulltextAssignment(config);
    dispatch({ type: 'data/setFulltextAssignment', config });
}

/**
 * ソースファイルを設定（Storeのみ）
 */
export function setSourceFiles(files: Set<string>): void {
    dispatch({ type: 'data/setSourceFiles', files });
}

/**
 * 選択中のソースファイルを設定（Storeのみ）
 */
export function setSelectedSourceFiles(files: Set<string>): void {
    dispatch({ type: 'data/setSelectedSourceFiles', files });
}

/**
 * 利用可能なレビュアーを設定（両方に同期）
 */
export function setAvailableReviewers(reviewers: Set<string>): void {
    legacyState.setAvailableReviewers(reviewers);
    dispatch({ type: 'data/setAvailableReviewers', reviewers });
}

/**
 * 有効なレビュアーを設定（両方に同期）
 */
export function setEnabledReviewers(reviewers: Set<string>): void {
    legacyState.setEnabledReviewers(reviewers);
    dispatch({ type: 'data/setEnabledReviewers', reviewers });
}

/**
 * アクティブなLLM実行IDを設定（両方に同期）
 */
export function setActiveLlmExecutionIds(ids: Set<string>): void {
    legacyState.setActiveLlmExecutionIds(ids);
    dispatch({ type: 'data/clearActiveLlmExecutionIds' });
    ids.forEach((id) => {
        dispatch({ type: 'data/addActiveLlmExecutionId', id });
    });
}

/**
 * 検索クエリを設定（Store経由）
 */
export function setSearchQuery(query: string): void {
    dispatch({ type: 'screening/setSearch', query });
}

/**
 * タームフィルターを追加（Storeのみ）
 */
export function addTermFilter(term: string, type: 'include' | 'exclude'): void {
    dispatch({ type: 'screening/addTermFilter', filter: { term, type } });
}

/**
 * タームフィルターを削除（Storeのみ）
 */
export function removeTermFilter(term: string, type: string): void {
    dispatch({ type: 'screening/removeTermFilter', term, termType: type });
}

/**
 * 個人の表示設定を更新（Storeのみ）
 */
export function updateSettings<K extends keyof UserSettings>(key: K, value: UserSettings[K]): void {
    dispatch({ type: 'settings/patch', patch: { [key]: value } });
}

/**
 * 抄録サブセクション見出しリストを更新（Storeのみ）
 */
export function updateAbstractSubsectionHeadings(headings: string[]): void {
    updateSettings('abstractSubsectionHeadings', headings);
}

/**
 * ソースファイルを選択に追加（Storeのみ）
 */
export function addSelectedSourceFile(file: string): void {
    dispatch({ type: 'data/addSelectedSourceFile', file });
}

/**
 * ソースファイルを選択から削除（Storeのみ）
 */
export function removeSelectedSourceFile(file: string): void {
    dispatch({ type: 'data/removeSelectedSourceFile', file });
}

/**
 * ソースファイル自体を削除（Storeのみ）
 */
export function deleteSourceFile(file: string): void {
    dispatch({ type: 'data/deleteSourceFile', file });
}

// ========== 一時UI関連（Phase 4） ==========

/**
 * エクスポートメニューを開閉（Store経由）
 */
export function toggleExportMenu(): void {
    dispatch({ type: 'ui/toggleExportMenu' });
}

/**
 * エクスポートメニューを閉じる（Store経由）
 */
export function closeExportMenu(): void {
    dispatch({ type: 'ui/closeExportMenu' });
}

/**
 * 共有入力欄を開閉（Store経由）
 */
export function toggleShareInput(): void {
    dispatch({ type: 'ui/toggleShareInput' });
}

/**
 * 共有入力欄を閉じる（Store経由）
 */
export function closeShareInput(): void {
    dispatch({ type: 'ui/closeShareInput' });
}

/**
 * すべてのメニューを閉じる（Store経由）
 */
export function closeAllMenus(): void {
    dispatch({ type: 'ui/closeAllMenus' });
}

// 担当セット・ソースファイルの更新（Storeのみ）
export function setAssignmentConfig(config: AssignmentConfig): void {
    dispatch({ type: 'data/setAssignmentConfig', config });
}

export function setAssignmentSets(sets: Set<string>): void {
    dispatch({ type: 'data/setAssignmentSets', sets });
}

export function addAssignmentSet(setId: string): void {
    dispatch({ type: 'data/addAssignmentSet', setId });
}

export function removeAssignmentSet(setId: string): void {
    dispatch({ type: 'data/removeAssignmentSet', setId });
}

export function clearAssignmentSets(): void {
    dispatch({ type: 'data/clearAssignmentSets' });
}

export function setSelectedAssignmentSets(sets: Set<string>): void {
    dispatch({ type: 'data/setSelectedAssignmentSets', sets });
}

export function addSelectedAssignmentSet(setId: string): void {
    dispatch({ type: 'data/addSelectedAssignmentSet', setId });
}

export function removeSelectedAssignmentSet(setId: string): void {
    dispatch({ type: 'data/removeSelectedAssignmentSet', setId });
}

export function clearSelectedAssignmentSets(): void {
    dispatch({ type: 'data/clearSelectedAssignmentSets' });
}

export function setSelectedFulltextSets(sets: Set<string>): void {
    dispatch({ type: 'data/setSelectedFulltextSets', sets });
}

export function addSelectedFulltextSet(setId: string): void {
    dispatch({ type: 'data/addSelectedFulltextSet', setId });
}

export function removeSelectedFulltextSet(setId: string): void {
    dispatch({ type: 'data/removeSelectedFulltextSet', setId });
}

export function clearSelectedFulltextSets(): void {
    dispatch({ type: 'data/clearSelectedFulltextSets' });
}

export function resetAssignmentConfig(): void {
    dispatch({ type: 'data/resetAssignmentConfig' });
}

export function addSourceFile(file: string): void {
    dispatch({ type: 'data/addSourceFile', file });
}

export function clearSourceFiles(): void {
    dispatch({ type: 'data/clearSourceFiles' });
}

export function clearTermFilters(): void {
    dispatch({ type: 'screening/clearTermFilters' });
}
