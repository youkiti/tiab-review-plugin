/**
 * LLM機能モジュール - エントリポイント
 * LLMタブのイベントリスナー設定と初期化
 */

import { dom } from './dom';
import { dom as sharedDom } from '../../dom';
import { wireCollapsibleCards } from '../../ui/collapsible';
import { state } from '../../state';
import { getLlmConfig } from '../../../lib/sheets-api';
import { AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG, getAllAvailableModels } from '../../../lib/gemini-api';
import { t } from '../../../lib/i18n';
import { showSettings } from '../settings';
import { hideToast, showToast } from '../../ui/feedback';
import {
    loadAllProviderStatus,
    handleSavePreferenceChange,
    handleTierChange,
    refreshProviderEmphasis,
    wireProviderRows,
    setOnApiKeyChanged,
} from './api-key';
import {
    handleTestSaveCustomModel,
    loadCustomModelsList,
    setOnCustomModelsChanged,
    refreshCustomModelSectionVisibility,
    wireCustomModelToggle,
} from './custom-models';
import {
    resolveProviderId,
    type LlmProviderId,
} from '../../../lib/llm-provider';
import {
    hasGeminiApiKey,
    hasOpenRouterApiKey,
    hasOpenAiApiKey,
    getSessionApiKey,
    getSessionOpenRouterApiKey,
    getSessionOpenAiApiKey,
} from '../../../lib/storage';
import {
    handleOptimizeCriteria,
    renderOptimizedCriteria,
    handleSaveCriteria,
    handleImportReviewCriteria,
    updateImportReviewCriteriaVisibility,
} from './criteria';
import {
    updateBatchTargetCount,
    handleToggleRestartRun,
    handleStartBatch,
    handleStopBatch,
    handleRetryFailed,
    handleThresholdChange,
    toggleDistributionChart,
    handleConfirmThreshold,
    loadExecutionHistory,
    setLoadDataAndShowScreening as setLoadDataAndShowScreeningForBatch,
} from './batch';
import { handleRecoverOrphans } from './recovery';
import { openTargetPicker, handleClearTargetSelection } from './target-picker';
import { parseTargetRefIds } from '../../../lib/llm-target-selection';

/**
 * プロンプト入力中の対象件数再計算をデバウンスする
 * 1文字ごとに config_hash を計算し直すのを避ける（Sheets へのアクセスは発生しない）
 */
const BATCH_TARGET_COUNT_DEBOUNCE_MS = 300;
let batchTargetCountTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBatchTargetCountUpdate() {
    if (batchTargetCountTimer !== null) {
        clearTimeout(batchTargetCountTimer);
    }
    batchTargetCountTimer = setTimeout(() => {
        batchTargetCountTimer = null;
        void updateBatchTargetCount();
    }, BATCH_TARGET_COUNT_DEBOUNCE_MS);
}

// Store互換レイヤー（Phase 5）
import {
    changeTab as syncChangeTab,
    setLlmConfig as syncSetLlmConfig,
} from '../../store/compat';

/**
 * 設定済みプロバイダの集合を返す。
 * 永続化された API キー（chrome.storage）に加え、セッション限定キー（保存しない設定）も「設定済み」として扱う。
 */
async function getConfiguredProviders(): Promise<Set<LlmProviderId>> {
    const [gemini, openRouter, openAi] = await Promise.all([
        hasGeminiApiKey(),
        hasOpenRouterApiKey(),
        hasOpenAiApiKey(),
    ]);
    const configured = new Set<LlmProviderId>();
    if (gemini || (getSessionApiKey() ?? '').length > 0) configured.add('gemini');
    if (openRouter || (getSessionOpenRouterApiKey() ?? '').length > 0) configured.add('openrouter');
    if (openAi || (getSessionOpenAiApiKey() ?? '').length > 0) configured.add('openai');
    return configured;
}

/**
 * モデル選択のオプションを動的に生成
 *
 * ビルトイン AVAILABLE_MODELS + ユーザー登録カスタム OpenRouter モデルを合成 (getAllAvailableModels) し、
 * API キーの設定状態にかかわらず全プロバイダのモデルを表示する。
 *
 * カスタムモデルは OpenRouter optgroup 末尾に「(カスタム)」バッジ付きで並ぶ。
 *
 * 戻り値: 現在選択中のカスタムモデルが削除された等で別モデルに切り替わった場合 true。
 */
export async function populateModelSelect(isCurrent: () => boolean = () => true): Promise<boolean> {
    const select = dom.llmModelSelect;
    const previousValue = select.value;
    select.innerHTML = '';

    const allModels = await getAllAvailableModels();
    if (!isCurrent()) return false;

    const groups: Record<LlmProviderId, HTMLOptGroupElement> = {
        gemini: document.createElement('optgroup'),
        openrouter: document.createElement('optgroup'),
        openai: document.createElement('optgroup'),
    };
    groups.gemini.label = 'Gemini';
    groups.openrouter.label = 'OpenRouter';
    groups.openai.label = 'OpenAI';

    for (const model of allModels) {
        const option = document.createElement('option');
        option.value = model.id;
        const baseLabel = model.nameKey ? t(model.nameKey) : model.name;
        // カスタムモデルは末尾にバッジ風サフィックスを付与（select 内では HTML 不可のためテキストで表現）
        option.textContent = model.custom
            ? `${baseLabel}  •  ${t('llm_customModelBadge')}`
            : baseLabel;
        option.dataset.provider = model.provider;
        if (model.custom) option.dataset.custom = 'true';
        if (model.id === DEFAULT_MODEL_CONFIG.model) {
            option.selected = true;
        }
        groups[model.provider].appendChild(option);
    }

    if (groups.gemini.childElementCount > 0) select.appendChild(groups.gemini);
    if (groups.openrouter.childElementCount > 0) select.appendChild(groups.openrouter);
    if (groups.openai.childElementCount > 0) select.appendChild(groups.openai);

    const hasAnyOption = select.options.length > 0;

    // 以前の選択値をできるだけ維持。消えた場合は最初のオプションへフォールバック。
    let switched = false;
    if (hasAnyOption) {
        const stillPresent = Array.from(select.options).some(o => o.value === previousValue);
        if (stillPresent && previousValue) {
            select.value = previousValue;
        } else if (previousValue && previousValue !== select.options[0]?.value) {
            select.value = select.options[0].value;
            switched = true;
        }
    }
    return switched;
}

/**
 * 選択中モデルに必要なキーの案内とプロバイダ行を更新
 */
export async function refreshModelKeyNote(): Promise<void> {
    const modelId = dom.llmModelSelect.value;
    if (!modelId) return;
    const configured = await getConfiguredProviders();
    if (dom.llmModelSelect.value !== modelId) return;
    const provider = resolveProviderId(modelId, AVAILABLE_MODELS);
    const names: Record<LlmProviderId, string> = { gemini: 'Gemini', openrouter: 'OpenRouter', openai: 'OpenAI' };
    const ready = configured.has(provider);
    dom.llmModelKeyNote.className = ready ? 'model-key-note ok' : 'model-key-note warn';
    dom.llmModelKeyNote.textContent = t(ready ? 'llm_modelKeyReady' : 'llm_modelKeyMissing', names[provider]);
    refreshProviderEmphasis(provider, configured);
    refreshCustomModelSectionVisibility(configured.has('openrouter'));
}

function handleModelSelectChange(): void {
    void refreshModelKeyNote();
}

// handleBackへの参照（循環依存回避のため関数として渡す）
let _handleBack: (() => void) | null = null;

export function setHandleBack(fn: () => void) {
    _handleBack = fn;
}

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    setLoadDataAndShowScreeningForBatch(fn);
}

/**
 * LLMイベントリスナーを設定
 */
export function setupLlmEventListeners() {
    // タブ切り替えは sidepanel.ts と lazy.ts が担当する。

    // LLM戻るボタン
    dom.llmBackBtn?.addEventListener('click', handleLlmBack);

    // LLM設定ボタン
    dom.llmSettingsBtn?.addEventListener('click', showSettings);

    // API キー変更時にモデル選択肢を再構築
    setOnApiKeyChanged(async () => {
        await populateModelSelect();
        await refreshModelKeyNote();
    });

    // カスタムモデル追加/削除時にもモデル選択肢を再構築
    setOnCustomModelsChanged(async () => {
        await populateModelSelect();
        await refreshModelKeyNote();
    });

    // APIキー関連
    wireProviderRows();
    dom.saveApiKeyCheckbox?.addEventListener('change', handleSavePreferenceChange);
    dom.tierSelect?.addEventListener('change', handleTierChange);

    // OpenRouter カスタムモデル
    wireCustomModelToggle();
    dom.testSaveCustomModelBtn?.addEventListener('click', handleTestSaveCustomModel);

    // モデル選択: 選択 provider に応じて該当プロバイダ行と注記を更新
    dom.llmModelSelect?.addEventListener('change', handleModelSelectChange);
    // モデル・プロンプトを変えると別 Run になり対象件数も変わるので再計算する
    dom.llmModelSelect?.addEventListener('change', () => { void updateBatchTargetCount(); });
    dom.screeningPromptInput?.addEventListener('input', scheduleBatchTargetCountUpdate);

    // 基準最適化
    dom.importReviewCriteriaBtn?.addEventListener('click', handleImportReviewCriteria);
    dom.optimizeCriteriaBtn?.addEventListener('click', handleOptimizeCriteria);
    dom.saveCriteriaBtn?.addEventListener('click', handleSaveCriteria);

    // バッチ処理
    dom.startBatchBtn?.addEventListener('click', handleStartBatch);
    dom.stopBatchBtn?.addEventListener('click', handleStopBatch);
    dom.retryFailedBtn?.addEventListener('click', handleRetryFailed);
    dom.batchMaxCountSelect?.addEventListener('change', () => { void updateBatchTargetCount(); });
    dom.batchRestartRunBtn?.addEventListener('click', () => { void handleToggleRestartRun(); });
    dom.batchTargetEditBtn?.addEventListener('click', openTargetPicker);
    dom.batchTargetClearBtn?.addEventListener('click', () => { void handleClearTargetSelection(); });

    // 閾値調整
    dom.thresholdSlider?.addEventListener('input', handleThresholdChange);
    dom.toggleDistributionBtn?.addEventListener('click', toggleDistributionChart);
    dom.confirmThresholdBtn?.addEventListener('click', handleConfirmThreshold);

    // 孤立判定の復旧
    dom.recoverOrphansBtn?.addEventListener('click', handleRecoverOrphans);

    // 折りたたみセクション
    wireCollapsibleCards(sharedDom.llmSection);
}

/**
 * LLMセクションを初期化
 */
export async function initializeLlmSection(isCurrent: () => boolean = () => true) {
    const spreadsheetId = state.spreadsheetId;
    try {
        // APIキーの状態と共通の保存設定を読み込む。
        await loadAllProviderStatus();
        if (!isCurrent()) return;

        // OpenRouter カスタムモデル一覧を読み込み（モデルセレクト構築前に必要）
        await loadCustomModelsList();
        if (!isCurrent()) return;

        // モデル選択オプションを動的に生成（全プロバイダ + 登録カスタムモデル）
        await populateModelSelect(isCurrent);
        if (!isCurrent()) return;

        // LLM設定を読み込み
        if (spreadsheetId) {
            const llmConfig = await getLlmConfig(spreadsheetId);
            if (!isCurrent()) return;
            // Store経由で更新
            syncSetLlmConfig(llmConfig);

            // AI一括判定の対象選択（担当セット・個別選択）を復元
            state.setLlmTargetMode(llmConfig.llm_target_mode);
            state.setLlmTargetRefIds(new Set(parseTargetRefIds(llmConfig.llm_target_ref_ids)));

            // UI更新: 保存済みカスタムモデルが削除されている場合は先頭にフォールバック
            const savedModel = llmConfig.llm_model;
            const isSavedModelAvailable =
                Array.from(dom.llmModelSelect.options).some(o => o.value === savedModel);
            if (isSavedModelAvailable) {
                dom.llmModelSelect.value = savedModel;
            } else if (dom.llmModelSelect.options.length > 0) {
                dom.llmModelSelect.value = dom.llmModelSelect.options[0].value;
                showToast(t('llm_modelFallbackToast'), 4000);
            }
            await refreshModelKeyNote();
            if (!isCurrent()) return;
            dom.llmLanguageSelect.value = llmConfig.llm_output_language;
            dom.protocolTextInput.value = llmConfig.llm_protocol_text;
            updateImportReviewCriteriaVisibility();
            dom.thresholdSlider.value = llmConfig.llm_include_threshold.toString();
            dom.thresholdValueDisplay.textContent = llmConfig.llm_include_threshold.toFixed(2);

            // 既存の基準があれば表示
            if (llmConfig.llm_criteria) {
                renderOptimizedCriteria(llmConfig.llm_criteria, llmConfig.llm_screening_prompt);

                // 既存の基準がある場合：確定状態のスタイルを適用
                dom.criteriaCard.classList.add('confirmed');
            } else {
                // 基準が未設定の場合：確定状態を解除
                dom.criteriaCard.classList.remove('confirmed');
            }

            // 実行履歴を読み込み（Run/Batch のキャッシュもここで更新される）
            await loadExecutionHistory(isCurrent);
            if (!isCurrent()) return;

            // バッチ対象件数を更新（Run 単位で数えるため履歴の読み込み後に行う）
            await updateBatchTargetCount(isCurrent);
            if (!isCurrent()) return;
        } else {
            await refreshModelKeyNote();
        }
    } catch (error) {
        if (isCurrent()) throw error;
    }
}

/**
 * LLM戻るボタン
 */
export function handleLlmBack() {
    hideToast();
    syncChangeTab('screening');
    if (_handleBack) {
        _handleBack();
    }
}
