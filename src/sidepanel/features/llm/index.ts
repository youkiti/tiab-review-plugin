/**
 * LLM機能モジュール - エントリポイント
 * LLMタブのイベントリスナー設定と初期化
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { getLlmConfig } from '../../../lib/sheets-api';
import { AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG, getAllAvailableModels } from '../../../lib/gemini-api';
import { t } from '../../../lib/i18n';
import { showSettings } from '../settings';
import { hideToast, showToast } from '../../ui/feedback';
import {
    loadApiKeyStatus,
    toggleApiKeyVisibility,
    handleApiKeyAutoSave,
    handleSavePreferenceChange,
    handleTierChange,
    loadOpenRouterApiKeyStatus,
    toggleOpenRouterApiKeyVisibility,
    handleOpenRouterApiKeyAutoSave,
    handleOpenRouterSavePreferenceChange,
    refreshApiKeyCardEmphasis,
    setOnApiKeyChanged,
} from './api-key';
import {
    handleTestSaveCustomModel,
    loadCustomModelsList,
    setOnCustomModelsChanged,
} from './custom-models';
import {
    resolveProviderId,
    filterModelsByConfiguredProviders,
    type LlmProviderId,
} from '../../../lib/llm-provider';
import {
    hasGeminiApiKey,
    hasOpenRouterApiKey,
    getSessionApiKey,
    getSessionOpenRouterApiKey,
} from '../../../lib/storage';
import {
    handleOptimizeCriteria,
    renderOptimizedCriteria,
    handleSaveCriteria,
} from './criteria';
import {
    updateBatchTargetCount,
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
    const [gemini, openRouter] = await Promise.all([
        hasGeminiApiKey(),
        hasOpenRouterApiKey(),
    ]);
    const configured = new Set<LlmProviderId>();
    if (gemini || (getSessionApiKey() ?? '').length > 0) configured.add('gemini');
    if (openRouter || (getSessionOpenRouterApiKey() ?? '').length > 0) configured.add('openrouter');
    return configured;
}

/**
 * モデル選択のオプションを動的に生成
 *
 * ビルトイン AVAILABLE_MODELS + ユーザー登録カスタム OpenRouter モデルを合成 (getAllAvailableModels) し、
 * 設定済み API キーを持つ provider のモデルのみを表示する。
 * 全 provider 未設定の場合はセレクト自体を隠してヒントを表示する。
 *
 * カスタムモデルは OpenRouter optgroup 末尾に「(カスタム)」バッジ付きで並ぶ。
 *
 * 戻り値: 現在選択中のモデルがフィルタで消えた等で別モデルに切り替わった場合 true。
 */
export async function populateModelSelect(): Promise<boolean> {
    const select = dom.llmModelSelect;
    const previousValue = select.value;
    select.innerHTML = '';

    const configured = await getConfiguredProviders();
    const allModels = await getAllAvailableModels();

    const groups: Record<LlmProviderId, HTMLOptGroupElement> = {
        gemini: document.createElement('optgroup'),
        openrouter: document.createElement('optgroup'),
    };
    groups.gemini.label = 'Gemini';
    groups.openrouter.label = 'OpenRouter';

    const visibleModels = filterModelsByConfiguredProviders(allModels, configured);
    for (const model of visibleModels) {
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

    const hasAnyOption = select.options.length > 0;
    dom.llmNoModelHint.classList.toggle('hidden', hasAnyOption);
    select.classList.toggle('hidden', !hasAnyOption);

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
 * モデル選択変更時：該当 provider の API キーカードを強調表示
 */
function handleModelSelectChange(): void {
    const modelId = dom.llmModelSelect.value;
    if (!modelId) return;
    const providerId = resolveProviderId(modelId, AVAILABLE_MODELS);
    refreshApiKeyCardEmphasis(providerId);
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
    // タブ切り替え: sidepanel.ts で一元管理するため削除
    // dom.tabScreeningBtn?.addEventListener('click', () => switchToTab('screening'));
    // dom.tabLlmBtn?.addEventListener('click', () => switchToTab('llm'));

    // LLM戻るボタン
    dom.llmBackBtn?.addEventListener('click', handleLlmBack);

    // LLM設定ボタン
    dom.llmSettingsBtn?.addEventListener('click', showSettings);

    // API キー変更時にモデル選択肢を再構築
    setOnApiKeyChanged(async () => {
        const switched = await populateModelSelect();
        if (switched) {
            handleModelSelectChange();
        }
    });

    // カスタムモデル追加/削除時にもモデル選択肢を再構築
    setOnCustomModelsChanged(async () => {
        const switched = await populateModelSelect();
        if (switched) {
            handleModelSelectChange();
        }
    });

    // APIキー関連 (Gemini)
    dom.toggleApiKeyVisibilityBtn?.addEventListener('click', toggleApiKeyVisibility);
    dom.geminiApiKeyInput?.addEventListener('change', handleApiKeyAutoSave);
    dom.saveApiKeyCheckbox?.addEventListener('change', handleSavePreferenceChange);
    dom.tierSelect?.addEventListener('change', handleTierChange);

    // APIキー関連 (OpenRouter)
    dom.toggleOpenRouterApiKeyVisibilityBtn?.addEventListener('click', toggleOpenRouterApiKeyVisibility);
    dom.openRouterApiKeyInput?.addEventListener('change', handleOpenRouterApiKeyAutoSave);
    dom.saveOpenRouterApiKeyCheckbox?.addEventListener('change', handleOpenRouterSavePreferenceChange);

    // OpenRouter カスタムモデル
    dom.testSaveCustomModelBtn?.addEventListener('click', handleTestSaveCustomModel);

    // モデル選択: 選択 provider に応じて該当 API キーカードを強調
    dom.llmModelSelect?.addEventListener('change', handleModelSelectChange);

    // 基準最適化
    dom.optimizeCriteriaBtn?.addEventListener('click', handleOptimizeCriteria);
    dom.saveCriteriaBtn?.addEventListener('click', handleSaveCriteria);

    // バッチ処理
    dom.startBatchBtn?.addEventListener('click', handleStartBatch);
    dom.stopBatchBtn?.addEventListener('click', handleStopBatch);
    dom.retryFailedBtn?.addEventListener('click', handleRetryFailed);
    dom.batchMaxCountSelect?.addEventListener('change', updateBatchTargetCount);

    // 閾値調整
    dom.thresholdSlider?.addEventListener('input', handleThresholdChange);
    dom.toggleDistributionBtn?.addEventListener('click', toggleDistributionChart);
    dom.confirmThresholdBtn?.addEventListener('click', handleConfirmThreshold);

    // 孤立判定の復旧
    dom.recoverOrphansBtn?.addEventListener('click', handleRecoverOrphans);

    // 折りたたみセクション
    document.querySelectorAll('.llm-card.collapsible .collapsible-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // ヘルプアイコンのクリックでは折りたたまない
            if ((e.target as HTMLElement)?.closest('.help-icon')) {
                return;
            }
            const card = header.closest('.llm-card.collapsible');
            card?.classList.toggle('collapsed');
        });
    });
}

/**
 * タブを切り替え
 * 注意: renderLayoutでStore経由でセクション表示が制御されるため、
 * ここではStore更新とLLM初期化のみ行う
 */
export function switchToTab(tab: 'screening' | 'llm' | 'ml') {
    hideToast();
    // Store経由で両方に同期（renderLayoutで表示が更新される）
    syncChangeTab(tab);

    // LLMタブの場合は初期化を行う
    if (tab === 'llm') {
        initializeLlmSection();
    }
}

/**
 * LLMセクションを初期化
 */
export async function initializeLlmSection() {
    try {
        // 先にAPIキーの状態を確認 (Gemini / OpenRouter)。モデル選択肢は鍵有無に依存するため。
        await loadApiKeyStatus();
        await loadOpenRouterApiKeyStatus();

        // OpenRouter カスタムモデル一覧を読み込み（モデルセレクト構築前に必要）
        await loadCustomModelsList();

        // モデル選択オプションを動的に生成（鍵が設定済みの provider のみ + 登録カスタムモデル）
        await populateModelSelect();

        // LLM設定を読み込み
        const spreadsheetId = state.spreadsheetId;
        if (spreadsheetId) {
            const llmConfig = await getLlmConfig(spreadsheetId);
            // Store経由で両方に同期
            syncSetLlmConfig(llmConfig);

            // UI更新: 保存済みモデルが鍵未設定で除外されている場合は先頭にフォールバック
            const savedModel = llmConfig.llm_model;
            const isSavedModelAvailable =
                Array.from(dom.llmModelSelect.options).some(o => o.value === savedModel);
            if (isSavedModelAvailable) {
                dom.llmModelSelect.value = savedModel;
            } else if (dom.llmModelSelect.options.length > 0) {
                dom.llmModelSelect.value = dom.llmModelSelect.options[0].value;
                showToast(t('llm_modelFallbackToast'), 4000);
            }
            handleModelSelectChange();
            dom.llmLanguageSelect.value = llmConfig.llm_output_language;
            dom.protocolTextInput.value = llmConfig.llm_protocol_text;
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
 * LLM戻るボタン
 */
export function handleLlmBack() {
    switchToTab('screening');
    if (_handleBack) {
        _handleBack();
    }
}
