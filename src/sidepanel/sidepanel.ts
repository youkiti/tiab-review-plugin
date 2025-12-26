// Sidepanel スクリプト

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus } from '../lib/types';
import {
    getAuthToken,
    getUserEmail,
    createSpreadsheet,
    getSpreadsheetInfo,
    getReferencesWithStatus,
    saveDecision as apiSaveDecision,
    addReferences,
    getRecentSpreadsheets,
    forceReauth,
} from '../lib/sheets-api';
import { parseRISFile } from '../lib/ris-parser';

// 状態管理
let references: ReferenceWithStatus[] = [];
let currentIndex = 0;
let currentFilter: DecisionStatus | 'all' = 'pending';
let spreadsheetId = '';
let userEmail = '';

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
const importStatus = document.getElementById('import-status') as HTMLElement;
const backBtn = document.getElementById('back-btn') as HTMLButtonElement;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initApp();
});

// ログイン/プロジェクトセクション
const loginSection = document.getElementById('login-section') as HTMLElement;
const projectSection = document.getElementById('project-section') as HTMLElement;
const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;

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
        userEmail = 'unknown';
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

        // データを読み込み
        references = await getReferencesWithStatus(spreadsheetId, userEmail);

        // 画面を切り替え
        configSection.classList.add('hidden');
        screeningSection.classList.remove('hidden');

        // 表示
        currentIndex = 0;
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
        return;
    }

    refTitle.textContent = ref.title;
    refAuthors.textContent = ref.authors || '';
    refYear.textContent = ref.year?.toString() || '';
    refJournal.textContent = ref.journal || '';
    refAbstract.textContent = ref.abstract || '(抄録なし)';

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
    progressText.textContent = `${references.filter((r) => r.status !== 'pending').length} / ${references.length}`;

    // フィルターの件数を更新
    updateFilterCounts();

    // メモをリセット
    noteInput.value = ref.myDecision?.note || '';

    // ボタンの状態を更新（現在の判定をハイライト）
    btnInclude.classList.toggle('active', ref.status === 'include');
    btnMaybe.classList.toggle('active', ref.status === 'maybe');
    btnExclude.classList.toggle('active', ref.status === 'exclude');
}

function updateFilterCounts() {
    const counts = {
        pending: references.filter(r => r.status === 'pending').length,
        all: references.length,
        include: references.filter(r => r.status === 'include').length,
        exclude: references.filter(r => r.status === 'exclude').length,
        maybe: references.filter(r => r.status === 'maybe').length,
    };

    const options = statusFilter.options;
    options[0].textContent = `未判定 (${counts.pending})`;
    options[1].textContent = `すべて (${counts.all})`;
    options[2].textContent = `Include (${counts.include})`;
    options[3].textContent = `Exclude (${counts.exclude})`;
    options[4].textContent = `Maybe (${counts.maybe})`;
}

function navigate(direction: number) {
    const filtered = getFilteredReferences();
    const newIndex = currentIndex + direction;

    if (newIndex >= 0 && newIndex < filtered.length) {
        currentIndex = newIndex;
        renderCurrentReference();
    }
}

async function handleDecision(decision: 'include' | 'exclude' | 'maybe') {
    const filtered = getFilteredReferences();
    const ref = filtered[currentIndex];

    if (!ref) return;

    // 判定オブジェクトを作成
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
    ref.status = decision;
    ref.myDecision = decisionObj;

    // UIを即座に更新
    renderCurrentReference();

    // APIに保存（非同期）
    try {
        await apiSaveDecision(spreadsheetId, decisionObj);
        console.log('Decision saved:', decisionObj);
    } catch (error) {
        console.error('Failed to save decision:', error);
        // TODO: オフラインキューに追加
    }

    // 次の文献へ
    navigate(1);
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

        // imported_by を設定
        newRefs.forEach(ref => {
            ref.imported_by = userEmail;
        });

        // スプレッドシートに追加
        await addReferences(spreadsheetId, newRefs);

        // データを再読み込み
        references = await getReferencesWithStatus(spreadsheetId, userEmail);
        currentIndex = 0;
        currentFilter = 'pending';
        statusFilter.value = 'pending';
        renderCurrentReference();

        importStatus.textContent = `${newRefs.length}件の文献をインポートしました`;
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

export { };
