import type { Decision } from '../../../lib/types';
import { computeLlmValidation, judgeValidation } from '../../../lib/llm-validation';
import type { LlmValidationResult } from '../../../lib/llm-validation';
import { collectReviewerKeys } from '../../../lib/decision-summary';
import { updateLlmConfig } from '../../../lib/sheets-api';
import { t } from '../../../lib/i18n';
import { state } from '../../state';
import { setLlmConfig } from '../../store/compat';
import { showToast } from '../../ui/feedback';
import { dom } from './dom';

export function computeCurrentValidation(decisions: Decision[], threshold: number): LlmValidationResult {
    return computeLlmValidation({
        refs: state.allReferences,
        aiDecisions: decisions,
        threshold,
        reviewerKeys: collectReviewerKeys(state.allReferences, new Set(), state.treatMlAsManual),
        treatMlAsManual: state.treatMlAsManual,
        assignmentConfig: state.assignmentConfig,
    });
}

function percent(value: number | null): string {
    return value === null ? '—' : (value * 100).toFixed(1);
}

/**
 * 色に依存せず、比較件数と合否を文章で表示する。
 * 閾値の欄が縦に長くなると操作ツアーの吹き出しが確定ボタンに重なるため、
 * 見出し（合否、または比べられた件数）だけを常に出し、内訳と指標は折りたたむ。
 */
export function renderValidationResult(result: LlmValidationResult): void {
    const maxMissRate = state.llmConfig.llm_validation_max_miss_rate ?? 0.05;
    const counts = t('llm_validationCounts', [
        String(result.compared), String(result.humanIncludes), String(result.humanExcludes),
    ]);
    const unresolved = t('llm_validationUnresolved', [
        String(result.unresolved.conflict), String(result.unresolved.maybe),
        String(result.unresolved.incomplete), String(result.unresolved.pending),
    ]);
    let headline: string;
    const details: string[] = [];
    if (result.compared === 0) {
        // 比べられる文献が無いときは、空の指標や合否を並べずに案内だけを出す
        headline = counts;
        details.push(unresolved, t('llm_validationNoComparison'));
    } else {
        const judgment = judgeValidation(result, maxMissRate);
        headline = t(`llm_validation_${judgment}`, [percent(maxMissRate), percent(result.missRate)]);
        details.push(counts, unresolved, t('llm_validationMetrics', [
            String(result.missed), percent(result.missRate), String(result.falseIncludes),
            percent(result.specificity), percent(result.agreement),
        ]));
        if (judgment !== 'insufficient' && result.humanIncludes < 10) {
            details.push(t('llm_validationSmallSample'));
        }
    }

    // スライダーを動かすたびに描き直すので、開閉の状態を引き継ぐ
    const wasOpen = dom.validationResult.querySelector('details')?.open ?? false;
    const box = document.createElement('details');
    box.open = wasOpen;
    const summary = document.createElement('summary');
    summary.className = 'help-text';
    summary.textContent = headline;
    box.appendChild(summary);
    for (const line of details) {
        const paragraph = document.createElement('p');
        paragraph.className = 'help-text';
        paragraph.textContent = line;
        box.appendChild(paragraph);
    }
    dom.validationResult.replaceChildren(box);
}

export async function handleSaveValidationCriterion(): Promise<void> {
    const input = dom.validationMaxMissRate;
    const value = Number(input.value);
    if (!input.value.trim() || !input.checkValidity() || !Number.isFinite(value) || value < 0 || value > 100) {
        showToast(t('llm_validationInvalid'));
        return;
    }
    const updates = {
        llm_validation_max_miss_rate: value / 100,
        llm_validation_criterion_set_at: new Date().toISOString(),
    };
    try {
        dom.validationSaveBtn.disabled = true;
        await updateLlmConfig(state.spreadsheetId, updates);
        setLlmConfig({ ...state.llmConfig, ...updates });
        renderValidationResult(computeCurrentValidation(state.currentBatchDecisions, Number(dom.thresholdSlider.value)));
        showToast(t('llm_validationSaved'));
    } catch (error) {
        showToast(t('llm_validationSaveError', (error as Error).message));
    } finally {
        dom.validationSaveBtn.disabled = false;
    }
}
