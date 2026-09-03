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
    SheetsAccessDeniedError,
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
} from '../../lib/sheets-api';
import { setupProjectFolder } from '../../lib/drive-api';
import { platform } from '../../platform';
import { getReviewerKey } from './screening/reviewer-utils';
import { getFilteredReferences } from './screening/filters';
import { initializeAssignmentState, renderAssignmentFilters, renderAssignmentManager, maybeShowAssignmentWizard } from './assignment';
import { initializeFulltextAssignmentSelection } from './fulltext-assignment-ui';
import { initTeamProgress } from './team-progress';
import { getQueuedDecisions } from '../utils/offline-queue';
import { flushUnsentQueue, refreshUnsentBadge } from './unsent-queue';
import { mergeQueuedDecisions } from '../../lib/queued-decisions-merge';
import { buildPickerUrl } from '../../lib/picker-url';

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
    setCurrentFilter as syncSetCurrentFilter,
    setMlState as syncSetMlState,
    setFulltextPoolRule as syncSetFulltextPoolRule,
    setFulltextAssignment as syncSetFulltextAssignment,
} from '../store/compat';
import { getFulltextSetsForUser } from '../../lib/fulltext-assignment';
import { createInitialMlState } from '../../lib/ml/types';
import { maybeShowCriteriaNotice } from './review-criteria';
import { getLastScreeningPosition } from '../../lib/storage';
import { resolveRestoredIndex } from '../../lib/screening-position';

// 外部関数への参照（循環依存回避）
let _renderKeywords: (() => void) | null = null;
let _renderSourceFilters: (() => void) | null = null;
let _renderCurrentReference: (() => void) | null = null;
let _renderKeyStatus: (() => void) | null = null;
let _renderReviewerFilter: (() => void) | null = null;
let _renderAiHighlightToggle: (() => void) | null = null;
let _renderConsensusModeToggle: (() => void) | null = null;

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
    renderConsensusModeToggle: () => void;
}) {
    _renderKeywords = deps.renderKeywords;
    _renderSourceFilters = deps.renderSourceFilters;
    _renderCurrentReference = deps.renderCurrentReference;
    _renderKeyStatus = deps.renderKeyStatus;
    _renderReviewerFilter = deps.renderReviewerFilter;
    _renderAiHighlightToggle = deps.renderAiHighlightToggle;
    _renderConsensusModeToggle = deps.renderConsensusModeToggle;
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

    // プロジェクトを離れるのでバッジを隠す（state.spreadsheetId は既にリセット済み）
    await refreshUnsentBadge();

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

let pickerPollTimer: number | undefined;
let pickerPollFocusHandler: (() => void) | undefined;
// stopPickerPolling() のたびに進めるセッション番号。進行中の非同期チェックが
// 停止後・別シート接続開始後に成功しても、古いシートへ勝手に接続しないようにする
let pickerPollSession = 0;
let pickerPollInFlight = false;

function stopPickerPolling(): void {
    pickerPollSession += 1;
    if (pickerPollTimer !== undefined) {
        window.clearInterval(pickerPollTimer);
        pickerPollTimer = undefined;
    }
    if (pickerPollFocusHandler !== undefined) {
        window.removeEventListener('focus', pickerPollFocusHandler);
        pickerPollFocusHandler = undefined;
    }
}

/** Google Picker 選択後に drive.file の許可が反映されるまで再試行する。 */
function startPickerPolling(spreadsheetId: string): void {
    stopPickerPolling();
    const session = pickerPollSession;
    let attempts = 0;
    let lastError: unknown;

    // 許可確認の実体。interval と focus の両方から呼ばれるため多重実行ガードを持つ。
    // 一時的なネットワークエラー等ではポーリングを中断せず、タイムアウトまで継続する
    const check = async (): Promise<void> => {
        if (pickerPollInFlight) return;
        pickerPollInFlight = true;
        try {
            await getSpreadsheetInfo(spreadsheetId);
        } catch (error) {
            lastError = error;
            return;
        } finally {
            pickerPollInFlight = false;
        }
        if (session !== pickerPollSession) return; // 停止済みの古い許可待ち
        stopPickerPolling();
        await connectToSpreadsheet(spreadsheetId);
    };

    // Pickerタブから戻ってサイドパネルに触れた瞬間に判定できるよう、focus でも即時チェックする
    pickerPollFocusHandler = () => { void check(); };
    window.addEventListener('focus', pickerPollFocusHandler);

    pickerPollTimer = window.setInterval(() => {
        attempts += 1;
        void (async () => {
            await check();
            if (session !== pickerPollSession) return; // 成功または別要因で停止済み
            if (attempts >= 40) {
                stopPickerPolling();
                // タイムアウト後も行き止まりにせず、許可・再試行ボタンを残す
                const message = lastError === undefined || lastError instanceof SheetsAccessDeniedError
                    ? t('picker_accessStillDenied')
                    : t('project_connectError', (lastError as Error).message);
                showPickerAccessGuidance(spreadsheetId, message);
            }
        })();
    }, 3000);
}

function showPickerAccessGuidance(spreadsheetId: string, message = t('picker_accessNeeded')): void {
    stopPickerPolling();
    showStatus(message, 'error');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = t('picker_openBtn');
    openBtn.addEventListener('click', () => {
        platform().openExternal(buildPickerUrl(spreadsheetId, state.userEmail));
        startPickerPolling(spreadsheetId);
    });

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = t('picker_retryBtn');
    retryBtn.addEventListener('click', () => void connectToSpreadsheet(spreadsheetId));

    dom.statusMessage.appendChild(document.createTextNode(' '));
    dom.statusMessage.appendChild(openBtn);
    dom.statusMessage.appendChild(document.createTextNode(' '));
    dom.statusMessage.appendChild(retryBtn);
}

async function connectToSpreadsheet(resolvedId: string): Promise<void> {
    // 別シートの許可待ちポーリングが残っていると、後から成功したときに
    // 作業中のプロジェクトを勝手に切り替えてしまうため、接続開始時点で破棄する。
    stopPickerPolling();

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
        await platform().storageSet({ spreadsheetId: resolvedId });

        // URL 入力で開いたシートは Drive API (drive.file スコープ) の最近一覧に
        // 現れないため、ローカル recent に記録してドロップダウンへ合流させる
        await rememberLocalRecentSheet(resolvedId, info.title);

        // 戻った際に URL 入力欄が残らないよう、ここで明示的にクリアしておく
        dom.spreadsheetInput.value = '';

        // データを読み込んで画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Connection error:', error);
        if (error instanceof SheetsAccessDeniedError) {
            showPickerAccessGuidance(resolvedId);
        } else {
            showStatus(t('project_connectError', (error as Error).message), 'error');
        }
    } finally {
        showLoading(false);
    }
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

    await connectToSpreadsheet(resolvedId);
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
 * 新規プロジェクトのデフォルトタイトルを組み立てる。
 *
 * 全員が同じ既定名（例: "TiAb Review Project"）のままだと、Drive 上でも
 * 最近使用したシート一覧でも見分けが付かないため、
 * 「日付_ログイン中メールの @ より前_既定名」の形にする。
 * 同名の重複（同じ人が同じ日に2つ作る）は prompt 上でユーザーが直せるため許容する。
 */
export function buildDefaultProjectTitle(email: string, now: Date = new Date()): string {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const datePart = `${year}-${month}-${day}`;

    const localPart = (email || '').split('@')[0].trim();
    const base = t('project_createDefault');

    return localPart ? `${datePart}_${localPart}_${base}` : `${datePart}_${base}`;
}

/**
 * 新規プロジェクト作成
 */
export async function handleCreateNew() {
    const title = prompt(t('project_createPrompt'), buildDefaultProjectTitle(state.userEmail));
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
        await platform().storageSet({ spreadsheetId: newId });

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
        syncSetFulltextAssignment(configBundle.fulltextAssignment);
        state.setImportStats(configBundle.importStats);
        state.setReviewCriteria(configBundle.reviewCriteria);
        state.setExcludeReasonConfig(configBundle.excludeReasonConfig);

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
        const fetchedRefs = keyOpenedStatus
            ? await getReferencesWithAllDecisions(spreadsheetId, userEmail)
            : await getReferencesWithStatus(spreadsheetId, userEmail);
        // 未送信キューの判定を重ねる。オフラインキュー退避中はサーバ側（Decisionsタブ）に
        // まだ書き込まれていないため、そのままだと再読み込みのたびに「未評価」に戻って見えてしまう
        // （2026-09 Web版ログイン切れによるキュー滞留の事故対応）
        const queued = await getQueuedDecisions(spreadsheetId, userEmail);
        const refs = mergeQueuedDecisions(fetchedRefs, queued, keyOpenedStatus);
        let visibleRefs = initializeAssignmentState(refs, assignmentConfig, userEmail, adminStatus);

        // フルテキスト担当割り振りで自分に割り当てられた文献は、TiAb の担当セット外でも
        // 読み込む（TiAb 分割とフルテキスト分割は独立のため、担当外グループの文献が
        // フルテキスト担当になり得る）。TiAb 側の表示は担当セットフィルターで除外される。
        const ftConfig = configBundle.fulltextAssignment;
        if (!adminStatus && ftConfig.status === 'configured') {
            const myFtSets = getFulltextSetsForUser(ftConfig, userEmail);
            if (myFtSets.size > 0) {
                const visibleIds = new Set(visibleRefs.map((r) => r.ref_id));
                const extraRefs = refs.filter((r) =>
                    !visibleIds.has(r.ref_id) && myFtSets.has((r.fulltext_set || '').trim())
                );
                if (extraRefs.length > 0) {
                    visibleRefs = [...visibleRefs, ...extraRefs];
                }
            }
        }
        syncSetReferences(visibleRefs);
        // 担当セット別の件数・担当者一覧を全員に同じ数字で見せるため、絞り込み前の全文献も保持する
        state.setAllReferences(refs);

        // チーム進捗: 割り振り前の全文献を分母計算に使う（判定データは非同期取得）
        initTeamProgress(refs);

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
        // 合議モードトグルはキー開封中のみ表示（handleKeyToggle と同じガード）
        if (_renderConsensusModeToggle) _renderConsensusModeToggle();
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
        // フルテキストタブの担当セットフィルタ選択状態（state.fulltextAssignment 設定後に読み込む）
        await initializeFulltextAssignmentSelection(spreadsheetId, userEmail);

        // TiAb 表示位置の復元（Issue #140）。担当セットフィルター等の初期化が終わった後でないと
        // getFilteredReferences() の結果が変わってしまうため、この位置（_renderCurrentReference
        // の直前）で読む。Blind中は復元しない（未判定フィルターでは判定済みが抜けるので実質先頭に
        // 等しく、初回体験を変えないため。復元しないので保存も不要）。
        // 復元に失敗しても画面表示は壊さず、従来どおり index 0 のまま続行する。
        if (keyOpenedStatus) {
            try {
                const saved = await getLastScreeningPosition(spreadsheetId);
                if (saved) {
                    dom.statusFilter.value = saved.filter;
                    syncSetCurrentFilter(saved.filter);
                    const filtered = getFilteredReferences();
                    const restoredIndex = resolveRestoredIndex(filtered.map((r) => r.ref_id), saved);
                    syncSetCurrentIndex(restoredIndex);
                    // 既定の表示（未判定フィルターの先頭）と同じなら、復元したと知らせる意味がないため
                    // トーストは出さない。
                    if (filtered.length > 0 && (saved.filter !== 'pending' || restoredIndex > 0)) {
                        showToast(t('screening_resumedPosition'));
                    }
                }
            } catch (error) {
                console.warn('[loadDataAndShowScreening] 表示位置の復元に失敗:', error);
            }
        }

        if (_renderCurrentReference) _renderCurrentReference();
        void maybeShowAssignmentWizard('load');
        // 基準更新通知（案D）。画面表示は完了しているので await せず、失敗しても画面を壊さない
        maybeShowCriteriaNotice().catch(error =>
            console.error('[loadDataAndShowScreening] maybeShowCriteriaNotice error:', error)
        );

        // 画面表示後にバックグラウンドで未送信分の送信を試みる（表示順序は維持）
        void flushUnsentQueue({ interactive: false });
    } catch (error) {
        console.error('Load data error:', error);
        // 設定画面に戻す（Store経由）
        showProjectView();
        if (error instanceof SheetsAccessDeniedError && spreadsheetId) {
            showPickerAccessGuidance(spreadsheetId);
        } else {
            showStatus(t('project_loadDataError', (error as Error).message), 'error');
        }
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

    const result = await platform().storageGet(['spreadsheetId']);
    // platform().storageGet() は unknown 値を返すため、既存の型（string）にキャストする
    const spreadsheetId = result.spreadsheetId as string | undefined;
    if (!spreadsheetId) {
        dom.recentSheetsSelect.value = '';
        return;
    }

    const hasOption = Array.from(dom.recentSheetsSelect.options)
        .some((opt) => opt.value === spreadsheetId);

    if (hasOption) {
        dom.recentSheetsSelect.value = spreadsheetId;
    } else if (!_recentSheetsLoaded) {
        // 最近一覧の取得に失敗しているときだけ、URL 入力欄にフォールバック表示
        dom.spreadsheetInput.value = spreadsheetId;
    }
}

