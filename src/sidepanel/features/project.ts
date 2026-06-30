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
    getLocalRecentSheets,
    rememberLocalRecentSheet,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    getProjectConfigBundle,
    getLlmExecutions,
    getLlmRuns,
    isUserAdmin,
    forceReauth,
    ensureHeaders,
    getAssignmentConfig,
    saveDecision as apiSaveDecision,
} from '../../lib/sheets-api';
import { setupProjectFolder } from '../../lib/drive-api';
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
    setActiveLlmExecutionIds as syncSetActiveLlmExecutionIds,
    setCurrentIndex as syncSetCurrentIndex,
    setMlState as syncSetMlState,
    setFulltextPoolRule as syncSetFulltextPoolRule,
} from '../store/compat';
import { createInitialMlState } from '../../lib/ml/types';

// 外部関数への参照（循環依存回避）
let _renderKeywords: (() => void) | null = null;
let _renderSourceFilters: (() => void) | null = null;
let _renderCurrentReference: (() => void) | null = null;
let _renderKeyStatus: (() => void) | null = null;
let _renderReviewerFilter: (() => void) | null = null;
let _renderAiHighlightToggle: (() => void) | null = null;

// 最近使用したシート一覧の取得に成功したかどうか。
// loadConfig で URL 入力欄にフォールバック表示するかの判定に使う。
let _recentSheetsLoaded = false;

export function setProjectDependencies(deps: {
    renderKeywords: () => void;
    renderSourceFilters: () => void;
    renderCurrentReference: () => void;
    renderKeyStatus: () => void;
    renderReviewerFilter: () => void;
    renderAiHighlightToggle: () => void;
}) {
    _renderKeywords = deps.renderKeywords;
    _renderSourceFilters = deps.renderSourceFilters;
    _renderCurrentReference = deps.renderCurrentReference;
    _renderKeyStatus = deps.renderKeyStatus;
    _renderReviewerFilter = deps.renderReviewerFilter;
    _renderAiHighlightToggle = deps.renderAiHighlightToggle;
}

/**
 * 戻るボタン処理
 *
 * 初期画面に戻った際は URL 入力欄を空にし、最近使用したシート一覧を再取得して
 * 直前に開いたスプレッドシートがドロップダウンから再選択されるようにする。
 */
export async function handleBack() {
    // 状態をリセット（Store経由で両方に同期）
    syncResetForBack();

    // プロジェクト選択画面を表示（Store経由でrenderLayoutが自動更新）
    showProjectView();

    // 最近一覧を再取得し、保存済み spreadsheetId をドロップダウン側に再選択させる
    // 失敗時のフォールバック表示は loadConfig / loadRecentSheets 内で行う
    await loadRecentSheets();
    await loadConfig();
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

        // URL 入力で開いたシートは Drive API (drive.file スコープ) の最近一覧に
        // 現れないため、ローカル recent に記録してドロップダウンへ合流させる
        await rememberLocalRecentSheet(resolvedId, info.title);

        // 戻った際に URL 入力欄が残らないよう、ここで明示的にクリアしておく
        dom.spreadsheetInput.value = '';

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
 *
 * Drive API の最近一覧 (drive.file スコープでアプリが「触れた」ファイルのみ)
 * と、拡張機能側のローカル recent (URL 貼り付け経由で開いたシートを含む) を
 * マージしてドロップダウンに表示する。
 */
export async function loadRecentSheets() {
    _recentSheetsLoaded = false;
    try {
        dom.recentSheetsSelect.innerHTML = `<option value="">${t('project_loading')}</option>`;

        // Drive API とローカル recent は独立に取得（片方失敗してももう一方は使う）
        const [driveSheets, localSheets] = await Promise.all([
            getRecentSpreadsheets(15),
            getLocalRecentSheets(),
        ]);

        // Drive API の並び順 (recency 降順) を優先し、未収録のローカル recent を末尾に合流
        const merged: { id: string; name: string }[] = [];
        const seen = new Set<string>();
        for (const sheet of driveSheets) {
            if (seen.has(sheet.id)) continue;
            seen.add(sheet.id);
            merged.push({ id: sheet.id, name: sheet.name });
        }
        for (const sheet of localSheets) {
            if (seen.has(sheet.id)) continue;
            seen.add(sheet.id);
            merged.push({ id: sheet.id, name: sheet.name });
        }

        dom.recentSheetsSelect.innerHTML = '';

        if (merged.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('project_noSheets');
            dom.recentSheetsSelect.appendChild(opt);
            _recentSheetsLoaded = true;
            return;
        }

        // 空の選択肢
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = t('project_selectSheet');
        dom.recentSheetsSelect.appendChild(emptyOpt);

        for (const sheet of merged) {
            const opt = document.createElement('option');
            opt.value = sheet.id;
            opt.textContent = sheet.name;
            dom.recentSheetsSelect.appendChild(opt);
        }

        _recentSheetsLoaded = true;
    } catch (error) {
        console.error('Failed to load recent sheets:', error);

        // Drive API 失敗時もローカル recent だけで一覧を構築できないか試す
        let localFallback: { id: string; name: string }[] = [];
        try {
            const localSheets = await getLocalRecentSheets();
            localFallback = localSheets.map((s) => ({ id: s.id, name: s.name }));
        } catch (localError) {
            console.error('Failed to load local recent sheets:', localError);
        }

        dom.recentSheetsSelect.innerHTML = '';

        if (localFallback.length > 0) {
            const emptyOpt = document.createElement('option');
            emptyOpt.value = '';
            emptyOpt.textContent = t('project_selectSheet');
            dom.recentSheetsSelect.appendChild(emptyOpt);
            for (const sheet of localFallback) {
                const opt = document.createElement('option');
                opt.value = sheet.id;
                opt.textContent = sheet.name;
                dom.recentSheetsSelect.appendChild(opt);
            }
            // ローカル分は復元できたが Drive API は失敗しているので _recentSheetsLoaded は
            // false のままにし、loadConfig の URL 入力欄フォールバックを有効に保つ
        } else {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('project_loadFailed');
            dom.recentSheetsSelect.appendChild(opt);
        }

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

        // 新構成: tiab-reviewer-plugin/{プロジェクト名}/ 配下へスプレッドシートを移動。
        // フォルダ整理に失敗してもプロジェクト自体は使えるため、警告に留めて続行する。
        try {
            await setupProjectFolder(newId, title);
        } catch (folderError) {
            console.warn('[handleCreateNew] プロジェクトフォルダの整理に失敗:', folderError);
        }

        showStatus(t('project_createSuccess', title), 'success');

        // Store経由で両方に同期
        syncSetSpreadsheetId(newId);

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId: newId });

        // 新規作成シートはローカル recent にも記録し、戻った直後の一覧反映を保証する
        await rememberLocalRecentSheet(newId, title);

        // 戻った際に URL 入力欄が残らないよう明示的にクリア
        dom.spreadsheetInput.value = '';

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
        state.clearReviewHistory();

        // 管理者権限とキーオープン状態を確認
        // Run/Batch 分離後、active 判定は LLM_Runs を経由するため Runs も同時取得する
        // Config 由来の共有設定（キー開封・キーワード・フルテキスト候補ルール）は
        // 1リクエストにまとめて取得する（429対策）
        const [adminStatus, configBundle, assignmentConfig, llmExecutions, llmRuns] = await Promise.all([
            isUserAdmin(spreadsheetId, userEmail),
            getProjectConfigBundle(spreadsheetId),
            getAssignmentConfig(spreadsheetId),
            getLlmExecutions(spreadsheetId),
            getLlmRuns(spreadsheetId),
        ]);
        const keyOpenedStatus = configBundle.keyOpened;

        // Store経由で両方に同期
        syncSetIsAdmin(adminStatus);
        syncSetIsKeyOpened(keyOpenedStatus);
        syncSetKeywords(configBundle.keywords);
        syncSetFulltextPoolRule(configBundle.fulltextPoolRule);

        // active な Run 配下の全 Batch IDs を「LLM 判定として有効」としてキャッシュ
        const activeRun = llmRuns
            .filter(r => r.is_active && r.status === 'confirmed')
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
        const activeBatchIds = activeRun
            ? new Set(
                llmExecutions
                    .filter(e => e.execution_type === 'batch_screening' && e.run_id === activeRun.run_id)
                    .map(e => e.execution_id)
              )
            : new Set<string>();
        syncSetActiveLlmExecutionIds(activeBatchIds);

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
        // AIハイライトトグルは全ユーザーに表示（確定AI判定があれば表示される）
        if (_renderAiHighlightToggle) _renderAiHighlightToggle();
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
 *
 * 復元順序:
 * 1. 最近使用したシート一覧にあればドロップダウンで選択
 * 2. 一覧の取得に失敗している場合のみ、レアケース救済として URL 入力欄に表示
 *    （成功取得時はドロップダウンを優先し、URL 入力欄は「手で入れる場所」として空のままにする）
 */
export async function loadConfig() {
    // 既存の値をクリアして毎回まっさらな状態から復元する
    dom.spreadsheetInput.value = '';

    const result = await chrome.storage.local.get(['spreadsheetId']);
    if (!result.spreadsheetId) {
        dom.recentSheetsSelect.value = '';
        return;
    }

    const hasOption = Array.from(dom.recentSheetsSelect.options)
        .some((opt) => opt.value === result.spreadsheetId);

    if (hasOption) {
        dom.recentSheetsSelect.value = result.spreadsheetId;
    } else if (!_recentSheetsLoaded) {
        // 最近一覧の取得に失敗しているときだけ、URL 入力欄にフォールバック表示
        dom.spreadsheetInput.value = result.spreadsheetId;
    }
}

