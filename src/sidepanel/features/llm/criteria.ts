/**
 * LLM基準最適化モジュール
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmCriteria } from '../../../lib/types';
import { updateLlmConfig } from '../../../lib/sheets-api';
import { getEffectiveApiKey } from '../../../lib/storage';
import { convertCriteria, GeminiModelConfig, getStandardCriteriaFields } from '../../../lib/gemini-api';
import { showToast } from '../../ui/feedback';
import { escapeHtml } from '../../utils/text';
import { t } from '../../../lib/i18n';

// Store互換レイヤー（Phase 5）
import { setLlmConfig as syncSetLlmConfig } from '../../store/compat';

const CRITERIA_FIELD_LABELS: Record<string, { ja: string; en: string }> = {
    P: { ja: '対象患者/集団', en: 'Population' },
    I: { ja: '介入', en: 'Intervention' },
    E: { ja: '曝露', en: 'Exposure' },
    C: { ja: '比較対照', en: 'Comparator' },
    O: { ja: 'アウトカム', en: 'Outcome' },
    S: { ja: 'サンプル/セッティング', en: 'Sample/Setting' },
    PI: { ja: '関心現象', en: 'Phenomenon of Interest' },
    D: { ja: '研究デザイン', en: 'Design' },
    R: { ja: '研究タイプ', en: 'Research Type' },
};

function isJapaneseOutput(): boolean {
    return dom.llmLanguageSelect.value.toLowerCase().startsWith('ja');
}

function getFieldLabel(key: string): string {
    const label = CRITERIA_FIELD_LABELS[key];
    if (!label) return key;
    return `${key} (${isJapaneseOutput() ? label.ja : label.en})`;
}

function getEmptyFieldText(): string {
    return isJapaneseOutput() ? '指定なし' : 'Not specified';
}

function getRetryStatusText(attempt: number, maxRetries: number): string {
    return isJapaneseOutput()
        ? `再試行中 (${attempt}/${maxRetries})...`
        : `Retrying (${attempt}/${maxRetries})...`;
}

/**
 * 基準を最適化
 */
export async function handleOptimizeCriteria() {
    const protocolText = dom.protocolTextInput.value.trim();
    if (!protocolText) {
        showToast(t('llm_protocolRequired'));
        return;
    }

    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast(t('llm_apiKeyRequired'));
        return;
    }

    try {
        dom.optimizeCriteriaBtn.disabled = true;
        dom.optimizeStatusDiv.textContent = t('llm_optimizing');
        dom.optimizeStatusDiv.className = 'optimize-status loading';
        dom.optimizeStatusDiv.classList.remove('hidden');

        const modelConfig: GeminiModelConfig = {
            model: dom.llmModelSelect.value,
            temperature: 0,
            maxOutputTokens: 4096,
        };
        if (modelConfig.model === 'gemini-3-flash-preview') {
            modelConfig.thinkingLevel = 'MINIMAL';
        }

        const result = await convertCriteria(
            protocolText,
            modelConfig,
            dom.llmLanguageSelect.value,
            {
                onRetry: (attempt, maxRetries) => {
                    dom.optimizeStatusDiv.textContent = getRetryStatusText(attempt, maxRetries);
                },
            }
        );

        // 結果を表示
        renderOptimizedCriteria(result.criteria, result.screening_prompt);

        // 設定を更新
        const llmConfig = state.llmConfig;
        llmConfig.llm_criteria = result.criteria;
        llmConfig.llm_screening_prompt = result.screening_prompt;
        llmConfig.llm_protocol_text = protocolText;
        // Store経由で両方に同期
        syncSetLlmConfig(llmConfig);

        dom.optimizeStatusDiv.textContent = t('llm_optimizeComplete');
        dom.optimizeStatusDiv.className = 'optimize-status success';

        // ボタンを薄い色に変更（確定済み状態）
        dom.optimizeCriteriaBtn.classList.add('confirmed');

        // 保存ボタンを表示
        dom.saveCriteriaBtn.classList.remove('hidden');
    } catch (error) {
        console.error('[handleOptimizeCriteria] Error:', error);
        dom.optimizeStatusDiv.textContent = t('llm_optimizeError', (error as Error).message);
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
        'custom': t('llm_templateCustom'),
    }[criteria.template] || criteria.template;

    const templateDiv = document.createElement('div');
    templateDiv.className = 'criteria-field';
    templateDiv.innerHTML = `<strong>${t('llm_templateLabel')}</strong> ${templateLabel}`;
    dom.optimizedCriteriaDisplay.appendChild(templateDiv);

    const displayedKeys = new Set<string>();
    const fieldEntries: Array<[string, string]> = [];
    for (const key of getStandardCriteriaFields(criteria.template)) {
        fieldEntries.push([key, criteria.fields[key] || '']);
        displayedKeys.add(key);
    }
    for (const [key, value] of Object.entries(criteria.fields)) {
        if (!displayedKeys.has(key)) {
            fieldEntries.push([key, value]);
        }
    }

    for (const [key, value] of fieldEntries) {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = 'criteria-field';
        fieldDiv.innerHTML = `<strong>${escapeHtml(getFieldLabel(key))}:</strong> ${escapeHtml(value || getEmptyFieldText())}`;
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

        showToast(t('llm_criteriaSaved'));

        // 保存成功時：確定状態のスタイルを適用
        dom.criteriaCard.classList.add('confirmed');
    } catch (error) {
        console.error('[handleSaveCriteria] Error:', error);
        showToast(t('llm_criteriaSaveError'));
    } finally {
        dom.saveCriteriaBtn.disabled = false;
    }
}
