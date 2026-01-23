/**
 * LLM機能モジュール - エントリポイント
 * LLMタブのイベントリスナー設定と初期化
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { getLlmConfig } from '../../../lib/sheets-api';
import { AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG } from '../../../lib/gemini-api';
import { showSettings } from '../settings';
import { hideToast } from '../../ui/feedback';
import {
    loadApiKeyStatus,
    toggleApiKeyVisibility,
    handleApiKeyAutoSave,
    handleSavePreferenceChange,
} from './api-key';
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
} from './batch';

// Store互換レイヤー（Phase 5）
import {
    changeTab as syncChangeTab,
    setLlmConfig as syncSetLlmConfig,
} from '../../store/compat';

/**
 * モデル選択のオプションを動的に生成
 * AVAILABLE_MODELSを参照し、DEFAULT_MODEL_CONFIGでデフォルト選択を設定
 */
function populateModelSelect(): void {
    const select = dom.llmModelSelect;
    select.innerHTML = '';

    for (const model of AVAILABLE_MODELS) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        if (model.id === DEFAULT_MODEL_CONFIG.model) {
            option.selected = true;
        }
        select.appendChild(option);
    }
}

// handleBackへの参照（循環依存回避のため関数として渡す）
let _handleBack: (() => void) | null = null;

export function setHandleBack(fn: () => void) {
    _handleBack = fn;
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

    // APIキー関連
    dom.toggleApiKeyVisibilityBtn?.addEventListener('click', toggleApiKeyVisibility);
    dom.geminiApiKeyInput?.addEventListener('change', handleApiKeyAutoSave);
    dom.saveApiKeyCheckbox?.addEventListener('change', handleSavePreferenceChange);

    // 基準最適化
    dom.optimizeCriteriaBtn?.addEventListener('click', handleOptimizeCriteria);
    dom.saveCriteriaBtn?.addEventListener('click', handleSaveCriteria);

    // バッチ処理
    dom.startBatchBtn?.addEventListener('click', handleStartBatch);
    dom.stopBatchBtn?.addEventListener('click', handleStopBatch);
    dom.retryFailedBtn?.addEventListener('click', handleRetryFailed);

    // 閾値調整
    dom.thresholdSlider?.addEventListener('input', handleThresholdChange);
    dom.toggleDistributionBtn?.addEventListener('click', toggleDistributionChart);
    dom.confirmThresholdBtn?.addEventListener('click', handleConfirmThreshold);

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
        // モデル選択オプションを動的に生成
        populateModelSelect();

        // APIキーの状態を確認
        await loadApiKeyStatus();

        // LLM設定を読み込み
        const spreadsheetId = state.spreadsheetId;
        if (spreadsheetId) {
            const llmConfig = await getLlmConfig(spreadsheetId);
            // Store経由で両方に同期
            syncSetLlmConfig(llmConfig);

            // UI更新
            dom.llmModelSelect.value = llmConfig.llm_model;
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
