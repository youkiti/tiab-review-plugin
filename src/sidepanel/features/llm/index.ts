/**
 * LLM機能モジュール - エントリポイント
 * LLMタブのイベントリスナー設定と初期化
 */

import { dom } from '../../dom';
import { state } from '../../state';
import { getLlmConfig } from '../../../lib/sheets-api';
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
    handleThresholdChange,
    toggleDistributionChart,
    handleConfirmThreshold,
    loadExecutionHistory,
} from './batch';

// handleBackへの参照（循環依存回避のため関数として渡す）
let _handleBack: (() => void) | null = null;

export function setHandleBack(fn: () => void) {
    _handleBack = fn;
}

/**
 * LLMイベントリスナーを設定
 */
export function setupLlmEventListeners() {
    // タブ切り替え
    dom.tabScreeningBtn?.addEventListener('click', () => switchToTab('screening'));
    dom.tabLlmBtn?.addEventListener('click', () => switchToTab('llm'));

    // LLM戻るボタン
    dom.llmBackBtn?.addEventListener('click', handleLlmBack);

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
 */
export function switchToTab(tab: 'screening' | 'llm') {
    state.setCurrentTab(tab);

    if (tab === 'screening') {
        dom.tabScreeningBtn?.classList.add('active');
        dom.tabLlmBtn?.classList.remove('active');
        dom.screeningSection.classList.remove('hidden');
        dom.llmSection?.classList.add('hidden');
    } else {
        dom.tabScreeningBtn?.classList.remove('active');
        dom.tabLlmBtn?.classList.add('active');
        dom.screeningSection.classList.add('hidden');
        dom.llmSection?.classList.remove('hidden');

        // LLMセクションを初期化
        initializeLlmSection();
    }
}

/**
 * LLMセクションを初期化
 */
export async function initializeLlmSection() {
    try {
        // APIキーの状態を確認
        await loadApiKeyStatus();

        // LLM設定を読み込み
        const spreadsheetId = state.spreadsheetId;
        if (spreadsheetId) {
            const llmConfig = await getLlmConfig(spreadsheetId);
            state.setLlmConfig(llmConfig);

            // UI更新
            dom.llmModelSelect.value = llmConfig.llm_model;
            dom.llmLanguageSelect.value = llmConfig.llm_output_language;
            dom.protocolTextInput.value = llmConfig.llm_protocol_text;
            dom.thresholdSlider.value = llmConfig.llm_include_threshold.toString();
            dom.thresholdValueDisplay.textContent = llmConfig.llm_include_threshold.toFixed(2);

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
 * LLM戻るボタン
 */
export function handleLlmBack() {
    switchToTab('screening');
    if (_handleBack) {
        _handleBack();
    }
}
