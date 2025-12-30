// Sidepanel スクリプト

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, LlmConfig, LlmCriteria, LlmBatchProgress } from '../lib/types';
import {
    getAuthToken,
    getUserEmail,
    createSpreadsheet,
    getSpreadsheetInfo,
    validateSpreadsheetFormat,
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
    getLlmConfig,
    updateLlmConfig,
    appendDecisions,
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    saveLlmExecution,
    getLlmExecutions,
    DEFAULT_LLM_CONFIG,
} from '../lib/sheets-api';

import { parseRISFile } from '../lib/ris-parser';
import {
    getGeminiApiKey,
    saveGeminiApiKey,
    removeGeminiApiKey,
    hasGeminiApiKey,
    setSessionApiKey,
    getEffectiveApiKey,
    getApiKeySavePreference,
    setApiKeySavePreference,
} from '../lib/storage';
import { testApiKey, convertCriteria, GeminiModelConfig } from '../lib/gemini-api';
import {
    processBatch,
    calculateProbabilityDistribution,
    previewThresholdCounts,
    applyThresholdToDecisions,
    createLlmExecution,
    parseLlmDecisionNote,
} from '../lib/llm-processor';
import { generateScreeningPromptFromCriteria, DEFAULT_SCREENING_PROMPT } from '../lib/prompt-templates';

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
let autoNavigateAfterDecision = true;  // 判断後に自動的に次の文献に遷移するかどうか
let showRecordCountBelow = true;  // レコード件数をタイトル下に表示するか（false=上に表示）
let termFilterUseAnd = true;  // 複数term選択時にAND検索を使用するか（false=OR検索）
let activeTermFilters: { term: string; type: 'include' | 'exclude' }[] = [];  // アクティブなタームフィルター

// LLM関連の状態
let currentTab: 'screening' | 'llm' = 'screening';
let llmConfig: LlmConfig = { ...DEFAULT_LLM_CONFIG };
let batchAbortController: AbortController | null = null;
let currentExecutionId: string = '';
let currentBatchDecisions: Decision[] = [];

// DOM要素
const sourceFileListDiv = document.getElementById('source-file-list') as HTMLElement;
const sourceFiltersSection = document.getElementById('source-filters-section') as HTMLElement;
const activeTermFiltersDiv = document.getElementById('active-term-filters') as HTMLElement;

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
const filterResultCount = document.getElementById('filter-result-count') as HTMLElement;

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
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const exportMenu = document.getElementById('export-menu') as HTMLElement;
const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
const exportRisBtn = document.getElementById('export-ris-btn') as HTMLButtonElement;
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

// LLM関連DOM要素
const llmSection = document.getElementById('llm-section') as HTMLElement;
const tabScreeningBtn = document.getElementById('tab-screening') as HTMLButtonElement;
const tabLlmBtn = document.getElementById('tab-llm') as HTMLButtonElement;
const headerTabs = document.querySelector('.header-tabs') as HTMLElement;
const llmBackBtn = document.getElementById('llm-back-btn') as HTMLButtonElement;
const geminiApiKeyInput = document.getElementById('gemini-api-key') as HTMLInputElement;
const toggleApiKeyVisibilityBtn = document.getElementById('toggle-api-key-visibility') as HTMLButtonElement;
const saveApiKeyCheckbox = document.getElementById('save-api-key-checkbox') as HTMLInputElement;
const apiKeyStatus = document.getElementById('api-key-status') as HTMLElement;
const llmModelSelect = document.getElementById('llm-model-select') as HTMLSelectElement;
const llmLanguageSelect = document.getElementById('llm-language-select') as HTMLSelectElement;
const protocolTextInput = document.getElementById('protocol-text-input') as HTMLTextAreaElement;
const optimizeCriteriaBtn = document.getElementById('optimize-criteria-btn') as HTMLButtonElement;
const optimizeStatusDiv = document.getElementById('optimize-status') as HTMLElement;
const optimizedCriteriaDisplay = document.getElementById('optimized-criteria-display') as HTMLElement;
const screeningPromptInput = document.getElementById('screening-prompt-input') as HTMLTextAreaElement;
const saveCriteriaBtn = document.getElementById('save-criteria-btn') as HTMLButtonElement;
const batchSaveSizeInput = document.getElementById('batch-save-size-input') as HTMLInputElement;
const batchTargetCount = document.getElementById('batch-target-count') as HTMLElement;
const startBatchBtn = document.getElementById('start-batch-btn') as HTMLButtonElement;
const stopBatchBtn = document.getElementById('stop-batch-btn') as HTMLButtonElement;
const batchProgressDiv = document.getElementById('batch-progress') as HTMLElement;
const batchProgressCurrent = document.getElementById('batch-progress-current') as HTMLElement;
const batchProgressTotal = document.getElementById('batch-progress-total') as HTMLElement;
const batchProgressPercent = document.getElementById('batch-progress-percent') as HTMLElement;
const batchProgressBarFill = document.getElementById('batch-progress-bar-fill') as HTMLElement;
const batchSuccessCount = document.getElementById('batch-success-count') as HTMLElement;
const batchFailCount = document.getElementById('batch-fail-count') as HTMLElement;
const thresholdSection = document.getElementById('threshold-section') as HTMLElement;
const thresholdProcessedCount = document.getElementById('threshold-processed-count') as HTMLElement;
const thresholdSlider = document.getElementById('threshold-slider') as HTMLInputElement;
const thresholdValueDisplay = document.getElementById('threshold-value-display') as HTMLElement;
const previewIncludeCount = document.getElementById('preview-include-count') as HTMLElement;
const previewIncludePercent = document.getElementById('preview-include-percent') as HTMLElement;
const previewExcludeCount = document.getElementById('preview-exclude-count') as HTMLElement;
const previewExcludePercent = document.getElementById('preview-exclude-percent') as HTMLElement;
const toggleDistributionBtn = document.getElementById('toggle-distribution-btn') as HTMLButtonElement;
const distributionChart = document.getElementById('distribution-chart') as HTMLElement;
const confirmThresholdBtn = document.getElementById('confirm-threshold-btn') as HTMLButtonElement;
const executionHistory = document.getElementById('execution-history') as HTMLElement;

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

// 設定セクション
const settingsSection = document.getElementById('settings-section') as HTMLElement;
const settingsBtnProject = document.getElementById('settings-btn-project') as HTMLButtonElement;
const settingsBtnScreening = document.getElementById('settings-btn-screening') as HTMLButtonElement;
const closeSettingsBtn = document.getElementById('close-settings-btn') as HTMLButtonElement;
const autoNavigateCheckbox = document.getElementById('auto-navigate-checkbox') as HTMLInputElement;
const showRecordCountCheckbox = document.getElementById('show-record-count-checkbox') as HTMLInputElement;
const termFilterAndCheckbox = document.getElementById('term-filter-and-checkbox') as HTMLInputElement;
const recordCountAbove = document.getElementById('record-count-above') as HTMLElement;
const navProgress = document.getElementById('nav-progress') as HTMLElement;

async function initApp() {
    try {
        showLoading(true);

        // 設定を読み込み
        await loadUserSettings();

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

    // 設定
    settingsBtnProject.addEventListener('click', showSettings);
    settingsBtnScreening.addEventListener('click', showSettings);
    closeSettingsBtn.addEventListener('click', hideSettings);
    autoNavigateCheckbox.addEventListener('change', handleAutoNavigateChange);
    showRecordCountCheckbox.addEventListener('change', handleShowRecordCountChange);
    termFilterAndCheckbox.addEventListener('change', handleTermFilterAndChange);

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

    // エクスポートメニュー
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.classList.toggle('hidden');
    });

    // CSV エクスポート
    exportCsvBtn.addEventListener('click', () => {
        exportMenu.classList.add('hidden');
        handleExportCSV();
    });

    // RIS エクスポート
    exportRisBtn.addEventListener('click', () => {
        exportMenu.classList.add('hidden');
        handleExportRIS();
    });

    // メニュー外クリックで閉じる
    document.addEventListener('click', (e) => {
        if (!exportMenu.contains(e.target as Node) && e.target !== exportBtn) {
            exportMenu.classList.add('hidden');
        }
    });

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

    // タームクリックフィルター（イベント委譲）
    document.getElementById('reference-detail')?.addEventListener('click', handleTermClick);

    // タームフィルター削除イベント
    activeTermFiltersDiv?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.classList.contains('remove-btn')) {
            const term = target.dataset.term;
            const type = target.dataset.type;
            if (term && type) {
                removeTermFilter(term, type);
            }
        }
    });

    // LLMタブ関連
    setupLlmEventListeners();
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
    llmSection.classList.add('hidden');
    headerTabs?.classList.add('hidden');
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

        // スプレッドシート形式の検証
        const validation = await validateSpreadsheetFormat(selectedId);
        if (!validation.valid) {
            showStatus(validation.error || '対応していない形式です', 'error');
            return;
        }

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
        headerTabs?.classList.remove('hidden');

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

    // タームフィルター（AND/OR条件）
    if (activeTermFilters.length > 0) {
        if (termFilterUseAnd) {
            // AND条件: すべてのtermにマッチ
            for (const termFilter of activeTermFilters) {
                const regex = createSmartRegex(termFilter.term);
                filtered = filtered.filter(r => {
                    const text = `${r.title} ${r.abstract || ''}`;
                    return regex.test(text);
                });
            }
        } else {
            // OR条件: いずれかのtermにマッチ
            filtered = filtered.filter(r => {
                const text = `${r.title} ${r.abstract || ''}`;
                return activeTermFilters.some(termFilter => {
                    const regex = createSmartRegex(termFilter.term);
                    return regex.test(text);
                });
            });
        }
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
        filterResultCount.textContent = `0件中 0件目`;

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

    const searchKeyword = searchInput.value.trim();
    refTitle.innerHTML = highlightText(ref.title, searchKeyword);
    refAuthors.textContent = ref.authors || '';
    refYear.textContent = ref.year?.toString() || '';
    refJournal.textContent = ref.journal || '';
    refAbstract.innerHTML = highlightText(ref.abstract || '(抄録なし)', searchKeyword);

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
    filterResultCount.textContent = `${filtered.length}件中 ${currentIndex + 1}件目`;

    // レコード件数表示
    // 全体に対する判定済み件数を計算（フィルターではなく全体）
    const labeledCount = references.filter((r) => r.status !== 'pending' && r.status !== 'conflict').length;
    const totalCount = references.length;
    const remainingCount = totalCount - labeledCount;
    const progressPercent = totalCount > 0 ? Math.round((labeledCount / totalCount) * 100) : 0;

    // 進捗率に応じた励ましメッセージ
    let encourageMessage = '';
    if (totalCount === 0) {
        encourageMessage = '文献をインポートしてください 📂';
    } else if (progressPercent === 0) {
        encourageMessage = 'さあ、始めましょう！💪';
    } else if (progressPercent <= 25) {
        encourageMessage = '順調なスタートです！🚀';
    } else if (progressPercent <= 50) {
        encourageMessage = 'いいペースです！半分まであと少し 📈';
    } else if (progressPercent <= 75) {
        encourageMessage = '折り返し地点を過ぎました！🎯';
    } else if (progressPercent < 100) {
        encourageMessage = 'ゴールが見えてきました！✨';
    } else {
        encourageMessage = '完了しました！お疲れ様でした 🎉';
    }

    const recordCountHtml = `
        <div class="record-count-main">${labeledCount} / ${totalCount}件（残り${remainingCount}件）</div>
        <div class="record-count-encourage">${encourageMessage}</div>
    `;

    // 設定に応じて表示位置を切り替え
    console.log('[renderCurrentReference] showRecordCountBelow =', showRecordCountBelow);
    if (showRecordCountBelow) {
        // チェックON: 下部ナビゲーションに表示（デフォルト）
        console.log('[renderCurrentReference] → 下部ナビに表示');
        navProgress.innerHTML = `
            <div class="nav-progress-main">${labeledCount} / ${totalCount}件（残り${remainingCount}件）</div>
            <div class="nav-progress-encourage">${encourageMessage}</div>
        `;
        navProgress.classList.remove('hidden');
        recordCountAbove.classList.add('hidden');
    } else {
        // チェックOFF: タイトル上に表示
        console.log('[renderCurrentReference] → タイトル上に表示');
        recordCountAbove.innerHTML = recordCountHtml;
        recordCountAbove.classList.remove('hidden');
        navProgress.classList.add('hidden');
    }
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

/**
 * 特定の文献を直接表示する（フィルター無視）
 * 自動遷移オフの場合に使用
 */
function renderSpecificReference(ref: ReferenceWithStatus) {
    const filtered = getFilteredReferences();

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

    // キーオープン後の不一致表示
    if (isKeyOpened && ref.allDecisions && ref.allDecisions.length > 0) {
        renderAllDecisions(ref);
        allDecisionsDiv.classList.remove('hidden');
        if (ref.hasConflict) {
            conflictBanner.classList.remove('hidden');
        } else {
            conflictBanner.classList.add('hidden');
        }
    } else {
        conflictBanner.classList.add('hidden');
        allDecisionsDiv.classList.add('hidden');
    }

    const searchKeyword = searchInput.value.trim();
    refTitle.innerHTML = highlightText(ref.title, searchKeyword);
    refAuthors.textContent = ref.authors || '';
    refYear.textContent = ref.year?.toString() || '';
    refJournal.textContent = ref.journal || '';
    refAbstract.innerHTML = highlightText(ref.abstract || '(抄録なし)', searchKeyword);

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

    // ナビゲーション表示（判定済みを示す特別表示）
    navPosition.textContent = `(判定済み) ${currentIndex + 1} / ${filtered.length}`;
    progressText.textContent = `${references.filter((r) => r.status !== 'pending' && r.status !== 'conflict').length} / ${references.length}`;

    // フィルターの件数を更新
    updateFilterCounts();

    // メモをそのまま保持（リセットしない）
    // noteInput.value = ref.myDecision?.note || '';

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

    // 現在の参照IDを保持（自動遷移オフの場合に使用）
    const currentRefId = ref.ref_id;

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

    // 次の文献へ（自動遷移設定が有効な場合のみ）
    console.log('[handleDecision] autoNavigateAfterDecision:', autoNavigateAfterDecision);
    if (autoNavigateAfterDecision) {
        // 自動遷移オン: UIを更新して次へ
        renderCurrentReference();
        navigate(1);
    } else {
        // 自動遷移オフ: 同じ文献に留まる
        // フィルター結果ではなく、判定した文献を直接表示
        renderSpecificReference(ref);
    }

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
function highlightText(text: string, searchKeyword?: string): string {
    if (!text) return '';
    let result = escapeHtml(text);

    // 検索キーワード（橙）- 優先度最低
    if (searchKeyword && searchKeyword.trim()) {
        const regex = createSmartRegex(searchKeyword.trim());
        result = result.replace(regex, '<mark class="highlight-search">$1</mark>');
    }

    // 除外キーワード（赤）- クリック可能に
    for (const kw of highlightKeywords.exclude) {
        if (!kw) continue;
        const regex = createSmartRegex(kw);
        const escapedKw = escapeHtml(kw);
        result = result.replace(regex, `<mark class="highlight-exclude" data-term="${escapedKw}" data-type="exclude">$1</mark>`);
    }

    // 組み入れキーワード（緑）- クリック可能に
    for (const kw of highlightKeywords.include) {
        if (!kw) continue;
        const regex = createSmartRegex(kw);
        const escapedKw = escapeHtml(kw);
        result = result.replace(regex, `<mark class="highlight-include" data-term="${escapedKw}" data-type="include">$1</mark>`);
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
 * ハイライトされたタームのクリックハンドラ
 */
function handleTermClick(event: Event) {
    const target = event.target as HTMLElement;
    if (!target.matches('mark.highlight-include, mark.highlight-exclude')) return;

    const term = target.dataset.term;
    const type = target.dataset.type as 'include' | 'exclude';

    if (!term) return;

    // 既に追加されていなければ追加
    if (!activeTermFilters.some(f => f.term === term && f.type === type)) {
        activeTermFilters.push({ term, type });
        renderActiveTermFilters();
        currentIndex = 0;
        renderCurrentReference();
        showToast(`"${term}" でフィルター適用`);
    }
}

/**
 * アクティブなタームフィルターを描画
 */
function renderActiveTermFilters() {
    if (!activeTermFiltersDiv) return;
    activeTermFiltersDiv.innerHTML = '';
    for (const filter of activeTermFilters) {
        const tag = document.createElement('span');
        tag.className = `term-filter-tag ${filter.type}`;
        tag.innerHTML = `${escapeHtml(filter.term)}<span class="remove-btn" data-term="${escapeHtml(filter.term)}" data-type="${filter.type}">×</span>`;
        activeTermFiltersDiv.appendChild(tag);
    }
}

/**
 * タームフィルターを削除
 */
function removeTermFilter(term: string, type: string) {
    activeTermFilters = activeTermFilters.filter(f => !(f.term === term && f.type === type));
    renderActiveTermFilters();
    currentIndex = 0;
    renderCurrentReference();
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
        span.style.cursor = 'pointer';
        span.title = `クリックで「${word}」でフィルター`;
        span.innerHTML = `<span class="keyword-text">${escapeHtml(word)}</span><span class="remove-keyword">✕</span>`;

        // タグ本体クリックでフィルター適用
        span.querySelector('.keyword-text')?.addEventListener('click', () => {
            if (!activeTermFilters.some(f => f.term === word && f.type === type)) {
                activeTermFilters.push({ term: word, type });
                renderActiveTermFilters();
                currentIndex = 0;
                renderCurrentReference();
                showToast(`"${word}" でフィルター適用`);
            }
        });

        // ×ボタンクリックでキーワード削除
        span.querySelector('.remove-keyword')?.addEventListener('click', (e) => {
            e.stopPropagation();
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
        if (!confirm('Blind onを実行しますか？\n他のレビュアーの判定が見えなくなり、不一致表示も非表示になります。')) {
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

            showToast('Blind onを実行しました');
        } catch (error) {
            console.error('Key close error:', error);
            alert(`Blind onエラー: ${(error as Error).message}`);
            // エラー時は元の状態に戻す
            keyToggleInput.checked = true;
        } finally {
            showLoading(false);
        }

    } else {
        // OPEN処理 (OFF -> ON)
        if (!confirm('Blind offを実行しますか？\n全レビュアーの判定が相互に見えるようになり、不一致が表示されます。')) {
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

            showToast('Blind offを実行しました');
        } catch (error) {
            console.error('Key open error:', error);
            alert(`Blind offエラー: ${(error as Error).message}`);
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


/**
 * フィルター結果をRIS形式でエクスポート
 */
async function handleExportRIS() {
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
            console.log('[handleExportRIS] Could not get spreadsheet title');
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
        const filename = `${projectTitle}_${filterLabel}_${dateStr}_${filtered.length}件.ris`;

        // RISデータを構築
        const risLines: string[] = [];

        for (const ref of filtered) {
            // レコード開始 (TY - JOUR: Journal Article として固定)
            risLines.push('TY  - JOUR');

            // タイトル
            if (ref.title) {
                risLines.push(`TI  - ${ref.title}`);
            }

            // 著者 (複数の場合セミコロン区切りで分割)
            if (ref.authors) {
                const authors = ref.authors.split(/;\s*/);
                for (const author of authors) {
                    if (author && author !== 'et al.') {
                        risLines.push(`AU  - ${author.trim()}`);
                    }
                }
            }

            // 年
            if (ref.year) {
                risLines.push(`PY  - ${ref.year}`);
            }

            // ジャーナル
            if (ref.journal) {
                risLines.push(`JO  - ${ref.journal}`);
            }

            // 巻
            if (ref.volume) {
                risLines.push(`VL  - ${ref.volume}`);
            }

            // 号
            if (ref.issue) {
                risLines.push(`IS  - ${ref.issue}`);
            }

            // ページ
            if (ref.pages) {
                // pages が "123-456" 形式なら SP/EP に分割
                const pageMatch = ref.pages.match(/^(\d+)\s*-\s*(\d+)$/);
                if (pageMatch) {
                    risLines.push(`SP  - ${pageMatch[1]}`);
                    risLines.push(`EP  - ${pageMatch[2]}`);
                } else {
                    risLines.push(`SP  - ${ref.pages}`);
                }
            }

            // ISSN
            if (ref.issn) {
                risLines.push(`SN  - ${ref.issn}`);
            }

            // DOI
            if (ref.doi) {
                risLines.push(`DO  - ${ref.doi}`);
            }

            // PMID
            if (ref.pmid) {
                risLines.push(`AN  - ${ref.pmid}`);
            }

            // 抄録
            if (ref.abstract) {
                risLines.push(`AB  - ${ref.abstract}`);
            }

            // URL (PubMed論文の場合)
            if (ref.pmid) {
                risLines.push(`UR  - https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`);
            } else if (ref.doi) {
                risLines.push(`UR  - https://doi.org/${ref.doi}`);
            }

            // メモ (note) をノートフィールドに
            if (ref.myDecision?.note) {
                risLines.push(`N1  - ${ref.myDecision.note}`);
            }

            // 判定ステータスをカスタムフィールドに
            if (ref.status) {
                risLines.push(`C1  - Status: ${ref.status}`);
            }

            // レコード終了
            risLines.push('ER  - ');
            risLines.push(''); // 空行でレコード区切り
        }

        const risContent = risLines.join('\r\n');

        // BOM付きUTF-8でBlob作成
        const bom = '\uFEFF';
        const blob = new Blob([bom + risContent], { type: 'application/x-research-info-systems;charset=utf-8' });

        // ダウンロード
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`${filtered.length}件をRIS形式で出力しました`);
    } catch (error) {
        console.error('[handleExportRIS] Error:', error);
        showToast('RISエクスポートに失敗しました');
    }
}


// ========== 設定関連関数 ==========

/**
 * 設定画面を表示
 */
function showSettings() {
    configSection.classList.add('hidden');
    screeningSection.classList.add('hidden');
    settingsSection.classList.remove('hidden');
}

/**
 * 設定画面を閉じる
 */
function hideSettings() {
    settingsSection.classList.add('hidden');

    // 前に表示していた画面に戻る
    if (spreadsheetId) {
        screeningSection.classList.remove('hidden');
    } else {
        configSection.classList.remove('hidden');
    }
}

/**
 * 自動遷移設定の変更を処理
 */
async function handleAutoNavigateChange() {
    autoNavigateAfterDecision = autoNavigateCheckbox.checked;
    console.log('[handleAutoNavigateChange] 設定変更:', autoNavigateAfterDecision);
    await saveUserSettings();
    showToast(autoNavigateAfterDecision
        ? '判断後に自動的に次の文献に遷移します'
        : '判断後は手動で遷移してください');
}

/**
 * ユーザー設定を保存
 */
async function saveUserSettings() {
    console.log('[saveUserSettings] 保存:', { autoNavigateAfterDecision, showRecordCountBelow, termFilterUseAnd });
    await chrome.storage.local.set({
        autoNavigateAfterDecision,
        showRecordCountBelow,
        termFilterUseAnd
    });
}

/**
 * ユーザー設定を読み込み
 */
async function loadUserSettings() {
    const result = await chrome.storage.local.get(['autoNavigateAfterDecision', 'showRecordCountBelow', 'termFilterUseAnd']);
    console.log('[loadUserSettings] 読み込み:', result);

    // デフォルトはtrue（自動遷移する）
    if (result.autoNavigateAfterDecision !== undefined) {
        autoNavigateAfterDecision = result.autoNavigateAfterDecision;
    } else {
        autoNavigateAfterDecision = true;
    }

    // デフォルトはtrue（タイトル下に表示）
    if (result.showRecordCountBelow !== undefined) {
        showRecordCountBelow = result.showRecordCountBelow;
    } else {
        showRecordCountBelow = true;
    }

    // デフォルトはtrue（AND検索）
    if (result.termFilterUseAnd !== undefined) {
        termFilterUseAnd = result.termFilterUseAnd;
    } else {
        termFilterUseAnd = true;
    }

    // チェックボックスの状態を更新
    autoNavigateCheckbox.checked = autoNavigateAfterDecision;
    showRecordCountCheckbox.checked = showRecordCountBelow;
    termFilterAndCheckbox.checked = termFilterUseAnd;
    console.log('[loadUserSettings] 設定完了:', { autoNavigateAfterDecision, showRecordCountBelow, termFilterUseAnd });
}

/**
 * レコード件数表示設定の変更を処理
 */
async function handleShowRecordCountChange() {
    showRecordCountBelow = showRecordCountCheckbox.checked;
    console.log('[handleShowRecordCountChange] 設定変更:', showRecordCountBelow);
    await saveUserSettings();

    // 表示を即時更新
    if (spreadsheetId) {
        renderCurrentReference();
    }

    showToast(showRecordCountBelow
        ? 'レコード件数をタイトル下に表示します'
        : 'レコード件数をタイトル上に移動しました');
}

/**
 * ターム検索AND/OR設定の変更を処理
 */
async function handleTermFilterAndChange() {
    termFilterUseAnd = termFilterAndCheckbox.checked;
    console.log('[handleTermFilterAndChange] 設定変更:', termFilterUseAnd);
    await saveUserSettings();

    // フィルターが適用中なら即時反映
    if (spreadsheetId && activeTermFilters.length > 0) {
        currentIndex = 0;
        renderCurrentReference();
    }

    showToast(termFilterUseAnd
        ? '複数キーワード選択時: AND検索'
        : '複数キーワード選択時: OR検索');
}

// ========== LLM処理関連関数 ==========

/**
 * LLMイベントリスナーを設定
 */
function setupLlmEventListeners() {
    // タブ切り替え
    tabScreeningBtn?.addEventListener('click', () => switchToTab('screening'));
    tabLlmBtn?.addEventListener('click', () => switchToTab('llm'));

    // LLM戻るボタン
    llmBackBtn?.addEventListener('click', handleLlmBack);

    // APIキー関連
    toggleApiKeyVisibilityBtn?.addEventListener('click', toggleApiKeyVisibility);
    geminiApiKeyInput?.addEventListener('change', handleApiKeyAutoSave);
    saveApiKeyCheckbox?.addEventListener('change', handleSavePreferenceChange);

    // 基準最適化
    optimizeCriteriaBtn?.addEventListener('click', handleOptimizeCriteria);
    saveCriteriaBtn?.addEventListener('click', handleSaveCriteria);

    // バッチ処理
    startBatchBtn?.addEventListener('click', handleStartBatch);
    stopBatchBtn?.addEventListener('click', handleStopBatch);

    // 閾値調整
    thresholdSlider?.addEventListener('input', handleThresholdChange);
    toggleDistributionBtn?.addEventListener('click', toggleDistributionChart);
    confirmThresholdBtn?.addEventListener('click', handleConfirmThreshold);

    // 折りたたみセクション
    document.querySelectorAll('.llm-card.collapsible .collapsible-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.llm-card.collapsible');
            card?.classList.toggle('collapsed');
        });
    });
}

/**
 * タブを切り替え
 */
function switchToTab(tab: 'screening' | 'llm') {
    currentTab = tab;

    if (tab === 'screening') {
        tabScreeningBtn?.classList.add('active');
        tabLlmBtn?.classList.remove('active');
        screeningSection.classList.remove('hidden');
        llmSection?.classList.add('hidden');
    } else {
        tabScreeningBtn?.classList.remove('active');
        tabLlmBtn?.classList.add('active');
        screeningSection.classList.add('hidden');
        llmSection?.classList.remove('hidden');

        // LLMセクションを初期化
        initializeLlmSection();
    }
}

/**
 * LLMセクションを初期化
 */
async function initializeLlmSection() {
    try {
        // APIキーの状態を確認
        await loadApiKeyStatus();

        // LLM設定を読み込み
        if (spreadsheetId) {
            llmConfig = await getLlmConfig(spreadsheetId);

            // UI更新
            llmModelSelect.value = llmConfig.llm_model;
            llmLanguageSelect.value = llmConfig.llm_output_language;
            protocolTextInput.value = llmConfig.llm_protocol_text;
            thresholdSlider.value = llmConfig.llm_include_threshold.toString();
            thresholdValueDisplay.textContent = llmConfig.llm_include_threshold.toFixed(2);

            // 既存の基準があれば表示
            if (llmConfig.llm_criteria) {
                renderOptimizedCriteria(llmConfig.llm_criteria, llmConfig.llm_screening_prompt);
            }

            // バッチ対象件数を更新
            updateBatchTargetCount();

            // 実行履歴を読み込み
            await loadExecutionHistory();
        }
    } catch (error) {
        console.error('[initializeLlmSection] Error:', error);
    }
}

/**
 * APIキーの状態を読み込み
 */
async function loadApiKeyStatus() {
    const hasKey = await hasGeminiApiKey();
    const savePreference = await getApiKeySavePreference();

    saveApiKeyCheckbox.checked = savePreference;

    if (hasKey) {
        const key = await getGeminiApiKey();
        if (key) {
            geminiApiKeyInput.value = key;
            apiKeyStatus.textContent = '✓ APIキーが設定されています';
            apiKeyStatus.className = 'api-key-status success';
        }
    } else {
        apiKeyStatus.textContent = '';
        apiKeyStatus.className = 'api-key-status';
    }
}

/**
 * APIキー表示/非表示切り替え
 */
function toggleApiKeyVisibility() {
    if (geminiApiKeyInput.type === 'password') {
        geminiApiKeyInput.type = 'text';
        toggleApiKeyVisibilityBtn.textContent = '🙈';
    } else {
        geminiApiKeyInput.type = 'password';
        toggleApiKeyVisibilityBtn.textContent = '👁';
    }
}

/**
 * APIキー入力時の自動保存（チェックボックスがONの場合）
 */
async function handleApiKeyAutoSave() {
    const apiKey = geminiApiKeyInput.value.trim();
    if (!apiKey) {
        apiKeyStatus.textContent = '';
        return;
    }

    apiKeyStatus.textContent = '検証中...';
    apiKeyStatus.className = 'api-key-status';

    // APIキーを検証
    const isValid = await testApiKey(apiKey);
    if (!isValid) {
        apiKeyStatus.textContent = '✕ 無効なAPIキーです';
        apiKeyStatus.className = 'api-key-status error';
        return;
    }

    // 保存設定に応じて保存
    const shouldSave = saveApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveGeminiApiKey(apiKey);
        await setApiKeySavePreference(true);
        apiKeyStatus.textContent = '✓ APIキーを保存しました';
    } else {
        setSessionApiKey(apiKey);
        apiKeyStatus.textContent = '✓ APIキーを設定しました（セッション限り）';
    }
    apiKeyStatus.className = 'api-key-status success';
}

/**
 * 保存設定チェックボックスの変更処理
 */
async function handleSavePreferenceChange() {
    const shouldSave = saveApiKeyCheckbox.checked;
    await setApiKeySavePreference(shouldSave);

    const apiKey = geminiApiKeyInput.value.trim();
    if (!apiKey) return;

    if (shouldSave) {
        // 現在のAPIキーを保存
        await saveGeminiApiKey(apiKey);
        apiKeyStatus.textContent = '✓ APIキーを保存しました';
        apiKeyStatus.className = 'api-key-status success';
    } else {
        // 保存済みキーを削除してセッションキーに切り替え
        await removeGeminiApiKey();
        setSessionApiKey(apiKey);
        apiKeyStatus.textContent = '✓ セッション限りの設定に変更しました';
        apiKeyStatus.className = 'api-key-status success';
    }
}

/**
 * LLM戻るボタン
 */
function handleLlmBack() {
    switchToTab('screening');
    handleBack();
}

/**
 * 基準を最適化
 */
async function handleOptimizeCriteria() {
    const protocolText = protocolTextInput.value.trim();
    if (!protocolText) {
        showToast('プロトコルのテキストを入力してください');
        return;
    }

    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast('APIキーを設定してください');
        return;
    }

    try {
        optimizeCriteriaBtn.disabled = true;
        optimizeStatusDiv.textContent = '🔄 基準を最適化中...';
        optimizeStatusDiv.className = 'optimize-status loading';
        optimizeStatusDiv.classList.remove('hidden');

        const modelConfig: GeminiModelConfig = {
            model: llmModelSelect.value,
            temperature: 0,
            maxOutputTokens: 2048,
        };

        const result = await convertCriteria(
            protocolText,
            modelConfig,
            llmLanguageSelect.value
        );

        // 結果を表示
        renderOptimizedCriteria(result.criteria, result.screening_prompt);

        // 設定を更新
        llmConfig.llm_criteria = result.criteria;
        llmConfig.llm_screening_prompt = result.screening_prompt;
        llmConfig.llm_protocol_text = protocolText;

        optimizeStatusDiv.textContent = '✓ 最適化完了';
        optimizeStatusDiv.className = 'optimize-status success';

        // 保存ボタンを表示
        saveCriteriaBtn.classList.remove('hidden');
    } catch (error) {
        console.error('[handleOptimizeCriteria] Error:', error);
        optimizeStatusDiv.textContent = `✕ エラー: ${(error as Error).message}`;
        optimizeStatusDiv.className = 'optimize-status error';
    } finally {
        optimizeCriteriaBtn.disabled = false;
    }
}

/**
 * 最適化された基準を表示
 */
function renderOptimizedCriteria(criteria: LlmCriteria, screeningPrompt: string) {
    optimizedCriteriaDisplay.innerHTML = '';

    // PICO形式で表示
    const templateLabel = {
        'pico': 'PICO',
        'peco': 'PECO',
        'spider': 'SPIDER',
        'custom': 'カスタム',
    }[criteria.template] || criteria.template;

    const templateDiv = document.createElement('div');
    templateDiv.className = 'criteria-field';
    templateDiv.innerHTML = `<strong>テンプレート:</strong> ${templateLabel}`;
    optimizedCriteriaDisplay.appendChild(templateDiv);

    for (const [key, value] of Object.entries(criteria.fields)) {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'criteria-field';
        fieldDiv.innerHTML = `<strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}`;
        optimizedCriteriaDisplay.appendChild(fieldDiv);
    }

    // スクリーニングプロンプトを設定
    screeningPromptInput.value = screeningPrompt;
    screeningPromptInput.classList.remove('hidden');
}

/**
 * 基準を保存
 */
async function handleSaveCriteria() {
    try {
        saveCriteriaBtn.disabled = true;

        await updateLlmConfig(spreadsheetId, {
            llm_protocol_text: protocolTextInput.value,
            llm_criteria: llmConfig.llm_criteria,
            llm_screening_prompt: screeningPromptInput.value,
            llm_model: llmModelSelect.value,
            llm_output_language: llmLanguageSelect.value,
        });

        showToast('基準を保存しました');
    } catch (error) {
        console.error('[handleSaveCriteria] Error:', error);
        showToast('保存に失敗しました');
    } finally {
        saveCriteriaBtn.disabled = false;
    }
}

/**
 * バッチ対象件数を更新
 */
function updateBatchTargetCount() {
    // 常に未判定のみを対象
    const count = references.filter(r => r.status === 'pending').length;
    batchTargetCount.textContent = count.toString();
}

/**
 * バッチ処理を開始
 */
async function handleStartBatch() {
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast('APIキーを設定してください');
        return;
    }

    const screeningPrompt = screeningPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    if (!screeningPrompt) {
        showToast('スクリーニング基準を設定してください');
        return;
    }

    // 対象文献を取得（常に未判定全件）
    const targetRefs = references.filter(r => r.status === 'pending');

    if (targetRefs.length === 0) {
        showToast('処理対象の文献がありません');
        return;
    }

    // UI更新
    startBatchBtn.classList.add('hidden');
    stopBatchBtn.classList.remove('hidden');
    batchProgressDiv.classList.remove('hidden');
    thresholdSection.classList.add('hidden');

    // AbortControllerを作成
    batchAbortController = new AbortController();
    currentBatchDecisions = [];

    try {
        const saveBatchSize = Math.max(parseInt(batchSaveSizeInput.value, 10) || 5, 1);
        const result = await processBatch(targetRefs, {
            batchSize: saveBatchSize,
            screeningPrompt,
            model: llmModelSelect.value,
            temperature: 0,
            maxOutputTokens: 2048,
            outputLanguage: llmLanguageSelect.value,
            abortSignal: batchAbortController.signal,
            onProgress: updateBatchProgress,
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                currentBatchDecisions.push(...decisions);
            },
        });

        currentExecutionId = result.executionId;

        // 完了後のUI更新
        if (!batchAbortController.signal.aborted) {
            thresholdProcessedCount.textContent = result.successCount.toString();
            thresholdSection.classList.remove('hidden');

            // 閾値プレビューを更新
            handleThresholdChange();
        }
    } catch (error) {
        console.error('[handleStartBatch] Error:', error);
        showToast(`バッチ処理エラー: ${(error as Error).message}`);
    } finally {
        startBatchBtn.classList.remove('hidden');
        stopBatchBtn.classList.add('hidden');
        batchAbortController = null;
    }
}

/**
 * バッチ処理を中止
 */
function handleStopBatch() {
    if (batchAbortController) {
        batchAbortController.abort();
        showToast('バッチ処理を中止しました');
    }
}

/**
 * バッチ進捗を更新
 */
function updateBatchProgress(progress: LlmBatchProgress) {
    batchProgressCurrent.textContent = progress.processed.toString();
    batchProgressTotal.textContent = progress.total.toString();

    const percent = progress.total > 0
        ? Math.round((progress.processed / progress.total) * 100)
        : 0;
    batchProgressPercent.textContent = percent.toString();
    batchProgressBarFill.style.width = `${percent}%`;

    batchSuccessCount.textContent = progress.succeeded.toString();
    batchFailCount.textContent = progress.failed.toString();
}

/**
 * 閾値変更時の処理
 */
function handleThresholdChange() {
    const threshold = parseFloat(thresholdSlider.value);
    thresholdValueDisplay.textContent = threshold.toFixed(2);

    // プレビューを更新
    const counts = previewThresholdCounts(currentBatchDecisions, threshold);
    const total = counts.includeCount + counts.excludeCount;

    previewIncludeCount.textContent = counts.includeCount.toString();
    previewExcludeCount.textContent = counts.excludeCount.toString();

    if (total > 0) {
        previewIncludePercent.textContent = Math.round((counts.includeCount / total) * 100).toString();
        previewExcludePercent.textContent = Math.round((counts.excludeCount / total) * 100).toString();
    } else {
        previewIncludePercent.textContent = '-';
        previewExcludePercent.textContent = '-';
    }
}

/**
 * 分布チャートの表示/非表示
 */
function toggleDistributionChart() {
    distributionChart.classList.toggle('hidden');

    if (!distributionChart.classList.contains('hidden')) {
        renderDistributionChart();
    }
}

/**
 * 分布チャートを描画
 */
function renderDistributionChart() {
    const distribution = calculateProbabilityDistribution(currentBatchDecisions, 5);
    const maxCount = Math.max(...distribution.map(d => d.count), 1);

    distributionChart.innerHTML = '';

    for (const bin of distribution) {
        const container = document.createElement('div');
        container.className = 'distribution-bar-container';

        const label = document.createElement('span');
        label.className = 'distribution-label';
        label.textContent = bin.range;

        const barWrapper = document.createElement('div');
        barWrapper.className = 'distribution-bar-wrapper';

        const bar = document.createElement('div');
        bar.className = 'distribution-bar';
        bar.style.width = `${(bin.count / maxCount) * 100}%`;
        barWrapper.appendChild(bar);

        const count = document.createElement('span');
        count.className = 'distribution-count';
        count.textContent = `${bin.count}件`;

        container.appendChild(label);
        container.appendChild(barWrapper);
        container.appendChild(count);
        distributionChart.appendChild(container);
    }
}

/**
 * 閾値を確定して保存
 */
async function handleConfirmThreshold() {
    const threshold = parseFloat(thresholdSlider.value);

    try {
        confirmThresholdBtn.disabled = true;
        showToast('保存中...');

        // 閾値を適用してdecisionを確定
        const updatedDecisions = applyThresholdToDecisions(currentBatchDecisions, threshold);

        // Decisionsシートの行を取得して更新
        const existingDecisions = await getDecisionsByReviewerId(spreadsheetId, currentExecutionId);

        const updates: { rowIndex: number; decision: Decision }[] = [];
        for (const updated of updatedDecisions) {
            const existing = existingDecisions.find(e => e.decision.ref_id === updated.ref_id);
            if (existing) {
                updates.push({ rowIndex: existing.rowIndex, decision: updated });
            }
        }

        if (updates.length > 0) {
            await updateDecisionsBatch(spreadsheetId, updates);
        }

        // 実行履歴を保存
        const counts = previewThresholdCounts(currentBatchDecisions, threshold);
        const execution = createLlmExecution(
            currentExecutionId,
            'batch_screening',
            llmModelSelect.value,
            llmConfig.llm_criteria,
            screeningPromptInput.value,
            threshold,
            currentBatchDecisions.length,
            counts.includeCount,
            counts.excludeCount
        );
        await saveLlmExecution(spreadsheetId, execution);

        // LLM設定を更新
        await updateLlmConfig(spreadsheetId, {
            llm_include_threshold: threshold,
        });

        showToast('閾値を確定して保存しました');

        // データを再読み込み
        await loadDataAndShowScreening();

        // 実行履歴を更新
        await loadExecutionHistory();
    } catch (error) {
        console.error('[handleConfirmThreshold] Error:', error);
        showToast(`保存エラー: ${(error as Error).message}`);
    } finally {
        confirmThresholdBtn.disabled = false;
    }
}

/**
 * 実行履歴を読み込み
 */
async function loadExecutionHistory() {
    try {
        const executions = await getLlmExecutions(spreadsheetId);

        if (executions.length === 0) {
            executionHistory.innerHTML = '<p class="placeholder-text">実行履歴がありません</p>';
            return;
        }

        executionHistory.innerHTML = '';

        // 新しい順にソート
        const sorted = [...executions].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        for (const exec of sorted.slice(0, 10)) {
            const item = document.createElement('div');
            item.className = 'execution-item';

            const date = new Date(exec.timestamp);
            const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

            const typeLabel = exec.execution_type === 'batch_screening' ? 'バッチ' : '基準生成';

            item.innerHTML = `
                <div class="execution-date">
                    <span class="execution-type">${typeLabel}</span>
                    ${dateStr}
                </div>
                <div class="execution-stats">
                    ${exec.target_count}件処理 → Include: ${exec.include_count}件, Exclude: ${exec.exclude_count}件
                    (閾値: ${exec.include_threshold.toFixed(2)})
                </div>
            `;
            executionHistory.appendChild(item);
        }
    } catch (error) {
        console.error('[loadExecutionHistory] Error:', error);
    }
}

export { };
