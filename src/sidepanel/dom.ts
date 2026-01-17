/**
 * DOM要素の型付きレジストリ
 * sidepanel.htmlの全DOM要素を一元管理し、型安全なアクセスを提供
 */

// ヘルパー関数: 要素取得（nullの場合はエラー）
function getElement<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(`DOM element not found: #${id}`);
    }
    return el as T;
}

// ヘルパー関数: querySelector（nullの場合はエラー）
function querySelector<T extends HTMLElement>(selector: string): T {
    const el = document.querySelector(selector);
    if (!el) {
        throw new Error(`DOM element not found: ${selector}`);
    }
    return el as T;
}

// 遅延初期化用のプロキシ（DOMContentLoaded後に初期化）
let _domCache: typeof domElements | null = null;

const domElements = {
    // ========== Config/Project Section ==========
    get configSection() { return getElement<HTMLElement>('config-section'); },
    get spreadsheetInput() { return getElement<HTMLInputElement>('spreadsheet-input'); },
    get recentSheetsSelect() { return getElement<HTMLSelectElement>('recent-sheets'); },
    get connectBtn() { return getElement<HTMLButtonElement>('connect-btn'); },
    get createBtn() { return getElement<HTMLButtonElement>('create-btn'); },
    get userInfoDiv() { return getElement<HTMLElement>('user-info'); },
    get statusMessage() { return getElement<HTMLElement>('status-message'); },
    get loadingDiv() { return getElement<HTMLElement>('loading'); },

    // ========== Login/Logout Section ==========
    get loginSection() { return getElement<HTMLElement>('login-section'); },
    get projectSection() { return getElement<HTMLElement>('project-section'); },
    get loginBtn() { return getElement<HTMLButtonElement>('login-btn'); },
    get logoutBtn() { return getElement<HTMLButtonElement>('logout-btn'); },

    // ========== Screening Section ==========
    get screeningSection() { return getElement<HTMLElement>('screening-section'); },
    get statusFilter() { return getElement<HTMLSelectElement>('status-filter'); },
    get searchInput() { return getElement<HTMLInputElement>('search-input'); },
    get searchResultCount() { return getElement<HTMLElement>('search-result-count'); },
    get filterResultCount() { return getElement<HTMLElement>('filter-result-count'); },

    // Reference display
    get refTitle() { return getElement<HTMLElement>('ref-title'); },
    get refAuthors() { return getElement<HTMLElement>('ref-authors'); },
    get refYear() { return getElement<HTMLElement>('ref-year'); },
    get refJournal() { return getElement<HTMLElement>('ref-journal'); },
    get refAbstract() { return getElement<HTMLElement>('ref-abstract'); },
    get refDoi() { return getElement<HTMLAnchorElement>('ref-doi'); },
    get refPmid() { return getElement<HTMLAnchorElement>('ref-pmid'); },

    // Decision buttons
    get btnInclude() { return getElement<HTMLButtonElement>('btn-include'); },
    get btnMaybe() { return getElement<HTMLButtonElement>('btn-maybe'); },
    get btnExclude() { return getElement<HTMLButtonElement>('btn-exclude'); },
    get noteInput() { return getElement<HTMLTextAreaElement>('note'); },

    // Navigation
    get btnPrev() { return getElement<HTMLButtonElement>('btn-prev'); },
    get btnNext() { return getElement<HTMLButtonElement>('btn-next'); },
    get navPosition() { return getElement<HTMLElement>('nav-position'); },
    get progressText() { return getElement<HTMLElement>('progress-text'); },
    get navProgress() { return getElement<HTMLElement>('nav-progress'); },
    get recordCountAbove() { return getElement<HTMLElement>('record-count-above'); },

    // ========== Source Filters ==========
    get sourceFileListDiv() { return getElement<HTMLElement>('source-file-list'); },
    get sourceFiltersSection() { return getElement<HTMLElement>('source-filters-section'); },
    get activeTermFiltersDiv() { return getElement<HTMLElement>('active-term-filters'); },

    // ========== Import/Export ==========
    get risFileInput() { return getElement<HTMLInputElement>('ris-file'); },
    get importBtn() { return getElement<HTMLButtonElement>('import-btn'); },
    get exportBtn() { return getElement<HTMLButtonElement>('export-btn'); },
    get exportMenu() { return getElement<HTMLElement>('export-menu'); },
    get exportCsvBtn() { return getElement<HTMLButtonElement>('export-csv-btn'); },
    get exportRisBtn() { return getElement<HTMLButtonElement>('export-ris-btn'); },
    get importStatus() { return getElement<HTMLElement>('import-status'); },
    get backBtn() { return getElement<HTMLButtonElement>('back-btn'); },

    // ========== Key Open Section ==========
    get keySection() { return getElement<HTMLElement>('key-section'); },
    get keyToggleInput() { return getElement<HTMLInputElement>('key-toggle-input'); },
    get reviewerFilterContainer() { return getElement<HTMLElement>('reviewer-filter-container'); },
    get conflictBanner() { return getElement<HTMLElement>('conflict-banner'); },
    get allDecisionsDiv() { return getElement<HTMLElement>('all-decisions'); },

    // ========== Highlight Keywords ==========
    get presetRctBtn() { return getElement<HTMLButtonElement>('preset-rct-btn'); },
    get presetSrBtn() { return getElement<HTMLButtonElement>('preset-sr-btn'); },
    get includeKeywordsListDiv() { return getElement<HTMLElement>('include-keywords-list'); },
    get newIncludeInput() { return getElement<HTMLInputElement>('new-include-input'); },
    get addIncludeBtn() { return getElement<HTMLButtonElement>('add-include-btn'); },
    get excludeKeywordsListDiv() { return getElement<HTMLElement>('exclude-keywords-list'); },
    get newExcludeInput() { return getElement<HTMLInputElement>('new-exclude-input'); },
    get addExcludeBtn() { return getElement<HTMLButtonElement>('add-exclude-btn'); },
    get saveStatus() { return getElement<HTMLElement>('save-status'); },
    get toast() { return getElement<HTMLElement>('toast'); },

    // ========== Sharing ==========
    get shareBtn() { return getElement<HTMLButtonElement>('share-btn'); },
    get shareInputArea() { return getElement<HTMLElement>('share-input-area'); },
    get shareEmailInput() { return getElement<HTMLInputElement>('share-email-input'); },
    get shareSubmitBtn() { return getElement<HTMLButtonElement>('share-submit-btn'); },
    get shareCancelBtn() { return getElement<HTMLButtonElement>('share-cancel-btn'); },
    get sharedUsersList() { return getElement<HTMLElement>('shared-users-list'); },

    // ========== Settings ==========
    get settingsSection() { return getElement<HTMLElement>('settings-section'); },
    get settingsBtnProject() { return getElement<HTMLButtonElement>('settings-btn-project'); },
    get settingsBtnScreening() { return getElement<HTMLButtonElement>('settings-btn-screening'); },
    get closeSettingsBtn() { return getElement<HTMLButtonElement>('close-settings-btn'); },
    get autoNavigateCheckbox() { return getElement<HTMLInputElement>('auto-navigate-checkbox'); },
    get showRecordCountCheckbox() { return getElement<HTMLInputElement>('show-record-count-checkbox'); },
    get termFilterAndCheckbox() { return getElement<HTMLInputElement>('term-filter-and-checkbox'); },
    get treatMlAsManualCheckbox() { return getElement<HTMLInputElement>('treat-ml-as-manual-checkbox'); },

    // ========== LLM Section ==========
    get llmSection() { return getElement<HTMLElement>('llm-section'); },
    get tabScreeningBtn() { return getElement<HTMLButtonElement>('tab-screening'); },
    get tabLlmBtn() { return getElement<HTMLButtonElement>('tab-llm'); },
    get tabMlBtn() { return getElement<HTMLButtonElement>('tab-ml'); },
    get headerTabs() { return querySelector<HTMLElement>('.header-tabs'); },
    get llmBackBtn() { return getElement<HTMLButtonElement>('llm-back-btn'); },
    get llmSettingsBtn() { return getElement<HTMLButtonElement>('llm-settings-btn'); },

    // LLM API Key
    get apiKeyCard() { return getElement<HTMLElement>('api-key-card'); },
    get apiKeySummary() { return getElement<HTMLElement>('api-key-summary'); },
    get geminiApiKeyInput() { return getElement<HTMLInputElement>('gemini-api-key'); },
    get toggleApiKeyVisibilityBtn() { return getElement<HTMLButtonElement>('toggle-api-key-visibility'); },
    get saveApiKeyCheckbox() { return getElement<HTMLInputElement>('save-api-key-checkbox'); },
    get apiKeyStatus() { return getElement<HTMLElement>('api-key-status'); },

    // ========== ML Section ==========
    get mlSection() { return getElement<HTMLElement>('ml-section'); },
    get mlSettingsBtn() { return getElement<HTMLButtonElement>('ml-settings-btn'); },
    get mlNoteInput() { return getElement<HTMLTextAreaElement>('ml-note'); },
    get mlBtnPrev() { return getElement<HTMLButtonElement>('ml-btn-prev'); },
    get mlBtnNext() { return getElement<HTMLButtonElement>('ml-btn-next'); },
    get mlNavPosition() { return getElement<HTMLElement>('ml-nav-position'); },


    // LLM Criteria
    get criteriaCard() { return getElement<HTMLElement>('criteria-card'); },

    // LLM Config
    get llmModelSelect() { return getElement<HTMLSelectElement>('llm-model-select'); },
    get llmLanguageSelect() { return getElement<HTMLSelectElement>('llm-language-select'); },
    get protocolTextInput() { return getElement<HTMLTextAreaElement>('protocol-text-input'); },
    get optimizeCriteriaBtn() { return getElement<HTMLButtonElement>('optimize-criteria-btn'); },
    get optimizeStatusDiv() { return getElement<HTMLElement>('optimize-status'); },
    get optimizedCriteriaDisplay() { return getElement<HTMLElement>('optimized-criteria-display'); },
    get screeningPromptInput() { return getElement<HTMLTextAreaElement>('screening-prompt-input'); },
    get saveCriteriaBtn() { return getElement<HTMLButtonElement>('save-criteria-btn'); },

    // LLM Batch
    get batchSaveSizeInput() { return getElement<HTMLInputElement>('batch-save-size-input'); },
    get batchTargetCount() { return getElement<HTMLElement>('batch-target-count'); },
    get startBatchBtn() { return getElement<HTMLButtonElement>('start-batch-btn'); },
    get stopBatchBtn() { return getElement<HTMLButtonElement>('stop-batch-btn'); },
    get batchProgressDiv() { return getElement<HTMLElement>('batch-progress'); },
    get batchProgressCurrent() { return getElement<HTMLElement>('batch-progress-current'); },
    get batchProgressTotal() { return getElement<HTMLElement>('batch-progress-total'); },
    get batchProgressPercent() { return getElement<HTMLElement>('batch-progress-percent'); },
    get batchProgressBarFill() { return getElement<HTMLElement>('batch-progress-bar-fill'); },
    get batchSuccessCount() { return getElement<HTMLElement>('batch-success-count'); },
    get batchFailCount() { return getElement<HTMLElement>('batch-fail-count'); },
    get retryFailedBtn() { return getElement<HTMLButtonElement>('retry-failed-btn'); },

    // LLM Threshold
    get thresholdSection() { return getElement<HTMLElement>('threshold-section'); },
    get thresholdProcessedCount() { return getElement<HTMLElement>('threshold-processed-count'); },
    get thresholdSlider() { return getElement<HTMLInputElement>('threshold-slider'); },
    get thresholdValueDisplay() { return getElement<HTMLElement>('threshold-value-display'); },
    get previewIncludeCount() { return getElement<HTMLElement>('preview-include-count'); },
    get previewIncludePercent() { return getElement<HTMLElement>('preview-include-percent'); },
    get previewExcludeCount() { return getElement<HTMLElement>('preview-exclude-count'); },
    get previewExcludePercent() { return getElement<HTMLElement>('preview-exclude-percent'); },
    get toggleDistributionBtn() { return getElement<HTMLButtonElement>('toggle-distribution-btn'); },
    get distributionChart() { return getElement<HTMLElement>('distribution-chart'); },
    get confirmThresholdBtn() { return getElement<HTMLButtonElement>('confirm-threshold-btn'); },
    get executionHistory() { return getElement<HTMLElement>('execution-history'); },

    // ========== Reference Detail (for event delegation) ==========
    get referenceDetail() { return document.getElementById('reference-detail'); },
};

export const dom = domElements;
export type DomElements = typeof domElements;
