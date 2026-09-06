/**
 * DOM要素の型付きレジストリ
 * 共有DOM要素への型安全なアクセスを提供。LLM専用要素は features/llm/dom.ts に置く。
 */

// ヘルパー関数: 要素取得（nullの場合はエラー）
export function getElement<T extends HTMLElement>(id: string): T {
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

const domElements = {
    // ========== Config/Project Section ==========
    get configSection() { return getElement<HTMLElement>('config-section'); },
    get spreadsheetInput() { return getElement<HTMLInputElement>('spreadsheet-input'); },
    get recentSheetsSelect() { return getElement<HTMLSelectElement>('recent-sheets'); },
    get connectBtn() { return getElement<HTMLButtonElement>('connect-btn'); },
    get createBtn() { return getElement<HTMLButtonElement>('create-btn'); },
    get createProjectOption() { return getElement<HTMLElement>('create-project-option'); },
    get reviewOnlyNotice() { return getElement<HTMLElement>('review-only-notice'); },
    get desktopExtensionNotice() { return getElement<HTMLElement>('desktop-extension-notice'); },
    get desktopExtensionNoticeClose() { return getElement<HTMLButtonElement>('desktop-extension-notice-close'); },
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
    get btnOpenFulltext() { return getElement<HTMLButtonElement>('btn-open-fulltext'); },
    get refSourceBadge() { return getElement<HTMLElement>('ref-source-badge'); },
    get refTrialRegistryNote() { return getElement<HTMLElement>('ref-trial-registry-note'); },
    get refDecisionStatusRow() { return getElement<HTMLElement>('ref-decision-status-row'); },
    get refDecisionChip() { return getElement<HTMLElement>('ref-decision-chip'); },

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

    // ========== Team Progress ==========
    get teamProgressHost() { return getElement<HTMLElement>('team-progress-host'); },
    get fulltextTeamProgressHost() { return getElement<HTMLElement>('fulltext-team-progress-host'); },

    // ========== Source Filters ==========
    get sourceFileListDiv() { return getElement<HTMLElement>('source-file-list'); },
    get sourceFiltersSection() { return getElement<HTMLElement>('source-filters-section'); },
    get activeTermFiltersDiv() { return getElement<HTMLElement>('active-term-filters'); },

    // ========== Assignment Filters ==========
    get assignmentFiltersSection() { return getElement<HTMLElement>('assignment-filters-section'); },
    get assignmentSetListDiv() { return getElement<HTMLElement>('assignment-set-list'); },

    // ========== Assignment Banner (settings screen, admin, not-configured) ==========
    get assignmentBanner() { return getElement<HTMLElement>('assignment-banner'); },
    get assignmentBannerDesc() { return getElement<HTMLElement>('assignment-banner-desc'); },
    get assignmentBannerOpenBtn() { return getElement<HTMLButtonElement>('assignment-banner-open-btn'); },

    // ========== Import/Export ==========
    get risFileInput() { return getElement<HTMLInputElement>('ris-file'); },
    get importBtn() { return getElement<HTMLButtonElement>('import-btn'); },
    get exportBtn() { return getElement<HTMLButtonElement>('export-btn'); },
    get exportMenu() { return getElement<HTMLElement>('export-menu'); },
    get exportCsvBtn() { return getElement<HTMLButtonElement>('export-csv-btn'); },
    get exportRisBtn() { return getElement<HTMLButtonElement>('export-ris-btn'); },
    get exportManuscriptBtn() { return getElement<HTMLButtonElement>('export-manuscript-btn'); },
    get importStatus() { return getElement<HTMLElement>('import-status'); },
    get backBtn() { return getElement<HTMLButtonElement>('back-btn'); },

    // ========== 未送信キューバッジ ==========
    get unsentQueueBadge() { return getElement<HTMLButtonElement>('unsent-queue-badge'); },

    // ========== Key Open Section ==========
    get keySection() { return getElement<HTMLElement>('key-section'); },
    get keyToggleInput() { return getElement<HTMLInputElement>('key-toggle-input'); },
    get aiHighlightContainer() { return getElement<HTMLElement>('ai-highlight-container'); },
    get aiHighlightCheckbox() { return getElement<HTMLInputElement>('ai-highlight-checkbox'); },
    get consensusModeContainer() { return getElement<HTMLElement>('consensus-mode-container'); },
    get consensusModeCheckbox() { return getElement<HTMLInputElement>('consensus-mode-checkbox'); },
    get consensusModeBadge() { return getElement<HTMLElement>('consensus-mode-badge'); },
    get reviewerFilterContainer() { return getElement<HTMLElement>('reviewer-filter-container'); },
    get conflictBanner() { return getElement<HTMLElement>('conflict-banner'); },
    get tiabDoneBanner() { return getElement<HTMLElement>('tiab-done-banner'); },
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
    get modalCloseBtn() { return getElement<HTMLButtonElement>('modal-close-btn'); },

    // ========== Sharing ==========
    get shareBtn() { return getElement<HTMLButtonElement>('share-btn'); },
    get shareInputArea() { return getElement<HTMLElement>('share-input-area'); },
    get shareEmailInput() { return getElement<HTMLInputElement>('share-email-input'); },
    get shareSubmitBtn() { return getElement<HTMLButtonElement>('share-submit-btn'); },
    get shareCancelBtn() { return getElement<HTMLButtonElement>('share-cancel-btn'); },
    get shareCopyInviteBtn() { return getElement<HTMLButtonElement>('share-copy-invite-btn'); },
    get sharedUsersList() { return getElement<HTMLElement>('shared-users-list'); },
    get shareSuggestionArea() { return getElement<HTMLElement>('share-suggestion-area'); },
    get shareSuggestionChips() { return getElement<HTMLElement>('share-suggestion-chips'); },
    get shareEmailDatalist() { return getElement<HTMLDataListElement>('share-email-suggestions'); },

    // ========== Settings ==========
    get settingsSection() { return getElement<HTMLElement>('settings-section'); },
    get settingsBtnProject() { return getElement<HTMLButtonElement>('settings-btn-project'); },
    get settingsBtnScreening() { return getElement<HTMLButtonElement>('settings-btn-screening'); },
    get criteriaBtnScreening() { return getElement<HTMLButtonElement>('criteria-btn-screening'); },
    get closeSettingsBtn() { return getElement<HTMLButtonElement>('close-settings-btn'); },
    get autoNavigateCheckbox() { return getElement<HTMLInputElement>('auto-navigate-checkbox'); },
    get showRecordCountCheckbox() { return getElement<HTMLInputElement>('show-record-count-checkbox'); },
    get termFilterAndCheckbox() { return getElement<HTMLInputElement>('term-filter-and-checkbox'); },
    get treatMlAsManualCheckbox() { return getElement<HTMLInputElement>('treat-ml-as-manual-checkbox'); },
    get abstractSubsectionBreakCheckbox() { return getElement<HTMLInputElement>('abstract-subsection-break-checkbox'); },
    get abstractSubsectionHeadingsTextarea() { return getElement<HTMLTextAreaElement>('abstract-subsection-headings-textarea'); },
    get abstractSubsectionHeadingsResetBtn() { return getElement<HTMLButtonElement>('abstract-subsection-headings-reset-btn'); },
    get assignmentSettingsItem() { return getElement<HTMLElement>('assignment-settings-item'); },
    get assignmentSettingsStatus() { return getElement<HTMLElement>('assignment-settings-status'); },
    get assignmentResetBtn() { return getElement<HTMLButtonElement>('assignment-reset-btn'); },
    get assignmentReshuffleBtn() { return getElement<HTMLButtonElement>('assignment-reshuffle-btn'); },
    get assignmentReviewerMap() { return getElement<HTMLElement>('assignment-reviewer-map'); },
    get assignmentSaveBtn() { return getElement<HTMLButtonElement>('assignment-save-btn'); },

    // ========== LLM Section ==========
    get llmSection() { return getElement<HTMLElement>('llm-section'); },
    get tabScreeningBtn() { return getElement<HTMLButtonElement>('tab-screening'); },
    get tabLlmBtn() { return getElement<HTMLButtonElement>('tab-llm'); },
    get tabMlBtn() { return getElement<HTMLButtonElement>('tab-ml'); },
    get tabFulltextBtn() { return getElement<HTMLButtonElement>('tab-fulltext'); },
    get tabFulltextBadge() { return getElement<HTMLElement>('tab-fulltext-badge'); },
    get headerTabs() { return querySelector<HTMLElement>('.header-tabs'); },

    // ========== Fulltext Section ==========
    get fulltextSection() { return getElement<HTMLElement>('fulltext-section'); },
    get fulltextBackBtn() { return getElement<HTMLButtonElement>('fulltext-back-btn'); },
    // セットアップチェックリスト（fulltext-checklist.ts）
    get fulltextChecklistHost() { return getElement<HTMLElement>('fulltext-checklist'); },
    get fulltextProgressLine() { return getElement<HTMLElement>('fulltext-progress-line'); },
    get fulltextRuleLine() { return getElement<HTMLElement>('fulltext-rule-line'); },
    get fulltextRuleEditBtn() { return getElement<HTMLButtonElement>('fulltext-rule-edit-btn'); },
    get fulltextRuleEditorDiv() { return getElement<HTMLElement>('fulltext-rule-editor'); },
    get fulltextReasonLine() { return getElement<HTMLElement>('fulltext-reason-line'); },
    get fulltextReasonEditBtn() { return getElement<HTMLButtonElement>('fulltext-reason-edit-btn'); },
    get fulltextReasonEditorDiv() { return getElement<HTMLElement>('fulltext-reason-editor'); },
    get fulltextAssignmentLine() { return getElement<HTMLElement>('fulltext-assignment-line'); },
    get fulltextAssignmentEditBtn() { return getElement<HTMLButtonElement>('fulltext-assignment-edit-btn'); },
    get fulltextAssignmentSets() { return getElement<HTMLElement>('fulltext-assignment-sets'); },
    get fulltextAssignmentSetListDiv() { return getElement<HTMLElement>('fulltext-assignment-set-list'); },
    get fulltextObtainedLine() { return getElement<HTMLElement>('fulltext-obtained-line'); },
    get fulltextStatusBarFill() { return getElement<HTMLElement>('fulltext-status-bar-fill'); },
    get fulltextStatusBreakdown() { return getElement<HTMLElement>('fulltext-status-breakdown'); },
    get fulltextFetchBtn() { return getElement<HTMLButtonElement>('fulltext-fetch-btn'); },
    get fulltextSuggestBtn() { return getElement<HTMLButtonElement>('fulltext-suggest-btn'); },
    get fulltextFetchCancelBtn() { return getElement<HTMLButtonElement>('fulltext-fetch-cancel-btn'); },
    get fulltextRetryCheckbox() { return getElement<HTMLInputElement>('fulltext-retry-checkbox'); },
    get fulltextFetchStatus() { return getElement<HTMLElement>('fulltext-fetch-status'); },
    get fulltextViewFilter() { return getElement<HTMLSelectElement>('fulltext-view-filter'); },
    get fulltextUploadInput() { return getElement<HTMLInputElement>('fulltext-upload-input'); },
    // Driveへ直接置かれたPDFの取り込み（fulltext-drive-import.ts）
    get fulltextImportDriveBtn() { return getElement<HTMLButtonElement>('fulltext-import-drive-btn'); },
    get fulltextImportDriveStatus() { return getElement<HTMLElement>('fulltext-import-drive-status'); },
    // 読み取り権限の再付与（fulltext-regrant.ts）
    get fulltextRegrantBtn() { return getElement<HTMLButtonElement>('fulltext-regrant-btn'); },
    get fulltextRegrantStatus() { return getElement<HTMLElement>('fulltext-regrant-status'); },
    get fulltextListDiv() { return getElement<HTMLElement>('fulltext-list'); },
    // 結果ビュー（ビュー切替・判定者選択・PRISMA・エクスポート）
    get fulltextBlindRow() { return getElement<HTMLElement>('fulltext-blind-row'); },
    get fulltextKeyToggle() { return getElement<HTMLInputElement>('fulltext-key-toggle'); },
    get fulltextModeListBtn() { return getElement<HTMLButtonElement>('fulltext-mode-list'); },
    get fulltextModeAiBtn() { return getElement<HTMLButtonElement>('fulltext-mode-ai'); },
    get fulltextModeResultsBtn() { return getElement<HTMLButtonElement>('fulltext-mode-results'); },
    // AI判定（フルテキスト一括Gemini判定）
    get fulltextAiDiv() { return getElement<HTMLElement>('fulltext-ai'); },
    get fulltextAiScopeProjectRadio() { return getElement<HTMLInputElement>('fulltext-ai-scope-project'); },
    get fulltextAiScopeAssignedRadio() { return getElement<HTMLInputElement>('fulltext-ai-scope-assigned'); },
    get fulltextAiModelSelect() { return getElement<HTMLSelectElement>('fulltext-ai-model'); },
    get fulltextAiPromptInput() { return getElement<HTMLTextAreaElement>('fulltext-ai-prompt'); },
    get fulltextAiTargetDiv() { return getElement<HTMLElement>('fulltext-ai-target'); },
    get fulltextAiStartBtn() { return getElement<HTMLButtonElement>('fulltext-ai-start-btn'); },
    get fulltextAiStopBtn() { return getElement<HTMLButtonElement>('fulltext-ai-stop-btn'); },
    get fulltextAiProgressDiv() { return getElement<HTMLElement>('fulltext-ai-progress'); },
    get fulltextAiProgressFill() { return getElement<HTMLElement>('fulltext-ai-progress-fill'); },
    get fulltextAiProgressText() { return getElement<HTMLElement>('fulltext-ai-progress-text'); },
    get fulltextAiLogDiv() { return getElement<HTMLElement>('fulltext-ai-log'); },
    get fulltextAiRoundsDiv() { return getElement<HTMLElement>('fulltext-ai-rounds'); },
    get fulltextResultsDiv() { return getElement<HTMLElement>('fulltext-results'); },
    get fulltextJudgeList() { return getElement<HTMLElement>('fulltext-judge-list'); },
    get fulltextJudgeHint() { return getElement<HTMLElement>('fulltext-judge-hint'); },
    get fulltextPrismaDiv() { return getElement<HTMLElement>('fulltext-prisma'); },
    // 不一致の解消（キー開封後のみ表示。fulltext-results.ts の renderConflicts が描画）
    get fulltextConflictsDiv() { return getElement<HTMLElement>('fulltext-conflicts'); },
    get fulltextConflictsSummaryDiv() { return getElement<HTMLElement>('fulltext-conflicts-summary'); },
    get fulltextConflictsListDiv() { return getElement<HTMLElement>('fulltext-conflicts-list'); },
    get fulltextResultsListDiv() { return getElement<HTMLElement>('fulltext-results-list'); },
    get fulltextExportCsvBtn() { return getElement<HTMLButtonElement>('fulltext-export-csv-btn'); },
    get fulltextExportRisBtn() { return getElement<HTMLButtonElement>('fulltext-export-ris-btn'); },
    get fulltextManuscriptBtn() { return getElement<HTMLButtonElement>('fulltext-manuscript-btn'); },
    get startBatchBtn() { return getElement<HTMLButtonElement>('start-batch-btn'); },
    get stopBatchBtn() { return getElement<HTMLButtonElement>('stop-batch-btn'); },

    // ========== ML Section ==========
    get mlSection() { return getElement<HTMLElement>('ml-section'); },
    get mlSettingsBtn() { return getElement<HTMLButtonElement>('ml-settings-btn'); },
    get mlNoteInput() { return getElement<HTMLTextAreaElement>('ml-note'); },
    get mlBtnPrev() { return getElement<HTMLButtonElement>('ml-btn-prev'); },
    get mlBtnNext() { return getElement<HTMLButtonElement>('ml-btn-next'); },
    get mlNavPosition() { return getElement<HTMLElement>('ml-nav-position'); },
    get mlRefDecisionStatusRow() { return getElement<HTMLElement>('ml-ref-decision-status-row'); },
    get mlRefDecisionChip() { return getElement<HTMLElement>('ml-ref-decision-chip'); },


    // ========== Reference Detail (for event delegation) ==========
    get referenceDetail() { return document.getElementById('reference-detail'); },
};

export const dom = domElements;
export type DomElements = typeof domElements;
