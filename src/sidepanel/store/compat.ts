/**
 * 互換レイヤー: 既存state.tsとの橋渡し
 * 設定・絞り込み・現在文献・references・spreadsheetId/userEmail/highlightKeywords/isAdmin/
 * fulltextPoolRule/fulltextAssignment/availableReviewers/enabledReviewers/currentTabはStoreが所有し、
 * 双方向同期が残るのはLLM/MLバッチ領域（llmConfig・mlState・activeLlmExecutionIds・
 * currentBatchDecisions・failedRefIds）のみ。
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

// ========== ラッパー関数: 移行済み領域はdispatchのみ ==========

/**
 * References を設定（Storeのみ）
 */
export function setReferences(refs: ReferenceWithStatus[]): void {
    dispatch({ type: 'data/setReferences', refs });
}

/**
 * SpreadsheetId を設定（Storeのみ）
 */
export function setSpreadsheetId(id: string): void {
    dispatch({ type: 'data/setSpreadsheetId', id });
}

/**
 * UserEmail を設定（Storeのみ）
 */
export function setUserEmail(email: string): void {
    dispatch({ type: 'data/setUserEmail', email });
}

/**
 * Keywords を設定（Storeのみ）
 */
export function setKeywords(keywords: HighlightKeywords): void {
    dispatch({ type: 'data/setKeywords', keywords });
}

/**
 * ハイライトキーワード（含める語）を追加（Storeのみ、重複は追加しない）
 */
export function addIncludeKeyword(word: string): void {
    dispatch({ type: 'data/addKeyword', keywordType: 'include', word });
}

/**
 * ハイライトキーワード（含める語）を削除（Storeのみ）
 */
export function removeIncludeKeyword(word: string): void {
    dispatch({ type: 'data/removeKeyword', keywordType: 'include', word });
}

/**
 * ハイライトキーワード（除外する語）を追加（Storeのみ、重複は追加しない）
 */
export function addExcludeKeyword(word: string): void {
    dispatch({ type: 'data/addKeyword', keywordType: 'exclude', word });
}

/**
 * ハイライトキーワード（除外する語）を削除（Storeのみ）
 */
export function removeExcludeKeyword(word: string): void {
    dispatch({ type: 'data/removeKeyword', keywordType: 'exclude', word });
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
 * Tab を変更（Storeのみ）
 */
export function changeTab(tab: AppState['ui']['currentTab']): void {
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
 * Admin状態を設定（Storeのみ）
 */
export function setIsAdmin(isAdmin: boolean): void {
    dispatch({ type: 'data/setIsAdmin', isAdmin });
}

/**
 * フルテキスト候補ルールを設定（Storeのみ）
 */
export function setFulltextPoolRule(rule: FulltextPoolRule | null): void {
    dispatch({ type: 'data/setFulltextPoolRule', rule });
}

/**
 * フルテキスト担当割り振りを設定（Storeのみ）
 */
export function setFulltextAssignment(config: FulltextAssignmentConfig): void {
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
 * 利用可能なレビュアーを設定（Storeのみ）
 */
export function setAvailableReviewers(reviewers: Set<string>): void {
    dispatch({ type: 'data/setAvailableReviewers', reviewers });
}

/**
 * 有効なレビュアーを設定（Storeのみ）
 */
export function setEnabledReviewers(reviewers: Set<string>): void {
    dispatch({ type: 'data/setEnabledReviewers', reviewers });
}

/**
 * レビュアーを有効化（Storeのみ）。混在レビュアー（人手＋ML）のチェックボックス切替では
 * 本体キーと ::ml キーへ同じ enabled 値を独立に適用するため、toggleReviewer ではなく
 * 明示的な追加/削除アクションを使う。
 */
export function addEnabledReviewer(id: string): void {
    dispatch({ type: 'data/addReviewer', reviewerId: id });
}

/**
 * レビュアーを無効化（Storeのみ）
 */
export function removeEnabledReviewer(id: string): void {
    dispatch({ type: 'data/removeReviewer', reviewerId: id });
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
