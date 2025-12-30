/**
 * LLM基準最適化モジュール
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmCriteria } from '../../../lib/types';
import { updateLlmConfig } from '../../../lib/sheets-api';
import { getEffectiveApiKey } from '../../../lib/storage';
import { convertCriteria, GeminiModelConfig } from '../../../lib/gemini-api';
import { showToast } from '../../ui/feedback';
import { escapeHtml } from '../../utils/text';

/**
 * 基準を最適化
 */
export async function handleOptimizeCriteria() {
    const protocolText = dom.protocolTextInput.value.trim();
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
        dom.optimizeCriteriaBtn.disabled = true;
        dom.optimizeStatusDiv.textContent = '🔄 基準を最適化中...';
        dom.optimizeStatusDiv.className = 'optimize-status loading';
        dom.optimizeStatusDiv.classList.remove('hidden');

        const modelConfig: GeminiModelConfig = {
            model: dom.llmModelSelect.value,
            temperature: 0,
            maxOutputTokens: 2048,
        };

        const result = await convertCriteria(
            protocolText,
            modelConfig,
            dom.llmLanguageSelect.value
        );

        // 結果を表示
        renderOptimizedCriteria(result.criteria, result.screening_prompt);

        // 設定を更新
        const llmConfig = state.llmConfig;
        llmConfig.llm_criteria = result.criteria;
        llmConfig.llm_screening_prompt = result.screening_prompt;
        llmConfig.llm_protocol_text = protocolText;
        state.setLlmConfig(llmConfig);

        dom.optimizeStatusDiv.textContent = '✓ 最適化完了';
        dom.optimizeStatusDiv.className = 'optimize-status success';

        // 保存ボタンを表示
        dom.saveCriteriaBtn.classList.remove('hidden');
    } catch (error) {
        console.error('[handleOptimizeCriteria] Error:', error);
        dom.optimizeStatusDiv.textContent = `✕ エラー: ${(error as Error).message}`;
        dom.optimizeStatusDiv.className = 'optimize-status error';
    } finally {
        dom.optimizeCriteriaBtn.disabled = false;
    }
}

/**
 * 最適化された基準を表示
 */
export function renderOptimizedCriteria(criteria: LlmCriteria, screeningPrompt: string) {
    dom.optimizedCriteriaDisplay.innerHTML = '';

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
    dom.optimizedCriteriaDisplay.appendChild(templateDiv);

    for (const [key, value] of Object.entries(criteria.fields)) {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'criteria-field';
        fieldDiv.innerHTML = `<strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}`;
        dom.optimizedCriteriaDisplay.appendChild(fieldDiv);
    }

    // スクリーニングプロンプトを設定
    dom.screeningPromptInput.value = screeningPrompt;
    dom.screeningPromptInput.classList.remove('hidden');
}

/**
 * 基準を保存
 */
export async function handleSaveCriteria() {
    try {
        dom.saveCriteriaBtn.disabled = true;

        await updateLlmConfig(state.spreadsheetId, {
            llm_protocol_text: dom.protocolTextInput.value,
            llm_criteria: state.llmConfig.llm_criteria,
            llm_screening_prompt: dom.screeningPromptInput.value,
            llm_model: dom.llmModelSelect.value,
            llm_output_language: dom.llmLanguageSelect.value,
        });

        showToast('基準を保存しました');
    } catch (error) {
        console.error('[handleSaveCriteria] Error:', error);
        showToast('保存に失敗しました');
    } finally {
        dom.saveCriteriaBtn.disabled = false;
    }
}
