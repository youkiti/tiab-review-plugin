import type { Decision, LlmConfig, LlmRun, ReferenceWithStatus, AssignmentConfig } from '../../../lib/types';
import { collectReviewerKeys } from '../../../lib/decision-summary';
import { computeLlmValidation } from '../../../lib/llm-validation';
import type { LlmValidationResult } from '../../../lib/llm-validation';

/** キー未開封は比較ゼロと区別し、配られていない人の判定を集計しない。 */
export function computeReviewValidation(params: {
    isKeyOpened: boolean;
    refs: ReferenceWithStatus[];
    aiDecisions: Decision[];
    threshold: number;
    treatMlAsManual: boolean;
    assignmentConfig: AssignmentConfig | null;
}): LlmValidationResult | null {
    if (!params.isKeyOpened) {
        return null;
    }
    return computeLlmValidation({
        ...params,
        reviewerKeys: collectReviewerKeys(params.refs, new Set(), params.treatMlAsManual),
    });
}

/** 比較不能のときは検証列を渡さず、保存済みの検証結果も保持する。 */
export function buildThresholdConfirmationUpdates(
    threshold: number, validation: LlmValidationResult | null, config: LlmConfig, evaluatedAt: string,
): Partial<LlmRun> {
    const updates: Partial<LlmRun> = {
        include_threshold: threshold,
        status: 'confirmed',
        is_active: true,
    };
    if (validation === null) {
        return updates;
    }
    return {
        ...updates,
        validation_compared: validation.compared,
        validation_human_includes: validation.humanIncludes,
        validation_missed: validation.missed,
        validation_false_includes: validation.falseIncludes,
        validation_max_miss_rate: config.llm_validation_max_miss_rate ?? 0.05,
        validation_criterion_set_at: config.llm_validation_criterion_set_at ?? '',
        validation_evaluated_at: evaluatedAt,
    };
}

export function validationUnavailableMessageKey(result: LlmValidationResult | null): string | null {
    return result === null ? 'llm_validationKeyUnopened' : null;
}
