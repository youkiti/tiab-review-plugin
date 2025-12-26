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
const spreadsheetIdInput = document.getElementById('spreadsheet-id') as HTMLInputElement;
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
const excludeReasonGroup = document.getElementById('exclude-reason-group') as HTMLElement;
const excludeReason = document.getElementById('exclude-reason') as HTMLSelectElement;
const noteInput = document.getElementById('note') as HTMLTextAreaElement;

const btnPrev = document.getElementById('btn-prev') as HTMLButtonElement;
const btnNext = document.getElementById('btn-next') as HTMLButtonElement;
const navPosition = document.getElementById('nav-position') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;

// RIS インポート
const risFileInput = document.getElementById('ris-file') as HTMLInputElement;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const importStatus = document.getElementById('import-status') as HTMLElement;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initApp();
});

async function initApp() {
    try {
        showLoading(true);
        // ユーザー情報を取得
        userEmail = await getUserEmail();
        userInfoDiv.textContent = `ログイン中: ${userEmail}`;
        userInfoDiv.classList.remove('hidden');

        // 保存済み設定を読み込み
        await loadConfig();
    } catch (error) {
        showStatus('Googleアカウントにログインしてください', 'error');
        console.error('Init error:', error);
    } finally {
        showLoading(false);
    }
}

function setupEventListeners() {
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

    // 判定ボタン
    btnInclude.addEventListener('click', () => handleDecision('include'));
    btnMaybe.addEventListener('click', () => handleDecision('maybe'));
    btnExclude.addEventListener('click', () => {
        excludeReasonGroup.classList.remove('hidden');
    });

    excludeReason.addEventListener('change', () => {
        if (excludeReason.value) {
            handleDecision('exclude');
        }
    });

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
            excludeReasonGroup.classList.remove('hidden');
            excludeReason.focus();
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

async function handleConnect() {
    const input = spreadsheetIdInput.value.trim();
    if (!input) {
        showStatus('スプレッドシートIDまたはURLを入力してください', 'error');
        return;
    }

    // URLからIDを抽出、またはそのままIDとして使用
    const extractedId = extractSpreadsheetId(input);
    if (!extractedId) {
        showStatus('無効なスプレッドシートIDまたはURLです', 'error');
        return;
    }

    try {
        showLoading(true);
        hideStatus();

        // スプレッドシートの存在確認
        const info = await getSpreadsheetInfo(extractedId);
        showStatus(`接続成功: ${info.title}`, 'success');

        spreadsheetId = extractedId;

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

async function handleCreateNew() {
    const title = prompt('新しいレビュープロジェクトの名前を入力してください:', 'TiAb Review Project');
    if (!title) return;

    try {
        showLoading(true);
        hideStatus();

        const newId = await createSpreadsheet(title);
        showStatus(`作成成功: ${title}`, 'success');

        spreadsheetId = newId;
        spreadsheetIdInput.value = newId;

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
        spreadsheetIdInput.value = result.spreadsheetId;
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

    // 除外理由をリセット
    excludeReasonGroup.classList.add('hidden');
    excludeReason.value = '';
    noteInput.value = ref.myDecision?.note || '';

    // ボタンの状態を更新（現在の判定をハイライト）
    btnInclude.classList.toggle('active', ref.status === 'include');
    btnMaybe.classList.toggle('active', ref.status === 'maybe');
    btnExclude.classList.toggle('active', ref.status === 'exclude');
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

    // exclude時は理由が必要
    if (decision === 'exclude' && !excludeReason.value) {
        excludeReasonGroup.classList.remove('hidden');
        excludeReason.focus();
        return;
    }

    // 判定オブジェクトを作成
    const decisionObj: Decision = {
        decision_id: ref.myDecision?.decision_id || crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: userEmail,
        decision,
        reason: decision === 'exclude' ? excludeReason.value : undefined,
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
