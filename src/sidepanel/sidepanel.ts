// Sidepanel スクリプト

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus } from '../lib/types';
import {
    getAuthToken,
    getUserEmail,
    createSpreadsheet,
    getSpreadsheetInfo,
    getReferences,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    saveDecision as apiSaveDecision,
    addReferences,
    getRecentSpreadsheets,
    forceReauth,
    getHighlightKeywords,
    updateConfigKeywords,
    isUserAdmin,
    getKeyOpenedStatus,
    setKeyOpenedStatus,
    type HighlightKeywords,
    PRESET_RCT,
    PRESET_SR,
    addPermission,
    getSpreadsheetPermissions,
} from '../lib/sheets-api';

import { parseRISFile } from '../lib/ris-parser';

// 状態管理
let references: ReferenceWithStatus[] = [];
let currentIndex = 0;
let currentFilter: DecisionStatus | 'all' = 'pending';
let spreadsheetId = '';
let userEmail = '';
// ラベル関連の状態変数は削除
let highlightKeywords: HighlightKeywords = { include: [], exclude: [] };  // ハイライトキーワード
let isKeyOpened = false;  // キーオープン状態
let isAdmin = false;      // 管理者権限
let sourceFiles: Set<string> = new Set();
let selectedSourceFiles: Set<string> = new Set();

// DOM要素
const sourceFileListDiv = document.getElementById('source-file-list') as HTMLElement;
const sourceFiltersSection = document.getElementById('source-filters-section') as HTMLElement;

function renderSourceFilters() {
    sourceFileListDiv.innerHTML = '';

    if (sourceFiles.size === 0) {
        sourceFiltersSection.classList.add('hidden');
        return;
    }
    sourceFiltersSection.classList.remove('hidden');

    sourceFiles.forEach(file => {
        // このファイルのレコード数をカウント
        const count = references.filter(r => r.source_file === file).length;

        const div = document.createElement('div');
        div.className = 'source-file-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `source-${file}`;
        checkbox.checked = selectedSourceFiles.has(file);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedSourceFiles.add(file);
            } else {
                selectedSourceFiles.delete(file);
            }
            // フィルター適用
            currentIndex = 0;
            renderCurrentReference();
        });

        const label = document.createElement('label');
        label.htmlFor = `source-${file}`;
        label.textContent = `${file} (${count})`;

        div.appendChild(checkbox);
        div.appendChild(label);
        sourceFileListDiv.appendChild(div);
    });
}



// DOM要素
const configSection = document.getElementById('config-section') as HTMLElement;
const screeningSection = document.getElementById('screening-section') as HTMLElement;
const recentSheetsSelect = document.getElementById('recent-sheets') as HTMLSelectElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const createBtn = document.getElementById('create-btn') as HTMLButtonElement;
const userInfoDiv = document.getElementById('user-info') as HTMLElement;
const statusMessage = document.getElementById('status-message') as HTMLElement;
const loadingDiv = document.getElementById('loading') as HTMLElement;

const statusFilter = document.getElementById('status-filter') as HTMLSelectElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResultCount = document.getElementById('search-result-count') as HTMLElement;

const refTitle = document.getElementById('ref-title') as HTMLElement;
const refAuthors = document.getElementById('ref-authors') as HTMLElement;
const refYear = document.getElementById('ref-year') as HTMLElement;
const refJournal = document.getElementById('ref-journal') as HTMLElement;
const refAbstract = document.getElementById('ref-abstract') as HTMLElement;
const refDoi = document.getElementById('ref-doi') as HTMLAnchorElement;
const refPmid = document.getElementById('ref-pmid') as HTMLAnchorElement;

const btnInclude = document.getElementById('btn-include') as HTMLButtonElement;
const btnMaybe = document.getElementById('btn-maybe') as HTMLButtonElement;
const btnExclude = document.getElementById('btn-exclude') as HTMLButtonElement;
const noteInput = document.getElementById('note') as HTMLTextAreaElement;

const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const navPosition = document.getElementById('nav-position') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;

// RIS インポート
const risFileInput = document.getElementById('ris-file') as HTMLInputElement;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const importStatus = document.getElementById('import-status') as HTMLElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;

// キーオープン関連
const keySection = document.getElementById('key-section') as HTMLElement;
const keyToggleInput = document.getElementById('key-toggle-input') as HTMLInputElement;
const conflictBanner = document.getElementById('conflict-banner') as HTMLElement;
const allDecisionsDiv = document.getElementById('all-decisions') as HTMLElement;

// ハイライト設定関連
const presetRctBtn = document.getElementById('preset-rct-btn') as HTMLButtonElement;
const presetSrBtn = document.getElementById('preset-sr-btn') as HTMLButtonElement;

const includeKeywordsListDiv = document.getElementById('include-keywords-list') as HTMLElement;
const newIncludeInput = document.getElementById('new-include-input') as HTMLInputElement;
const addIncludeBtn = document.getElementById('add-include-btn') as HTMLButtonElement;

const excludeKeywordsListDiv = document.getElementById('exclude-keywords-list') as HTMLElement;
const newExcludeInput = document.getElementById('new-exclude-input') as HTMLInputElement;
const addExcludeBtn = document.getElementById('add-exclude-btn') as HTMLButtonElement;

const saveStatus = document.getElementById('save-status') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

// 共有設定関連
const shareBtn = document.getElementById('share-btn') as HTMLButtonElement;
const shareInputArea = document.getElementById('share-input-area') as HTMLElement;
const shareEmailInput = document.getElementById('share-email-input') as HTMLInputElement;
const shareSubmitBtn = document.getElementById('share-submit-btn') as HTMLButtonElement;
const shareCancelBtn = document.getElementById('share-cancel-btn') as HTMLButtonElement;
const sharedUsersList = document.getElementById('shared-users-list') as HTMLElement;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initApp();
});

// ログイン/プロジェクトセクション
const loginSection = document.getElementById('login-section') as HTMLElement;
const projectSection = document.getElementById('project-section') as HTMLElement;
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;

async function initApp() {
    try {
        showLoading(true);

        // サイレント認証を試行
        try {
            await getAuthToken();
            // 成功したらプロジェクト選択画面へ
            await showProjectSection();
        } catch {
            // 失敗したらログインボタン表示のまま
            showLoading(false);
        }
    } catch (error) {
        console.error('Init error:', error);
        showLoading(false);
    }
}

async function handleLogin() {
    try {
        showLoading(true);
        await getAuthToken();
        await showProjectSection();
    } catch (error) {
        console.error('Login error:', error);
        showStatus('ログインに失敗しました。もう一度お試しください。', 'error');
    } finally {
        showLoading(false);
    }
}

async function handleLogout() {
    if (!confirm('ログアウトしますか？')) {
        return;
    }

    try {
        showLoading(true);

        // Chrome storage をクリア
        await chrome.storage.local.clear();

        // 認証トークンをクリア
        const token = await getAuthToken();
        await new Promise<void>((resolve) => {
            chrome.identity.removeCachedAuthToken({ token }, () => {
                chrome.identity.clearAllCachedAuthTokens(() => {
                    resolve();
                });
            });
        });

        // 状態をリセット
        spreadsheetId = '';
        userEmail = '';
        references = [];
        isKeyOpened = false;
        isAdmin = false;

        // ログイン画面に戻る
        projectSection.classList.add('hidden');
        screeningSection.classList.add('hidden');
        loginSection.classList.remove('hidden');

        showToast('ログアウトしました');
    } catch (error) {
        console.error('Logout error:', error);
        alert(`ログアウトエラー: ${(error as Error).message}`);
    } finally {
        showLoading(false);
    }
}

async function showProjectSection() {
    console.log('[showProjectSection] Starting...');

    // ログインセクションを隠してプロジェクトセクションを表示
    loginSection.classList.add('hidden');
    projectSection.classList.remove('hidden');
    console.log('[showProjectSection] Sections toggled');

    // ユーザー情報を取得
    try {
        userEmail = await getUserEmail();
        console.log('[showProjectSection] Got user email:', userEmail);
    } catch (e) {
        console.error('[showProjectSection] Failed to get user email:', e);
        userEmail = '';
        projectSection.classList.add('hidden');
        loginSection.classList.remove('hidden');
        showStatus('Googleアカウントにログインしてください', 'error');
        showLoading(false);
        return;
    }
    userInfoDiv.textContent = `ログイン中: ${userEmail}`;

    // 最近使用したスプレッドシートを読み込み
    console.log('[showProjectSection] Loading recent sheets...');
    await loadRecentSheets();
    console.log('[showProjectSection] Recent sheets loaded');

    // 保存済み設定を読み込み
    await loadConfig();
    console.log('[showProjectSection] Config loaded');

    showLoading(false);
}

function setupEventListeners() {
    // ログイン
    loginBtn.addEventListener('click', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);

    // 接続
    connectBtn.addEventListener('click', handleConnect);
    createBtn.addEventListener('click', handleCreateNew);

    // フィルター
    statusFilter.addEventListener('change', () => {
        currentFilter = statusFilter.value as DecisionStatus | 'all';
        currentIndex = 0;
        renderCurrentReference();
    });

    searchInput.addEventListener('input', () => {
        currentIndex = 0;
        renderCurrentReference();
    });

    // RIS インポート
    importBtn.addEventListener('click', () => risFileInput.click());
    risFileInput.addEventListener('change', handleRISImport);

    // CSV エクスポート
    exportCsvBtn.addEventListener('click', handleExportCSV);

    // 戻るボタン
    backBtn.addEventListener('click', handleBack);

    // 判定ボタン
    btnInclude.addEventListener('click', () => handleDecision('include'));
    btnMaybe.addEventListener('click', () => handleDecision('maybe'));
    btnExclude.addEventListener('click', () => handleDecision('exclude'));

    // ナビゲーション
    btnPrev.addEventListener('click', () => navigate(-1));
    btnNext.addEventListener('click', () => navigate(1));

    // キーボードショートカット
    document.addEventListener('keydown', handleKeydown);

    // ハイライトキーワード関連
    addIncludeBtn.addEventListener('click', () => addKeyword('include'));
    newIncludeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addKeyword('include');
    });

    addExcludeBtn.addEventListener('click', () => addKeyword('exclude'));
    newExcludeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addKeyword('exclude');
    });

    // プリセットボタン
    presetRctBtn.addEventListener('click', () => applyPreset('RCT'));
    presetSrBtn.addEventListener('click', () => applyPreset('SR'));

    // キー状態切替ボタン
    keyToggleInput.addEventListener('change', handleKeyToggle);

    // 共有ボタン
    shareBtn.addEventListener('click', () => {
        shareInputArea.classList.toggle('hidden');
        if (!shareInputArea.classList.contains('hidden')) {
            shareEmailInput.focus();
            loadSharedUsers();
        }
    });

    shareCancelBtn.addEventListener('click', () => {
        shareInputArea.classList.add('hidden');
        shareEmailInput.value = '';
    });

    shareSubmitBtn.addEventListener('click', handleShare);
    shareEmailInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleShare();
    });
}

function handleKeydown(e: KeyboardEvent) {
    // 入力中は無視
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
    }

    switch (e.key.toLowerCase()) {
        case 'i':
            handleDecision('include');
            break;
        case 'm':
            handleDecision('maybe');
            break;
        case 'e':
            handleDecision('exclude');
            break;
        case 'n':
        case 'arrowright':
            navigate(1);
            break;
        case 'p':
        case 'arrowleft':
            navigate(-1);
            break;
    }
}

function showLoading(show: boolean) {
    if (show) {
        loadingDiv.classList.remove('hidden');
        connectBtn.disabled = true;
        createBtn.disabled = true;
    } else {
        loadingDiv.classList.add('hidden');
        connectBtn.disabled = false;
        createBtn.disabled = false;
    }
}

function showStatus(message: string, type: 'success' | 'error' | 'info' = 'info') {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    statusMessage.classList.remove('hidden');
}

function hideStatus() {
    statusMessage.classList.add('hidden');
}

/**
 * スプレッドシートURLまたはIDからIDを抽出
 * @param input URL または ID
 * @returns スプレッドシートID、無効な場合は null
 */
function extractSpreadsheetId(input: string): string | null {
    // URLパターン: https://docs.google.com/spreadsheets/d/{ID}/...
    const urlMatch = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) {
        return urlMatch[1];
    }

    // IDとして有効かチェック（英数字、ハイフン、アンダースコアのみ）
    if (/^[a-zA-Z0-9_-]+$/.test(input) && input.length > 10) {
        return input;
    }

    return null;
}

function handleBack() {
    // スクリーニング画面を隠してプロジェクト選択画面を表示
    screeningSection.classList.add('hidden');
    configSection.classList.remove('hidden');

    // スプレッドシートIDをクリア
    spreadsheetId = '';
    references = [];
}

async function handleConnect() {
    const selectedId = recentSheetsSelect.value;
    if (!selectedId) {
        showStatus('スプレッドシートを選択してください', 'error');
        return;
    }

    try {
        showLoading(true);
        hideStatus();

        // スプレッドシートの存在確認
        const info = await getSpreadsheetInfo(selectedId);
        showStatus(`接続成功: ${info.title}`, 'success');

        spreadsheetId = selectedId;

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId });

        // データを読み込んで画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Connection error:', error);
        showStatus(`接続エラー: ${(error as Error).message}`, 'error');
    } finally {
        showLoading(false);
    }
}

/**
 * 最近使用したスプレッドシートをドロップダウンに読み込み
 */
async function loadRecentSheets() {
    try {
        recentSheetsSelect.innerHTML = '<option value="">読み込み中...</option>';

        const sheets = await getRecentSpreadsheets(15);

        recentSheetsSelect.innerHTML = '';

        if (sheets.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'スプレッドシートが見つかりません';
            recentSheetsSelect.appendChild(opt);
            return;
        }

        // 空の選択肢
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '— スプレッドシートを選択 —';
        recentSheetsSelect.appendChild(emptyOpt);

        for (const sheet of sheets) {
            const opt = document.createElement('option');
            opt.value = sheet.id;
            opt.textContent = sheet.name;
            recentSheetsSelect.appendChild(opt);
        }
    } catch (error) {
        console.error('Failed to load recent sheets:', error);
        const errorMessage = (error as Error).message || 'Unknown error';

        recentSheetsSelect.innerHTML = '';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '読み込み失敗';
        recentSheetsSelect.appendChild(opt);

        // 再認証ボタンを表示
        showStatus(`シート一覧取得失敗 - 権限を再設定してください`, 'error');

        // 再認証リンクを追加
        const reauthBtn = document.createElement('button');
        reauthBtn.textContent = '🔄 権限を再設定';
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
                showStatus('再認証に失敗しました', 'error');
            } finally {
                showLoading(false);
            }
        };
        statusMessage.appendChild(reauthBtn);
    }
}

async function handleCreateNew() {
    const title = prompt('新しいレビュープロジェクトの名前を入力してください:', 'TiAb Review Project');
    if (!title) return;

    try {
        showLoading(true);
        hideStatus();

        const newId = await createSpreadsheet(title);
        showStatus(`作成成功: ${title}`, 'success');

        spreadsheetId = newId;

        // 設定を保存
        await chrome.storage.local.set({ spreadsheetId });

        // 画面切り替え
        await loadDataAndShowScreening();
    } catch (error) {
        console.error('Create error:', error);
        showStatus(`作成エラー: ${(error as Error).message}`, 'error');
    } finally {
        showLoading(false);
    }
}

async function loadDataAndShowScreening() {
    try {
        showLoading(true);

        // 管理者権限とキーオープン状態を確認
        const [adminStatus, keyOpenedStatus, keywords] = await Promise.all([
            isUserAdmin(spreadsheetId, userEmail),
            getKeyOpenedStatus(spreadsheetId),
            getHighlightKeywords(spreadsheetId),
        ]);

        isAdmin = adminStatus;
        isKeyOpened = keyOpenedStatus;
        highlightKeywords = keywords;

        // キーオープン状態に応じてデータを読み込み
        if (isKeyOpened) {
            references = await getReferencesWithAllDecisions(spreadsheetId, userEmail);
        } else {
            references = await getReferencesWithStatus(spreadsheetId, userEmail);
        }

        // ソースファイルを抽出
        sourceFiles.clear();
        references.forEach(ref => {
            if (ref.source_file) sourceFiles.add(ref.source_file);
        });
        selectedSourceFiles = new Set(sourceFiles); // デフォルトですべて選択

        // 管理者の場合、キーオープンボタンを表示
        console.log('[loadDataAndShowScreening] isAdmin =', isAdmin, ', keySection =', keySection);

        // ユーザー情報に権限を表示
        userInfoDiv.textContent = `ログイン中: ${userEmail} (${isAdmin ? '管理者' : '一般'})`;

        if (isAdmin) {
            console.log('[loadDataAndShowScreening] Showing keySection');
            keySection.classList.remove('hidden');
            renderKeyStatus();
        } else {
            console.log('[loadDataAndShowScreening] Hiding keySection');
            keySection.classList.add('hidden');
        }

        // 画面を切り替え
        configSection.classList.add('hidden');
        screeningSection.classList.remove('hidden');

        // 表示
        currentIndex = 0;
        renderKeywords(); // キーワード設定を表示
        renderSourceFilters(); // ソースフィルターを表示
        renderCurrentReference();
    } catch (error) {
        console.error('Load data error:', error);
        showStatus(`データ読み込みエラー: ${(error as Error).message}`, 'error');
        // 設定画面に戻す
        configSection.classList.remove('hidden');
        screeningSection.classList.add('hidden');
    } finally {
        showLoading(false);
    }
}

async function loadConfig() {
    const result = await chrome.storage.local.get(['spreadsheetId']);
    if (result.spreadsheetId) {
        // ドロップダウンで選択
        recentSheetsSelect.value = result.spreadsheetId;
    }
}

function getFilteredReferences(): ReferenceWithStatus[] {
    let filtered = references;

    // ステータスフィルター
    if (currentFilter !== 'all') {
        filtered = filtered.filter((r) => r.status === currentFilter);
    }

    // ソースファイルフィルター
    if (selectedSourceFiles.size > 0 && selectedSourceFiles.size < sourceFiles.size) {
        filtered = filtered.filter(r => r.source_file && selectedSourceFiles.has(r.source_file));
    }

    // 検索フィルター
    const searchTerm = searchInput.value.toLowerCase().trim();
    if (searchTerm) {
        filtered = filtered.filter(
            (r) =>
                r.title.toLowerCase().includes(searchTerm) ||
                r.abstract?.toLowerCase().includes(searchTerm)
        );
    }

    return filtered;
}

function renderCurrentReference() {
    const filtered = getFilteredReferences();
    const ref = filtered[currentIndex];

    // 検索結果件数の更新
    const searchTerm = searchInput.value.trim();
    if (searchTerm) {
        searchResultCount.classList.remove('hidden');
        if (filtered.length === 0) {
            searchResultCount.textContent = `「${searchTerm}」: 0件ヒット`;
            searchResultCount.classList.add('no-results');
        } else {
            searchResultCount.textContent = `「${searchTerm}」: ${filtered.length}件ヒット（↓ 詳細を確認）`;
            searchResultCount.classList.remove('no-results');
        }
    } else {
        searchResultCount.classList.add('hidden');
    }

    if (!ref) {
        refTitle.textContent = '文献がありません';
        refAuthors.textContent = '';
        refYear.textContent = '';
        refJournal.textContent = '';
        refAbstract.textContent = references.length === 0
            ? 'RISファイルをインポートするか、スプレッドシートに文献を追加してください'
            : 'フィルター条件に一致する文献がありません';
        refDoi.classList.add('hidden');
        refPmid.classList.add('hidden');
        navPosition.textContent = '0 / 0';
        progressText.textContent = `0 / ${references.length}`;

        // フィルターの件数を更新
        updateFilterCounts();

        // 不一致UI非表示
        conflictBanner.classList.add('hidden');
        allDecisionsDiv.classList.add('hidden');
        return;
    }


    // キーオープン後の不一致表示
    if (isKeyOpened && ref.allDecisions && ref.allDecisions.length > 0) {
        // 全レビュアーの判定を表示
        renderAllDecisions(ref);
        allDecisionsDiv.classList.remove('hidden');

        // 不一致バナーの表示
        if (ref.hasConflict) {
            conflictBanner.classList.remove('hidden');
        } else {
            conflictBanner.classList.add('hidden');
        }
    } else {
        conflictBanner.classList.add('hidden');
        allDecisionsDiv.classList.add('hidden');
    }

    refTitle.innerHTML = highlightText(ref.title);
    refAuthors.textContent = ref.authors || '';
    refYear.textContent = ref.year?.toString() || '';
    refJournal.textContent = ref.journal || '';
    refAbstract.innerHTML = highlightText(ref.abstract || '(抄録なし)');

    if (ref.doi) {
        refDoi.href = `https://doi.org/${ref.doi}`;
        refDoi.classList.remove('hidden');
    } else {
        refDoi.classList.add('hidden');
    }

    if (ref.pmid) {
        refPmid.href = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}`;
        refPmid.classList.remove('hidden');
    } else {
        refPmid.classList.add('hidden');
    }

    // ナビゲーション更新
    navPosition.textContent = `${currentIndex + 1} / ${filtered.length}`;
    progressText.textContent = `${references.filter((r) => r.status !== 'pending' && r.status !== 'conflict').length} / ${references.length}`;

    // フィルターの件数を更新
    updateFilterCounts();

    // メモをリセット
    noteInput.value = ref.myDecision?.note || '';

    // ボタンの状態を更新（現在の判定をハイライト）
    const myStatus = ref.myDecision?.decision || 'pending';
    btnInclude.classList.toggle('active', myStatus === 'include');
    btnMaybe.classList.toggle('active', myStatus === 'maybe');
    btnExclude.classList.toggle('active', myStatus === 'exclude');
}

function updateFilterCounts() {
    // ソースファイルフィルターを適用したものでカウント
    let filtered = references;
    if (selectedSourceFiles.size > 0 && selectedSourceFiles.size < sourceFiles.size) {
        filtered = references.filter(r => r.source_file && selectedSourceFiles.has(r.source_file));
    }

    const counts = {
        pending: filtered.filter(r => r.status === 'pending').length,
        all: filtered.length,
        include: filtered.filter(r => r.status === 'include').length,
        exclude: filtered.filter(r => r.status === 'exclude').length,
        maybe: filtered.filter(r => r.status === 'maybe').length,
        conflict: filtered.filter(r => r.status === 'conflict').length,
    };

    const options = statusFilter.options;
    options[0].textContent = `未判定 (${counts.pending})`;
    options[1].textContent = `すべて (${counts.all})`;
    options[2].textContent = `Include (${counts.include})`;
    options[3].textContent = `Exclude (${counts.exclude})`;
    options[4].textContent = `Maybe (${counts.maybe})`;
    options[5].textContent = `不一致 (${counts.conflict})`;
}


async function navigate(direction: number) {
    const filtered = getFilteredReferences();
    const currentRef = filtered[currentIndex];

    // 遷移前に現在のメモを保存（変更されている場合のみ）
    if (currentRef) {
        const currentNote = noteInput.value || undefined;
        const savedNote = currentRef.myDecision?.note;

        if (currentNote !== savedNote) {
            if (currentRef.myDecision) {
                // 既存の判定がある場合はメモを更新
                currentRef.myDecision.note = currentNote;
                currentRef.myDecision.decided_at = new Date().toISOString();

                // バックグラウンドで保存
                apiSaveDecision(spreadsheetId, currentRef.myDecision)
                    .then(() => console.log('Note saved on navigate:', currentRef.myDecision))
                    .catch((error) => {
                        console.error('Failed to save note on navigate:', error);
                    });
            } else if (currentNote) {
                // 未判定だがメモが入力されている場合は新しいDecisionを作成
                const newDecision: Decision = {
                    decision_id: crypto.randomUUID(),
                    ref_id: currentRef.ref_id,
                    reviewer_id: userEmail,
                    decision: 'pending',  // 未判定時のメモはpendingとして保存
                    note: currentNote,
                    decided_at: new Date().toISOString(),
                    client_version: '0.1.0',
                };
                currentRef.myDecision = newDecision;

                // バックグラウンドで保存
                apiSaveDecision(spreadsheetId, newDecision)
                    .then(() => console.log('Note saved on navigate (new decision):', newDecision))
                    .catch((error) => {
                        console.error('Failed to save note on navigate:', error);
                    });
            }
        }
    }

    let newIndex = currentIndex + direction;

    // ループナビゲーション
    if (newIndex < 0) {
        newIndex = filtered.length - 1;  // 最初から最後へ
    } else if (newIndex >= filtered.length) {
        newIndex = 0;  // 最後から最初へ
    }

    if (filtered.length > 0) {
        currentIndex = newIndex;
        renderCurrentReference();
    }
}

async function handleDecision(decision: 'include' | 'exclude' | 'maybe') {
    const filtered = getFilteredReferences();
    const ref = filtered[currentIndex];

    if (!ref) return;

    // 判定オブジェクトを作成（ラベルは廃止により削除）
    const decisionObj: Decision = {
        decision_id: ref.myDecision?.decision_id || crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: userEmail,
        decision,
        note: noteInput.value || undefined,
        decided_at: new Date().toISOString(),
        client_version: '0.1.0',
    };

    // ローカル状態を更新
    ref.myDecision = decisionObj;

    // キーオープン後の場合、allDecisionsも更新
    if (isKeyOpened && ref.allDecisions) {
        const existingIndex = ref.allDecisions.findIndex(d => d.reviewer_id === userEmail);
        if (existingIndex !== -1) {
            ref.allDecisions[existingIndex] = decisionObj;
        } else {
            ref.allDecisions.push(decisionObj);
        }

        // 不一致状態を再計算
        const decisions = ref.allDecisions;
        if (decisions.length === 0) {
            ref.hasConflict = false;
            ref.status = 'pending';
        } else if (decisions.length === 1) {
            ref.hasConflict = true;
            ref.status = 'conflict';
        } else {
            const uniqueDecisions = new Set(decisions.map(d => d.decision));
            ref.hasConflict = uniqueDecisions.size > 1;
            ref.status = ref.hasConflict ? 'conflict' : decision;
        }
    } else {
        ref.status = decision;
    }

    // UIを即座に更新
    renderCurrentReference();

    // 次の文献へ（保存を待たずに移動）
    navigate(1);

    // APIに保存（バックグラウンド、UIブロックしない）
    apiSaveDecision(spreadsheetId, decisionObj)
        .then(() => console.log('Decision saved:', decisionObj))
        .catch((error) => {
            console.error('Failed to save decision:', error);
            // TODO: オフラインキューに追加
        });
}

/**
 * RIS ファイルのインポート処理
 */
async function handleRISImport() {
    const file = risFileInput.files?.[0];
    if (!file) return;

    try {
        importStatus.textContent = '読み込み中...';
        importStatus.className = 'import-status loading';
        importBtn.disabled = true;

        // RIS ファイルをパース
        const newRefs = await parseRISFile(file);

        if (newRefs.length === 0) {
            importStatus.textContent = '有効な文献が見つかりませんでした';
            importStatus.className = 'import-status error';
            return;
        }

        // 既存データから重複キーを取得
        importStatus.textContent = '重複チェック中...';
        const existingRefs = await getReferences(spreadsheetId);
        const existingKeys = new Set(existingRefs.map(r => r.dedupe_key).filter(Boolean));

        // 重複を除外
        const uniqueRefs = newRefs.filter(ref => !existingKeys.has(ref.dedupe_key));
        const skippedCount = newRefs.length - uniqueRefs.length;

        if (uniqueRefs.length === 0) {
            importStatus.textContent = `${newRefs.length}件すべて重複のためスキップしました`;
            importStatus.className = 'import-status info';
            return;
        }

        // imported_by を設定
        uniqueRefs.forEach(ref => {
            ref.imported_by = userEmail;
        });

        // スプレッドシートに追加
        await addReferences(spreadsheetId, uniqueRefs);

        // データを再読み込み
        references = await getReferencesWithStatus(spreadsheetId, userEmail);

        // ソースファイルフィルターを更新
        sourceFiles.clear();
        references.forEach(ref => {
            if (ref.source_file) sourceFiles.add(ref.source_file);
        });
        selectedSourceFiles = new Set(sourceFiles);
        renderSourceFilters();

        currentIndex = 0;
        currentFilter = 'pending';
        statusFilter.value = 'pending';
        renderCurrentReference();


        // 結果メッセージ
        const message = skippedCount > 0
            ? `${uniqueRefs.length}件インポート（${skippedCount}件は重複のためスキップ）`
            : `${uniqueRefs.length}件の文献をインポートしました`;
        importStatus.textContent = message;
        importStatus.className = 'import-status success';
    } catch (error) {
        console.error('Import error:', error);
        importStatus.textContent = `インポートエラー: ${(error as Error).message}`;
        importStatus.className = 'import-status error';
    } finally {
        importBtn.disabled = false;
        risFileInput.value = ''; // ファイル選択をリセット

        // 3秒後にステータスをクリア
        setTimeout(() => {
            importStatus.textContent = '';
            importStatus.className = 'import-status';
        }, 5000);
    }
}


// ========== ハイライトキーワード関連関数 ==========

/**
 * 共有設定を追加
 */
async function handleShare() {
    const email = shareEmailInput.value.trim();
    if (!email) return;

    // Email validation (simple check)
    if (!email.includes('@')) {
        showStatus('有効なメールアドレスを入力してください', 'error');
        return;
    }

    try {
        shareSubmitBtn.disabled = true;
        shareSubmitBtn.textContent = '...';

        await addPermission(spreadsheetId, email, 'writer');

        showToast(`${email} を追加しました`);
        shareEmailInput.value = '';
        shareInputArea.classList.add('hidden');
    } catch (error) {
        console.error('Share error:', error);
        showStatus(`追加エラー: ${(error as Error).message}`, 'error');
    } finally {
        shareSubmitBtn.disabled = false;
        shareSubmitBtn.textContent = '追加';
    }
}


/**
 * 共有ユーザーリストを読み込み
 */
async function loadSharedUsers() {
    try {
        sharedUsersList.innerHTML = '<div style="font-size:11px;color:#666;">読み込み中...</div>';

        // 管理者権限チェック（fallback含む）
        const isAdmin = await isUserAdmin(spreadsheetId, userEmail);

        let permissions: any[] = [];
        try {
            permissions = await getSpreadsheetPermissions(spreadsheetId);
        } catch (e) {
            console.warn('Failed to load permissions list (likely due to scope):', e);
        }

        if (permissions.length === 0) {
            if (isAdmin) {
                // Adminだがリストが見れない場合（drive.fileスコープで自分がオーナーでない場合など）
                // 自分の情報を表示しておく
                sharedUsersList.innerHTML = '';
                const div = document.createElement('div');
                div.className = 'shared-user-item';
                div.innerHTML = `
                    <span class="shared-user-email" title="${userEmail}">${userEmail} (自分)</span>
                    <span class="shared-user-role">編集者(詳細不明)</span>
                `;
                sharedUsersList.appendChild(div);

                const note = document.createElement('div');
                note.style.fontSize = '10px';
                note.style.color = '#999';
                note.style.marginTop = '4px';
                note.textContent = '※権限リストの取得には追加の認証が必要な場合があります';
                sharedUsersList.appendChild(note);
            } else {
                sharedUsersList.innerHTML = '<div style="font-size:11px;color:#666;">ユーザーが見つかりません</div>';
            }
            return;
        }

        sharedUsersList.innerHTML = '';
        permissions.forEach(p => {
            const div = document.createElement('div');
            div.className = 'shared-user-item';

            const emailSpan = document.createElement('span');
            emailSpan.className = 'shared-user-email';
            emailSpan.textContent = p.emailAddress;
            emailSpan.title = p.emailAddress; // tooltip

            const roleSpan = document.createElement('span');
            roleSpan.className = 'shared-user-role';
            roleSpan.textContent = p.role === 'owner' ? 'オーナー' : (p.role === 'writer' ? '編集者' : '閲覧者');

            div.appendChild(emailSpan);
            div.appendChild(roleSpan);
            sharedUsersList.appendChild(div);
        });

    } catch (error) {
        console.error('Failed to load shared users:', error);
        sharedUsersList.innerHTML = '<div style="font-size:11px;color:#c62828;">読み込み失敗</div>';
    }
}

/**
 * トースト通知を表示
 */
function showToast(message: string, duration = 2000) {
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), duration);
}

/**
 * HTML エスケープ
 */
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * テキスト内のキーワードをハイライト
 */
function highlightText(text: string): string {
    if (!text) return '';
    let result = escapeHtml(text);

    // 除外キーワード（赤）
    for (const kw of highlightKeywords.exclude) {
        if (!kw) continue;
        const regex = createSmartRegex(kw);
        result = result.replace(regex, '<mark class="highlight-exclude">$1</mark>');
    }

    // 組み入れキーワード（緑）
    for (const kw of highlightKeywords.include) {
        if (!kw) continue;
        const regex = createSmartRegex(kw);
        result = result.replace(regex, '<mark class="highlight-include">$1</mark>');
    }

    return result;
}

/**
 * スマートな正規表現作成（英単語は完全一致、それ以外は部分一致）
 */
function createSmartRegex(keyword: string): RegExp {
    const escaped = escapeRegex(keyword);
    let pattern = escaped;

    // 先頭が単語構成文字(a-z, 0-9, _)の場合は単語境界を要求
    if (/^\w/.test(keyword)) {
        pattern = `\\b${pattern}`;
    }

    // 末尾が単語構成文字の場合は単語境界を要求
    if (/\w$/.test(keyword)) {
        pattern = `${pattern}\\b`;
    }

    return new RegExp(`(${pattern})`, 'gi');
}

/**
 * 正規表現のエスケープ
 */
function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * キーワードを描画（編集用UI）
 */
function renderKeywords() {
    renderKeywordList(highlightKeywords.include, includeKeywordsListDiv, 'include');
    renderKeywordList(highlightKeywords.exclude, excludeKeywordsListDiv, 'exclude');
}

function renderKeywordList(keywords: string[], container: HTMLElement, type: 'include' | 'exclude') {
    container.innerHTML = '';
    for (const word of keywords) {
        const span = document.createElement('span');
        span.className = 'keyword-tag';
        span.innerHTML = `${escapeHtml(word)}<span class="remove-keyword">✕</span>`;
        span.querySelector('.remove-keyword')?.addEventListener('click', () => {
            removeKeyword(type, word);
        });
        container.appendChild(span);
    }
}

/**
 * キーワードを追加
 */
async function addKeyword(type: 'include' | 'exclude') {
    const input = type === 'include' ? newIncludeInput : newExcludeInput;
    const word = input.value.trim();

    if (!word) return;

    // 重複チェック
    const list = type === 'include' ? highlightKeywords.include : highlightKeywords.exclude;
    if (list.includes(word)) {
        input.value = '';
        return;
    }

    // 追加
    if (type === 'include') {
        highlightKeywords.include.push(word);
    } else {
        highlightKeywords.exclude.push(word);
    }

    input.value = '';
    renderKeywords();
    renderCurrentReference(); // ハイライト即時反映

    // 自動保存
    await saveKeywordsAuto();
}

/**
 * キーワードを削除
 */
async function removeKeyword(type: 'include' | 'exclude', word: string) {
    if (type === 'include') {
        highlightKeywords.include = highlightKeywords.include.filter(w => w !== word);
    } else {
        highlightKeywords.exclude = highlightKeywords.exclude.filter(w => w !== word);
    }
    renderKeywords();
    renderCurrentReference(); // ハイライト即時反映

    // 自動保存
    await saveKeywordsAuto();
}

/**
 * プリセットを適用
 */
async function applyPreset(type: 'RCT' | 'SR') {
    if (!confirm(`${type}用プリセットを適用しますか？\n現在のキーワード設定は上書きされます。`)) {
        return;
    }

    const preset = type === 'RCT' ? PRESET_RCT : PRESET_SR;

    // 値渡しでコピー
    highlightKeywords = {
        include: [...preset.include],
        exclude: [...preset.exclude]
    };

    renderKeywords();
    renderCurrentReference();

    // 自動保存
    await saveKeywordsAuto();

    showToast(`${type}用プリセットを適用しました`);
}

/**
 * 設定をConfigシートに自動保存
 */
async function saveKeywordsAuto() {
    try {
        updateSaveStatus('saving');

        await updateConfigKeywords(spreadsheetId, highlightKeywords);

        updateSaveStatus('saved');

        // 3秒後にステータスをデフォルトに戻す（アイコンのみなど）
        setTimeout(() => {
            if (saveStatus.classList.contains('saved')) {
                updateSaveStatus('default');
            }
        }, 3000);

    } catch (error) {
        console.error('Failed to save keywords:', error);
        updateSaveStatus('error');
    }
}

/**
 * 保存ステータス表示を更新
 */
function updateSaveStatus(state: 'default' | 'saving' | 'saved' | 'error') {
    saveStatus.classList.remove('saving', 'saved', 'error');

    switch (state) {
        case 'saving':
            saveStatus.innerHTML = '<span class="save-icon">⏳</span> 保存中...';
            saveStatus.classList.add('saving');
            break;
        case 'saved':
            saveStatus.innerHTML = '<span class="save-icon">✓</span> 保存しました';
            saveStatus.classList.add('saved');
            break;
        case 'error':
            saveStatus.innerHTML = '<span class="save-icon">⚠️</span> 保存に失敗しました';
            saveStatus.classList.add('error');
            break;
        default:
            saveStatus.innerHTML = '<span class="save-icon">✓</span> 設定は自動的に保存されます';
            break;
    }
}

/**
 * キー状態ボタンの表示更新
 */
function renderKeyStatus() {
    keyToggleInput.checked = isKeyOpened;
    // チェックボックスの状態だけで表現するのでテキスト変更などは不要
    // 必要ならラベルを変更してもよいが、今回はスライダーで表現
}

/**
 * キー状態切替処理
 */
async function handleKeyToggle() {
    // チェックボックスは既に切り替わっているので、その状態を取得
    const newState = keyToggleInput.checked;

    if (!newState) {
        // CLOSE処理 (ON -> OFF)
        if (!confirm('キークローズを実行しますか？\n他のレビュアーの判定が見えなくなり、不一致表示も非表示になります。')) {
            // キャンセルされたら元の状態に戻す
            keyToggleInput.checked = true;
            return;
        }

        try {
            showLoading(true);
            await setKeyOpenedStatus(spreadsheetId, false);
            isKeyOpened = false;

            // データを再読み込み（自分の判定のみ取得になる）
            references = await getReferencesWithStatus(spreadsheetId, userEmail);

            // 表示を更新
            renderKeyStatus();
            currentIndex = 0;
            currentFilter = 'pending';
            statusFilter.value = 'pending';
            renderCurrentReference();

            showToast('キークローズを実行しました');
        } catch (error) {
            console.error('Key close error:', error);
            alert(`キークローズエラー: ${(error as Error).message}`);
            // エラー時は元の状態に戻す
            keyToggleInput.checked = true;
        } finally {
            showLoading(false);
        }

    } else {
        // OPEN処理 (OFF -> ON)
        if (!confirm('キーオープンを実行しますか？\n全レビュアーの判定が相互に見えるようになり、不一致が表示されます。')) {
            // キャンセルされたら元の状態に戻す
            keyToggleInput.checked = false;
            return;
        }

        try {
            showLoading(true);
            await setKeyOpenedStatus(spreadsheetId, true);
            isKeyOpened = true;

            // データを再読み込み
            references = await getReferencesWithAllDecisions(spreadsheetId, userEmail);

            // 表示を更新
            renderKeyStatus();
            currentIndex = 0;
            currentFilter = 'conflict';
            statusFilter.value = 'conflict';
            renderCurrentReference();

            showToast('キーオープンを実行しました');
        } catch (error) {
            console.error('Key open error:', error);
            alert(`キーオープンエラー: ${(error as Error).message}`);
            // エラー時は元の状態に戻す
            keyToggleInput.checked = false;
        } finally {
            showLoading(false);
        }
    }
}

/**
 * 全レビュアーの判定を表示
 */
function renderAllDecisions(ref: ReferenceWithStatus) {
    if (!ref.allDecisions || ref.allDecisions.length === 0) {
        allDecisionsDiv.innerHTML = '<p style="color: #666; font-size: 12px;">判定データがありません</p>';
        return;
    }

    allDecisionsDiv.innerHTML = '';

    // レビュアーごとの判定を表示
    const decisionsMap = new Map<string, Decision>();
    ref.allDecisions.forEach(decision => {
        decisionsMap.set(decision.reviewer_id, decision);
    });

    // 全レビュアー（判定済み＋未判定）を表示
    const allReviewers = new Set([
        ...ref.allDecisions.map(d => d.reviewer_id),
        userEmail, // 自分を必ず含める
    ]);

    allReviewers.forEach(reviewerId => {
        const decision = decisionsMap.get(reviewerId);
        const isMe = reviewerId === userEmail;

        const item = document.createElement('div');
        item.className = 'decision-item';

        const reviewerSpan = document.createElement('span');
        reviewerSpan.className = isMe ? 'decision-reviewer is-me' : 'decision-reviewer';
        reviewerSpan.textContent = isMe ? `${reviewerId} (あなた)` : reviewerId;

        const valueSpan = document.createElement('span');
        const decisionValue = decision?.decision || 'pending';
        valueSpan.className = `decision-value ${decisionValue}`;

        const valueText = {
            'include': 'Include',
            'exclude': 'Exclude',
            'maybe': 'Maybe',
            'pending': '未判定',
        }[decisionValue] || decisionValue;

        valueSpan.textContent = valueText;

        item.appendChild(reviewerSpan);
        item.appendChild(valueSpan);
        allDecisionsDiv.appendChild(item);
    });
}


/**
 * フィルター結果をCSVとしてエクスポート
 */
async function handleExportCSV() {
    const filtered = getFilteredReferences();

    if (filtered.length === 0) {
        showToast('エクスポートする文献がありません');
        return;
    }

    try {
        // プロジェクトタイトルを取得
        let projectTitle = 'TiAb_Review';
        try {
            const info = await getSpreadsheetInfo(spreadsheetId);
            projectTitle = info.title.replace(/[\\/:*?"<>|]/g, '_'); // ファイル名に使えない文字を置換
        } catch {
            console.log('[handleExportCSV] Could not get spreadsheet title');
        }

        // フィルター条件を取得
        const filterLabels: Record<string, string> = {
            'pending': '未判定',
            'all': 'すべて',
            'include': 'Include',
            'exclude': 'Exclude',
            'maybe': 'Maybe',
            'conflict': '不一致',
        };
        const filterLabel = filterLabels[currentFilter] || currentFilter;

        // 日付
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // ファイル名
        const filename = `${projectTitle}_${filterLabel}_${dateStr}_${filtered.length}件.csv`;

        // CSVヘッダー
        const headers = [
            'title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'issn',
            'doi', 'pmid', 'status', 'note'
        ];

        // CSVデータを構築
        const csvRows: string[] = [];
        csvRows.push(headers.map(escapeCSVField).join(','));

        for (const ref of filtered) {
            const row = [
                ref.title || '',
                ref.authors || '',
                ref.year?.toString() || '',
                ref.journal || '',
                ref.volume || '',
                ref.issue || '',
                ref.pages || '',
                ref.issn || '',
                ref.doi || '',
                ref.pmid || '',
                ref.status || '',
                ref.myDecision?.note || '',
            ];
            csvRows.push(row.map(escapeCSVField).join(','));
        }

        const csvContent = csvRows.join('\r\n');

        // BOM付きUTF-8でBlob作成
        const bom = '\uFEFF';
        const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });

        // ダウンロード
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`${filtered.length}件をCSVとして出力しました`);
    } catch (error) {
        console.error('[handleExportCSV] Error:', error);
        showToast('CSVエクスポートに失敗しました');
    }
}

/**
 * CSVフィールドをエスケープ
 */
function escapeCSVField(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}


export { };
