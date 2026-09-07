/**
 * LLM基準最適化モジュール
 */

import { dom } from './dom';
import { state } from '../../state';
import type { LlmCriteria } from '../../../lib/types';
import { updateLlmConfig } from '../../../lib/sheets-api';
import { updateBatchTargetCount } from './batch';
import { getEffectiveApiKey, getEffectiveOpenRouterApiKey, getEffectiveOpenAiApiKey } from '../../../lib/storage';
import { getStandardCriteriaFields, AVAILABLE_MODELS, getModelConfig } from '../../../lib/gemini-api';
import { resolveProviderId, convertCriteriaWithProvider } from '../../../lib/llm-provider';
import { showToast } from '../../ui/feedback';
import { escapeHtml } from '../../utils/text';
import { t } from '../../../lib/i18n';
import { CRITERIA_FIELD_LABELS } from '../../../lib/review-criteria';

// Store互換レイヤー（Phase 5）
import { setLlmConfig as syncSetLlmConfig } from '../../store/compat';

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

    // 選択中のモデルから provider を判定し、必要な API キーを取得
    const selectedModelId = dom.llmModelSelect.value;
    const selectedProvider = resolveProviderId(selectedModelId, AVAILABLE_MODELS);
    const apiKey = selectedProvider === 'openrouter'
        ? await getEffectiveOpenRouterApiKey()
        : selectedProvider === 'openai'
            ? await getEffectiveOpenAiApiKey()
            : await getEffectiveApiKey();
    if (!apiKey) {
        const missingKeyMessageKey = selectedProvider === 'openrouter'
            ? 'llm_openRouterApiKeyRequired'
            : selectedProvider === 'openai'
                ? 'llm_openAiApiKeyRequired'
                : 'llm_apiKeyRequired';
        showToast(t(missingKeyMessageKey));
        return;
    }

    try {
        dom.optimizeCriteriaBtn.disabled = true;
        dom.optimizeStatusDiv.textContent = t('llm_optimizing');
        dom.optimizeStatusDiv.className = 'optimize-status loading';
        dom.optimizeStatusDiv.classList.remove('hidden');

        // 選択中モデルの既定設定を取得し、criteria 用に出力上限だけ上書きする
        const baseConfig = getModelConfig(selectedModelId);
        const params = {
            protocolText,
            model: baseConfig.model,
            temperature: baseConfig.temperature,
            topP: baseConfig.topP,
            thinkingLevel: baseConfig.model === 'gemini-3-flash-preview' ? 'MINIMAL' : baseConfig.thinkingLevel,
            reasoningEffort: baseConfig.reasoningEffort,
            maxOutputTokens: 4096,
            outputLanguage: dom.llmLanguageSelect.value,
        };

        const result = await convertCriteriaWithProvider(
            selectedProvider,
            params,
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
        // Store経由で更新
        syncSetLlmConfig(llmConfig);

        dom.optimizeStatusDiv.textContent = t('llm_optimizeComplete');
        dom.optimizeStatusDiv.className = 'optimize-status success';

        // ボタンを薄い色に変更（確定済み状態）
        dom.optimizeCriteriaBtn.classList.add('confirmed');

        // 保存ボタンを表示
        dom.saveCriteriaBtn.classList.remove('hidden');

        // 基準とプロンプトを差し替えると config_hash が変わって別 Run になるが、
        // 代入では input イベントが飛ばないため件数表示が更新されない。明示的に再計算する。
        // 件数表示の再計算に失敗しても最適化自体は成功しているので、エラー表示には倒さない
        await updateBatchTargetCount().catch(err =>
            console.error('[handleOptimizeCriteria] Failed to refresh batch target count:', err)
        );
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

/**
 * 「レビュー基準をコピー」ボタンの表示を state.reviewCriteria の有無に合わせる。
 *
 * initializeLlmSection から呼ぶ（AIタブへ切り替えるたびに走るので、モーダル側で
 * 基準を登録・更新した直後にもここで拾える）。
 */
export function updateImportReviewCriteriaVisibility() {
    const hasCriteria = !!state.reviewCriteria?.text.trim();
    dom.importReviewCriteriaBtn?.classList.toggle('hidden', !hasCriteria);
}

/**
 * 人間向けレビュー基準をプロトコル欄へコピーする。
 *
 * 自動では流し込まない（41f89b2 参照）。ユーザーが押したときだけ入れる。
 * 入力済みの内容がある場合は確認してから上書きする。
 */
export function handleImportReviewCriteria() {
    const text = state.reviewCriteria?.text.trim();
    // 基準が無いときはボタン自体を隠しているので、ここは念のための番人
    if (!text) return;
    if (dom.protocolTextInput.value.trim() !== '' && !confirm(t('criteria_importConfirmOverwrite'))) {
        return;
    }
    dom.protocolTextInput.value = text;
    // 保存は行わない。ここで入れた内容は「基準を保存」を押したときに llm_protocol_text になる。
    dom.protocolTextInput.focus();
}
