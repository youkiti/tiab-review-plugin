/**
 * 設定関連モジュール
 * showSettings, hideSettings, ユーザー設定の保存/読み込み
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import { t } from '../../lib/i18n';

// Store互換レイヤー（Phase 3）
import {
    changeView,
    updateSettings,
    setCurrentIndex as syncSetCurrentIndex,
} from '../store/compat';

// 外部関数への参照（循環依存回避）
let _renderCurrentReference: (() => void) | null = null;
let _renderReviewerFilter: (() => void) | null = null;

export function setSettingsDependencies(deps: {
    renderCurrentReference: () => void;
    renderReviewerFilter?: () => void;
}) {
    _renderCurrentReference = deps.renderCurrentReference;
    _renderReviewerFilter = deps.renderReviewerFilter || null;
}

/**
 * 設定画面を表示
 */
export function showSettings() {
    // Store経由でview変更（renderLayoutで反映される）
    changeView('settings');
}

/**
 * 設定画面を閉じる
 */
export function hideSettings() {
    // Store経由でview変更（renderLayoutで反映される）
    // スクリーニングビューに戻る（タブ状態は保持される）
    if (state.spreadsheetId) {
        changeView('screening');
    } else {
        changeView('project');
    }
}

/**
 * 自動遷移設定の変更を処理
 */
export async function handleAutoNavigateChange() {
    // Store経由で両方に同期
    updateSettings('autoNavigateAfterDecision', dom.autoNavigateCheckbox.checked);
    console.log('[handleAutoNavigateChange] 設定変更:', state.autoNavigateAfterDecision);
    await saveUserSettings();
    showToast(state.autoNavigateAfterDecision
        ? t('settings_autoNavigateOn')
        : t('settings_autoNavigateOff'));
}

/**
 * ユーザー設定を保存
 */
export async function saveUserSettings() {
    console.log('[saveUserSettings] 保存:', {
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd,
        treatMlAsManual: state.treatMlAsManual
    });
    await chrome.storage.local.set({
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd,
        treatMlAsManual: state.treatMlAsManual
    });
}

/**
 * ユーザー設定を読み込み
 */
export async function loadUserSettings() {
    const result = await chrome.storage.local.get(['autoNavigateAfterDecision', 'showRecordCountBelow', 'termFilterUseAnd', 'treatMlAsManual']);
    console.log('[loadUserSettings] 読み込み:', result);

    // デフォルトはtrue（自動遷移する）- Store経由で両方に同期
    updateSettings('autoNavigateAfterDecision', result.autoNavigateAfterDecision ?? true);

    // デフォルトはtrue（タイトル下に表示）- Store経由で両方に同期
    updateSettings('showRecordCountBelow', result.showRecordCountBelow ?? true);

    // デフォルトはtrue（AND検索）- Store経由で両方に同期
    updateSettings('termFilterUseAnd', result.termFilterUseAnd ?? true);

    // デフォルトはtrue（ML判定を手動判定と同一視）- Store経由で両方に同期
    updateSettings('treatMlAsManual', result.treatMlAsManual ?? true);

    // チェックボックスの状態を更新
    dom.autoNavigateCheckbox.checked = state.autoNavigateAfterDecision;
    dom.showRecordCountCheckbox.checked = state.showRecordCountBelow;
    dom.termFilterAndCheckbox.checked = state.termFilterUseAnd;
    dom.treatMlAsManualCheckbox.checked = state.treatMlAsManual;
    console.log('[loadUserSettings] 設定完了:', {
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd,
        treatMlAsManual: state.treatMlAsManual
    });
}

/**
 * レコード件数表示設定の変更を処理
 */
export async function handleShowRecordCountChange() {
    // Store経由で両方に同期
    updateSettings('showRecordCountBelow', dom.showRecordCountCheckbox.checked);
    console.log('[handleShowRecordCountChange] 設定変更:', state.showRecordCountBelow);
    await saveUserSettings();

    // 表示を即時更新
    if (state.spreadsheetId && _renderCurrentReference) {
        _renderCurrentReference();
    }

    showToast(state.showRecordCountBelow
        ? t('settings_showRecordCountBelow')
        : t('settings_showRecordCountAbove'));
}

/**
 * ターム検索AND/OR設定の変更を処理
 */
export async function handleTermFilterAndChange() {
    // Store経由で両方に同期
    updateSettings('termFilterUseAnd', dom.termFilterAndCheckbox.checked);
    console.log('[handleTermFilterAndChange] 設定変更:', state.termFilterUseAnd);
    await saveUserSettings();

    // フィルターが適用中なら即時反映（Store経由でインデックスリセット）
    if (state.spreadsheetId && state.activeTermFilters.length > 0 && _renderCurrentReference) {
        syncSetCurrentIndex(0);
        _renderCurrentReference();
    }

    showToast(state.termFilterUseAnd
        ? t('settings_termFilterAndOn')
        : t('settings_termFilterAndOff'));
}

/**
 * ML判定と手動判定の同一視設定の変更を処理
 */
export async function handleTreatMlAsManualChange() {
    // Store経由で両方に同期
    updateSettings('treatMlAsManual', dom.treatMlAsManualCheckbox.checked);
    console.log('[handleTreatMlAsManualChange] 設定変更:', state.treatMlAsManual);
    await saveUserSettings();

    // 表示を即時更新（Store経由でインデックスリセット）
    if (state.spreadsheetId && _renderCurrentReference) {
        syncSetCurrentIndex(0);
        _renderCurrentReference();
    }

    // レビュアーフィルターも更新
    if (_renderReviewerFilter) {
        _renderReviewerFilter();
    }

    showToast(state.treatMlAsManual
        ? t('settings_treatMlAsManualOn')
        : t('settings_treatMlAsManualOff'));
}
