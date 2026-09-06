/**
 * 設定関連モジュール
 * showSettings, hideSettings, ユーザー設定の保存/読み込み
 */

import { dom } from '../dom';
import { state } from '../state';
import { dispatch, getState } from '../store';
import {
    DEFAULT_ABSTRACT_SUBSECTION_HEADINGS,
    USER_SETTINGS_STORAGE_KEYS,
    parseUserSettings,
    toUserSettingsStorageRecord,
} from '../../lib/user-settings';
import { showToast } from '../ui/feedback';
import { t } from '../../lib/i18n';
import { handleAssignmentResetClick, handleAssignmentReshuffleClick, handleAssignmentSaveMap, renderAssignmentManager } from './assignment';
import { platform } from '../../platform';
import { perfSpanSync } from '../../lib/perf';

// Store互換レイヤー（Phase 3）
import {
    changeView,
    updateSettings,
    updateAbstractSubsectionHeadings,
    setCurrentIndex as syncSetCurrentIndex,
} from '../store/compat';

export { DEFAULT_ABSTRACT_SUBSECTION_HEADINGS } from '../../lib/user-settings';

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
    // Issue #151（#150 工程0）: tiab:settings.show として計測。
    return perfSpanSync('tiab:settings.show', () => {
        renderAssignmentManager();
        changeView('settings');
    });
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
    const record = toUserSettingsStorageRecord(getState().ui.settings);
    console.log('[saveUserSettings] 保存:', record);
    await platform().storageSet(record);
}

/**
 * ユーザー設定を読み込み
 */
export async function loadUserSettings() {
    const result = await platform().storageGet(USER_SETTINGS_STORAGE_KEYS);
    const settings = parseUserSettings(result);
    // 保存対象だけを一括反映し、読み込み直してもセッション内のAI表示状態は保持する。
    dispatch({ type: 'settings/patch', patch: Object.fromEntries(
        USER_SETTINGS_STORAGE_KEYS.map(key => [key, settings[key]])
    ) });

    dom.autoNavigateCheckbox.checked = state.autoNavigateAfterDecision;
    dom.showRecordCountCheckbox.checked = state.showRecordCountBelow;
    dom.termFilterAndCheckbox.checked = state.termFilterUseAnd;
    dom.treatMlAsManualCheckbox.checked = state.treatMlAsManual;
    dom.abstractSubsectionBreakCheckbox.checked = state.abstractSubsectionBreakEnabled;
    dom.abstractSubsectionHeadingsTextarea.value = state.abstractSubsectionHeadings.join('\n');
    renderAssignmentManager();
    console.log('[loadUserSettings] 設定完了:', {
        autoNavigateAfterDecision: state.autoNavigateAfterDecision,
        showRecordCountBelow: state.showRecordCountBelow,
        termFilterUseAnd: state.termFilterUseAnd,
        treatMlAsManual: state.treatMlAsManual,
        abstractSubsectionBreakEnabled: state.abstractSubsectionBreakEnabled,
        abstractSubsectionHeadings: state.abstractSubsectionHeadings,
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

/**
 * 抄録サブセクション改行のON/OFF切替を処理
 */
export async function handleAbstractSubsectionBreakChange() {
    updateSettings('abstractSubsectionBreakEnabled', dom.abstractSubsectionBreakCheckbox.checked);
    console.log('[handleAbstractSubsectionBreakChange] 設定変更:', state.abstractSubsectionBreakEnabled);
    await saveUserSettings();

    if (state.spreadsheetId && _renderCurrentReference) {
        _renderCurrentReference();
    }

    showToast(state.abstractSubsectionBreakEnabled
        ? t('settings_abstractSubsectionBreakOn')
        : t('settings_abstractSubsectionBreakOff'));
}

/**
 * 抄録サブセクション見出しリストの編集を処理
 */
export async function handleAbstractSubsectionHeadingsChange() {
    const headings = dom.abstractSubsectionHeadingsTextarea.value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

    updateAbstractSubsectionHeadings(headings);
    console.log('[handleAbstractSubsectionHeadingsChange] 件数:', headings.length);
    await saveUserSettings();

    if (state.spreadsheetId && state.abstractSubsectionBreakEnabled && _renderCurrentReference) {
        _renderCurrentReference();
    }
}

/**
 * 抄録サブセクション見出しをデフォルトに戻す
 */
export async function handleAbstractSubsectionHeadingsReset() {
    updateAbstractSubsectionHeadings([...DEFAULT_ABSTRACT_SUBSECTION_HEADINGS]);
    dom.abstractSubsectionHeadingsTextarea.value = state.abstractSubsectionHeadings.join('\n');
    await saveUserSettings();

    if (state.spreadsheetId && state.abstractSubsectionBreakEnabled && _renderCurrentReference) {
        _renderCurrentReference();
    }

    showToast(t('settings_abstractSubsectionHeadingsResetDone'));
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
