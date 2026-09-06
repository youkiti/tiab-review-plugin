/** AIタブ内の専用DOM参照。初期バンドルからは読み込まない。 */
import { getElement } from '../../dom';

export const dom = {
    get llmBackBtn() { return getElement<HTMLButtonElement>('llm-back-btn'); },
    get llmSettingsBtn() { return getElement<HTMLButtonElement>('llm-settings-btn'); },

    // LLM APIキー (Gemini)
    get apiKeyCard() { return getElement<HTMLElement>('api-key-card'); },
    get apiKeySummary() { return getElement<HTMLElement>('api-key-summary'); },
    get geminiApiKeyInput() { return getElement<HTMLInputElement>('gemini-api-key'); },
    get toggleApiKeyVisibilityBtn() { return getElement<HTMLButtonElement>('toggle-api-key-visibility'); },
    get saveApiKeyCheckbox() { return getElement<HTMLInputElement>('save-api-key-checkbox'); },
    get apiKeyStatus() { return getElement<HTMLElement>('api-key-status'); },

    // LLM APIキー (OpenRouter)
    get openRouterApiKeyCard() { return getElement<HTMLElement>('openrouter-api-key-card'); },
    get openRouterApiKeySummary() { return getElement<HTMLElement>('openrouter-api-key-summary'); },
    get openRouterApiKeyInput() { return getElement<HTMLInputElement>('openrouter-api-key'); },
    get toggleOpenRouterApiKeyVisibilityBtn() { return getElement<HTMLButtonElement>('toggle-openrouter-api-key-visibility'); },
    get saveOpenRouterApiKeyCheckbox() { return getElement<HTMLInputElement>('save-openrouter-api-key-checkbox'); },
    get openRouterApiKeyStatus() { return getElement<HTMLElement>('openrouter-api-key-status'); },

    // LLM APIキー (OpenAI)
    get openAiApiKeyCard() { return getElement<HTMLElement>('openai-api-key-card'); },
    get openAiApiKeySummary() { return getElement<HTMLElement>('openai-api-key-summary'); },
    get openAiApiKeyInput() { return getElement<HTMLInputElement>('openai-api-key'); },
    get toggleOpenAiApiKeyVisibilityBtn() { return getElement<HTMLButtonElement>('toggle-openai-api-key-visibility'); },
    get saveOpenAiApiKeyCheckbox() { return getElement<HTMLInputElement>('save-openai-api-key-checkbox'); },
    get openAiApiKeyStatus() { return getElement<HTMLElement>('openai-api-key-status'); },

    // LLM カスタムモデル (OpenRouter)
    get openRouterCustomModelCard() { return getElement<HTMLElement>('openrouter-custom-model-card'); },
    get customModelIdInput() { return getElement<HTMLInputElement>('custom-model-id-input'); },
    get customModelLabelInput() { return getElement<HTMLInputElement>('custom-model-label-input'); },
    get testSaveCustomModelBtn() { return getElement<HTMLButtonElement>('test-save-custom-model-btn'); },
    get customModelStatus() { return getElement<HTMLElement>('custom-model-status'); },
    get customModelsList() { return getElement<HTMLUListElement>('custom-models-list'); },
    get customModelsEmpty() { return getElement<HTMLElement>('custom-models-empty'); },

    // LLM 判定基準
    get criteriaCard() { return getElement<HTMLElement>('criteria-card'); },

    // LLM 設定
    get llmModelSelect() { return getElement<HTMLSelectElement>('llm-model-select'); },
    get llmNoModelHint() { return getElement<HTMLElement>('llm-no-model-hint'); },
    get llmLanguageSelect() { return getElement<HTMLSelectElement>('llm-language-select'); },
    get protocolTextInput() { return getElement<HTMLTextAreaElement>('protocol-text-input'); },
    get importReviewCriteriaBtn() { return getElement<HTMLButtonElement>('import-review-criteria-btn'); },
    get optimizeCriteriaBtn() { return getElement<HTMLButtonElement>('optimize-criteria-btn'); },
    get optimizeStatusDiv() { return getElement<HTMLElement>('optimize-status'); },
    get optimizedCriteriaDisplay() { return getElement<HTMLElement>('optimized-criteria-display'); },
    get screeningPromptInput() { return getElement<HTMLTextAreaElement>('screening-prompt-input'); },
    get saveCriteriaBtn() { return getElement<HTMLButtonElement>('save-criteria-btn'); },

    // LLM 利用枠
    get tierSection() { return getElement<HTMLElement>('tier-section'); },
    get tierSelect() { return getElement<HTMLSelectElement>('tier-select'); },

    // LLM 一括判定
    get batchTargetSummary() { return getElement<HTMLElement>('batch-target-summary'); },
    get batchTargetEditBtn() { return getElement<HTMLButtonElement>('batch-target-edit-btn'); },
    get batchTargetClearBtn() { return getElement<HTMLButtonElement>('batch-target-clear-btn'); },
    get batchTargetNote() { return getElement<HTMLElement>('batch-target-note'); },
    get batchMaxCountSelect() { return getElement<HTMLSelectElement>('batch-max-count-select'); },
    get batchTargetCount() { return getElement<HTMLElement>('batch-target-count'); },
    get batchPlannedCount() { return getElement<HTMLElement>('batch-planned-count'); },
    get batchRunMode() { return getElement<HTMLElement>('batch-run-mode'); },
    get batchRunModeText() { return getElement<HTMLElement>('batch-run-mode-text'); },
    get batchRestartRunBtn() { return getElement<HTMLButtonElement>('batch-restart-run-btn'); },
    get startBatchBtn() { return getElement<HTMLButtonElement>('start-batch-btn'); },
    get stopBatchBtn() { return getElement<HTMLButtonElement>('stop-batch-btn'); },
    get batchProgressDiv() { return getElement<HTMLElement>('batch-progress'); },
    get batchProgressCurrent() { return getElement<HTMLElement>('batch-progress-current'); },
    get batchProgressTotal() { return getElement<HTMLElement>('batch-progress-total'); },
    get batchProgressPercent() { return getElement<HTMLElement>('batch-progress-percent'); },
    get batchProgressBarFill() { return getElement<HTMLElement>('batch-progress-bar-fill'); },
    get batchSuccessCount() { return getElement<HTMLElement>('batch-success-count'); },
    get batchFailCount() { return getElement<HTMLElement>('batch-fail-count'); },
    get batchFallbackCount() { return getElement<HTMLElement>('batch-fallback-count'); },
    get retryFailedBtn() { return getElement<HTMLButtonElement>('retry-failed-btn'); },

    // LLM 閾値
    get thresholdSection() { return getElement<HTMLElement>('threshold-section'); },
    get thresholdCompleteMessage() { return getElement<HTMLElement>('threshold-complete-message'); },
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
    get recoverOrphansBtn() { return getElement<HTMLButtonElement>('recover-orphans-btn'); },

};
