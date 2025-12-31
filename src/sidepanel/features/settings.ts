/**
 * 設定関連モジュール
 * showSettings, hideSettings, ユーザー設定の保存/読み込み
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';

// 外部関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;

export function setSettingsDependencies(deps: {
    renderCurrentReference: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
}

/**
 * 設定画面を表示
 */
export function showSettings() {
    dom.configSection.classList.add('hidden');
    dom.screeningSection.classList.add('hidden');
    dom.llmSection?.classList.add('hidden');
    dom.settingsSection.classList.remove('hidden');
}

/**
 * 設定画面を閉じる
 */
export function hideSettings() {
    dom.settingsSection.classList.add('hidden');

    // 前に表示していた画面に戻る
    if (state.spreadsheetId) {
        // 現在のタブに応じて適切なセクションを表示
        if (state.currentTab === 'llm') {
            dom.llmSection?.classList.remove('hidden');
        } else {
            dom.screeningSection.classList.remove('hidden');
        }
    } else {
        dom.configSection.classList.remove('hidden');
    }
}

/**
 * 自動遷移設定の変更を処理
 */
export async function handleAutoNavigateChange() {
    state.setAutoNavigateAfterDecision(dom.autoNavigateCheckbox.checked);
    console.log('[handleAutoNavigateChange] 設定変更:', state.autoNavigateAfterDecision);
    await saveUserSettings();
    showToast(state.autoNavigateAfterDecision
        ? '判断後に自動的に次の文献に遷移します'
        : '判断後は手動で遷移してください');
}

/**
 * ユーザー設定を保存
 */
export async function saveUserSettings() {
    console.log('[saveUserSettings] 保存:', {
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd
    });
    await chrome.storage.local.set({
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd
    });
}

/**
 * ユーザー設定を読み込み
 */
export async function loadUserSettings() {
    const result = await chrome.storage.local.get(['autoNavigateAfterDecision', 'showRecordCountBelow', 'termFilterUseAnd']);
    console.log('[loadUserSettings] 読み込み:', result);

    // デフォルトはtrue（自動遷移する）
    if (result.autoNavigateAfterDecision !== undefined) {
        state.setAutoNavigateAfterDecision(result.autoNavigateAfterDecision);
    } else {
        state.setAutoNavigateAfterDecision(true);
    }

    // デフォルトはtrue（タイトル下に表示）
    if (result.showRecordCountBelow !== undefined) {
        state.setShowRecordCountBelow(result.showRecordCountBelow);
    } else {
        state.setShowRecordCountBelow(true);
    }

    // デフォルトはtrue（AND検索）
    if (result.termFilterUseAnd !== undefined) {
        state.setTermFilterUseAnd(result.termFilterUseAnd);
    } else {
        state.setTermFilterUseAnd(true);
    }

    // チェックボックスの状態を更新
    dom.autoNavigateCheckbox.checked = state.autoNavigateAfterDecision;
    dom.showRecordCountCheckbox.checked = state.showRecordCountBelow;
    dom.termFilterAndCheckbox.checked = state.termFilterUseAnd;
    console.log('[loadUserSettings] 設定完了:', {
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd
    });
}

/**
 * レコード件数表示設定の変更を処理
 */
export async function handleShowRecordCountChange() {
    state.setShowRecordCountBelow(dom.showRecordCountCheckbox.checked);
    console.log('[handleShowRecordCountChange] 設定変更:', state.showRecordCountBelow);
    await saveUserSettings();

    // 表示を即時更新
    if (state.spreadsheetId && _renderCurrentReference) {
        _renderCurrentReference();
    }

    showToast(state.showRecordCountBelow
        ? 'レコード件数をタイトル下に表示します'
        : 'レコード件数をタイトル上に移動しました');
}

/**
 * ターム検索AND/OR設定の変更を処理
 */
export async function handleTermFilterAndChange() {
    state.setTermFilterUseAnd(dom.termFilterAndCheckbox.checked);
    console.log('[handleTermFilterAndChange] 設定変更:', state.termFilterUseAnd);
    await saveUserSettings();

    // フィルターが適用中なら即時反映
    if (state.spreadsheetId && state.activeTermFilters.length > 0 && _renderCurrentReference) {
        state.setCurrentIndex(0);
        _renderCurrentReference();
    }

    showToast(state.termFilterUseAnd
        ? '複数キーワード選択時: AND検索'
        : '複数キーワード選択時: OR検索');
}
