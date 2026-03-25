/**
 * プロジェクト管理モジュール
 * handleConnect, handleCreateNew, loadRecentSheets, loadConfig, loadDataAndShowScreening, handleBack
 */

import { dom } from '../dom';
import { state } from '../state';
import { showLoading, showStatus, hideStatus, showToast } from '../ui/feedback';
import { t } from '../../lib/i18n';
import {
    getSpreadsheetInfo,
    validateSpreadsheetFormat,
    createSpreadsheet,
    getRecentSpreadsheets,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    getHighlightKeywords,
    getKeyOpenedStatus,
    isUserAdmin,
    forceReauth,
    ensureHeaders,
    getAssignmentConfig,
    saveDecision as apiSaveDecision,
} from '../../lib/sheets-api';
import { getReviewerKey } from './screening/reviewer-utils';
import { initializeAssignmentState, renderAssignmentFilters, renderAssignmentManager, maybeShowAssignmentWizard } from './assignment';
import { flushDecisionQueue } from '../utils/offline-queue';

// Store互換レイヤー（Phase 3）
import {
    showProjectView,
    showScreeningView,
    resetForBack as syncResetForBack,
    setSpreadsheetId as syncSetSpreadsheetId,
    setReferences as syncSetReferences,
    setKeywords as syncSetKeywords,
    setIsKeyOpened as syncSetIsKeyOpened,
    setIsAdmin as syncSetIsAdmin,
    setSourceFiles as syncSetSourceFiles,
    setSelectedSourceFiles as syncSetSelectedSourceFiles,
    setAvailableReviewers as syncSetAvailableReviewers,
    setEnabledReviewers as syncSetEnabledReviewers,
    setCurrentIndex as syncSetCurrentIndex,
    setMlState as syncSetMlState,
} from '../store/compat';
import { createInitialMlState } from '../../lib/ml/types';

// 外部関数への参照（循環依存回避）
let _renderKeywords: (() => void) | null = null;
let _renderSourceFilters: (() => void) | null = null;
let _renderCurrentReference: (() => void) | null = null;
let _renderKeyStatus: (() => void) | null = null;
let _renderReviewerFilter: (() => void) | null = null;

export function setProjectDependencies(deps: {
    renderKeywords: () => void;
    renderSourceFilters: () => void;
    renderCurrentReference: () => void;
    renderKeyStatus: () => void;
    renderReviewerFilter: () => void;
}) {
    _renderKeywords = deps.renderKeywords;
    _renderSourceFilters = deps.renderSourceFilters;
    _renderCurrentReference = deps.renderCurrentReference;
    _renderKeyStatus = deps.renderKeyStatus;
    _renderReviewerFilter = deps.renderReviewerFilter;
}

/**
 * 戻るボタン処理
 */
export function handleBack() {
    // 状態をリセット（Store経由で両方に同期）
    syncResetForBack();

    // プロジェクト選択画面を表示（Store経由でrenderLayoutが自動更新）
    showProjectView();
}

/**
 * スプレッドシートURLまたはIDからIDを抽出
 */
function extractSpreadsheetId(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    // URLパターン: https://docs.google.com/spreadsheets/d/{ID}/...
    const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) {
        return urlMatch[1];
    }

    // IDとして有効かチェック（英数字、ハイフン、アンダースコアのみ）
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed) && trimmed.length > 10) {
        return trimmed;
    }

    return null;
}

/**
 * スプレッドシート接続処理
 */
export async function handleConnect() {
    const manualInput = dom.spreadsheetInput.value.trim();
    const selectedId = dom.recentSheetsSelect.value;
    const resolvedId = manualInput ? extractSpreadsheetId(manualInput) : selectedId;

    if (!resolvedId) {
        showStatus(
            manualInput
                ? t('project_invalidUrl')
                : t('project_selectOrInput'),
            'error'
        );
        return;
    }

    try {
        showLoading(true);
        hideStatus();

        // スプレッドシートの存在確認
        const info = await getSpreadsheetInfo(resolvedId);

        // スプレッドシート形式の検証
        const validation = await validateSpreadsheetFormat(resolvedId);
        if (!validation.valid) {
            showStatus(validation.error || t('project_invalidFormat'), 'error');
            return;
        }

        // ヘッダーの整合性を確認（不足があれば追加）
        await ensureHeaders(resolvedId);

        showStatus(t('project_connectSuccess', info.title), 'success');

        // Store経由で両方に同期
        syncSetSpreadsheetId(resolvedId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId: resolvedId });

        // データを読み込んで画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Connection error:', error);
        showStatus(t('project_connectError', (error as Error).message), 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * 最近使用したスプレッドシートをドロップダウンに読み込み
 */
export async function loadRecentSheets() {
    try {
        dom.recentSheetsSelect.innerHTML = `<option value="">${t('project_loading')}</option>`;

        const sheets = await getRecentSpreadsheets(15);

        dom.recentSheetsSelect.innerHTML = '';

        if (sheets.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('project_noSheets');
            dom.recentSheetsSelect.appendChild(opt);
            return;
        }

        // 空の選択肢
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = t('project_selectSheet');
        dom.recentSheetsSelect.appendChild(emptyOpt);

        for (const sheet of sheets) {
            const opt = document.createElement('option');
            opt.value = sheet.id;
            opt.textContent = sheet.name;
            dom.recentSheetsSelect.appendChild(opt);
        }
    } catch (error) {
        console.error('Failed to load recent sheets:', error);

        dom.recentSheetsSelect.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('project_loadFailed');
        dom.recentSheetsSelect.appendChild(opt);

        // 再認証ボタンを表示
        showStatus(t('project_sheetListFailed'), 'error');

        // 再認証リンクを追加
        const reauthBtn = document.createElement('button');
        reauthBtn.textContent = t('project_reauthBtn');
        reauthBtn.className = 'btn btn-primary';
        reauthBtn.style.marginTop = '12px';
        reauthBtn.style.width = '100%';
        reauthBtn.onclick = async () => {
            try {
                showLoading(true);
                await forceReauth();
                await loadRecentSheets();
                hideStatus();
            } catch (e) {
                showStatus(t('project_reauthFailed'), 'error');
            } finally {
                showLoading(false);
            }
        };
        dom.statusMessage.appendChild(reauthBtn);
    }
}

/**
 * 新規プロジェクト作成
 */
export async function handleCreateNew() {
    const title = prompt(t('project_createPrompt'), t('project_createDefault'));
    if (!title) return;

    try {
        showLoading(true);
        hideStatus();

        const newId = await createSpreadsheet(title);
        showStatus(t('project_createSuccess', title), 'success');

        // Store経由で両方に同期
        syncSetSpreadsheetId(newId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId: newId });

        // 画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Create error:', error);
        showStatus(t('project_createError', (error as Error).message), 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * データを読み込んでスクリーニング画面を表示
 */
export async function loadDataAndShowScreening() {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;

    try {
        showLoading(true);

        // 管理者権限とキーオープン状態を確認
        const [adminStatus, keyOpenedStatus, keywords, assignmentConfig] = await Promise.all([
            isUserAdmin(spreadsheetId, userEmail),
            getKeyOpenedStatus(spreadsheetId),
            getHighlightKeywords(spreadsheetId),
            getAssignmentConfig(spreadsheetId),
        ]);

        // Store経由で両方に同期
        syncSetIsAdmin(adminStatus);
        syncSetIsKeyOpened(keyOpenedStatus);
        syncSetKeywords(keywords);

        // キーオープン状態に応じてデータを読み込み
        const refs = keyOpenedStatus
            ? await getReferencesWithAllDecisions(spreadsheetId, userEmail)
            : await getReferencesWithStatus(spreadsheetId, userEmail);
        const visibleRefs = initializeAssignmentState(refs, assignmentConfig, userEmail, adminStatus);
        syncSetReferences(visibleRefs);

        // MLの状態をリセット（前のプロジェクトのデータをクリア）
        syncSetMlState(createInitialMlState());

        // ソースファイルを抽出
        const sourceFiles = new Set<string>();
        visibleRefs.forEach(ref => {
            if (ref.source_file) sourceFiles.add(ref.source_file);
        });
        syncSetSourceFiles(sourceFiles);
        syncSetSelectedSourceFiles(new Set(sourceFiles));

        // レビュアーを抽出（キーオープン時のみ）
        const reviewers = new Set<string>();
        if (keyOpenedStatus) {
            visibleRefs.forEach(ref => {
                if (ref.allDecisions) {
                    ref.allDecisions.forEach(d => {
                        const reviewerKey = getReviewerKey(d);
                        if (reviewerKey) reviewers.add(reviewerKey);
                    });
                }
            });
            if (userEmail) {
                reviewers.add(userEmail);
            }
        } else {
            reviewers.add(userEmail);
        }
        syncSetAvailableReviewers(reviewers);
        syncSetEnabledReviewers(new Set(reviewers)); // デフォルトは全員有効


        // 管理者の場合、キーオープンボタンを表示
        console.log('[loadDataAndShowScreening] isAdmin =', adminStatus);

        // ユーザー情報に権限を表示
        dom.userInfoDiv.textContent = t('auth_loggedInAsRole', [userEmail, adminStatus ? t('auth_roleAdmin') : t('auth_roleGeneral')]);

        // 注意: キーセクションの表示はrenderLayoutで管理されるようになった
        // ただし、レガシーなrenderKeyStatusとrenderReviewerFilterは既存コードを維持
        if (adminStatus) {
            console.log('[loadDataAndShowScreening] Admin mode');
            if (_renderKeyStatus) _renderKeyStatus();
            if (_renderReviewerFilter) _renderReviewerFilter();
        }
        renderAssignmentManager();

        // スクリーニング画面を表示（Store経由でrenderLayoutが自動更新）
        // ログイン成功時のステータスメッセージを非表示にする
        hideStatus();
        showScreeningView();

        // 表示（Store経由で同期）
        syncSetCurrentIndex(0);
        if (_renderKeywords) _renderKeywords();
        if (_renderSourceFilters) _renderSourceFilters();
        renderAssignmentFilters();
        if (_renderCurrentReference) _renderCurrentReference();
        void maybeShowAssignmentWizard('load');

        try {
            await flushDecisionQueue(spreadsheetId, userEmail, (queued) =>
                apiSaveDecision(spreadsheetId, queued)
            );
        } catch (error) {
            console.error('Queue flush error:', error);
        }
    } catch (error) {
        console.error('Load data error:', error);
        showStatus(t('project_loadDataError', (error as Error).message), 'error');
        // 設定画面に戻す（Store経由）
        showProjectView();
    } finally {
        showLoading(false);
    }
}

/**
 * 保存済み設定を読み込み
 */
export async function loadConfig() {
    const result = await chrome.storage.local.get(['spreadsheetId']);
    if (result.spreadsheetId) {
        const hasOption = Array.from(dom.recentSheetsSelect.options)
            .some((opt) => opt.value === result.spreadsheetId);
        if (hasOption) {
            dom.recentSheetsSelect.value = result.spreadsheetId;
        } else {
            dom.spreadsheetInput.value = result.spreadsheetId;
        }
    }
}

