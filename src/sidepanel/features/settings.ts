/**
 * 設定関連モジュール
 * showSettings, hideSettings, ユーザー設定の保存/読み込み
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import { t } from '../../lib/i18n';
import { handleAssignmentResetClick, handleAssignmentReshuffleClick, handleAssignmentSaveMap, renderAssignmentManager } from './assignment';

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
    renderAssignmentManager();
    changeView('settings');
}

/**
 * 設定画面を閉じる
 */
export function hideSettings() {
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

    updateSettings('autoNavigateAfterDecision', result.autoNavigateAfterDecision ?? true);
    updateSettings('showRecordCountBelow', result.showRecordCountBelow ?? true);
    updateSettings('termFilterUseAnd', result.termFilterUseAnd ?? true);
    updateSettings('treatMlAsManual', result.treatMlAsManual ?? true);

    dom.autoNavigateCheckbox.checked = state.autoNavigateAfterDecision;
    dom.showRecordCountCheckbox.checked = state.showRecordCountBelow;
    dom.termFilterAndCheckbox.checked = state.termFilterUseAnd;
    dom.treatMlAsManualCheckbox.checked = state.treatMlAsManual;
    renderAssignmentManager();
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
    updateSettings('showRecordCountBelow', dom.showRecordCountCheckbox.checked);
    console.log('[handleShowRecordCountChange] 設定変更:', state.showRecordCountBelow);
    await saveUserSettings();

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
    updateSettings('termFilterUseAnd', dom.termFilterAndCheckbox.checked);
    console.log('[handleTermFilterAndChange] 設定変更:', state.termFilterUseAnd);
    await saveUserSettings();

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
    updateSettings('treatMlAsManual', dom.treatMlAsManualCheckbox.checked);
    console.log('[handleTreatMlAsManualChange] 設定変更:', state.treatMlAsManual);
    await saveUserSettings();

    if (state.spreadsheetId && _renderCurrentReference) {
        syncSetCurrentIndex(0);
        _renderCurrentReference();
    }

    if (_renderReviewerFilter) {
        _renderReviewerFilter();
    }

    showToast(state.treatMlAsManual
        ? t('settings_treatMlAsManualOn')
        : t('settings_treatMlAsManualOff'));
}

export async function handleAssignmentReset() {
    await handleAssignmentResetClick();
}

export async function handleAssignmentReshuffle() {
    await handleAssignmentReshuffleClick();
}

export async function handleAssignmentSave() {
    await handleAssignmentSaveMap();
}
