import type { AssignmentConfig, Decision, ReferenceWithStatus } from './types';
import { summarizeTeamDecision } from './decision-summary';
import { isMlAutoDecision } from './client-version';
import { isTiabDecision } from './fulltext-pool';
import { applyThreshold, parseLlmDecisionNote } from './llm-processor';

export interface LlmValidationResult {
    compared: number;
    humanIncludes: number;
    humanExcludes: number;
    missed: number;
    falseIncludes: number;
    unresolved: { conflict: number; maybe: number; incomplete: number; pending: number };
    missRate: number | null;
    specificity: number | null;
    agreement: number | null;
}

/** 人の合議が決まった文献について、対象 Run の最新の AI 票と比較する。 */
export function computeLlmValidation(params: {
    refs: ReferenceWithStatus[];
    aiDecisions: Decision[];
    threshold: number;
    reviewerKeys: string[];
    treatMlAsManual: boolean;
    assignmentConfig?: AssignmentConfig | null;
}): LlmValidationResult {
    const result: LlmValidationResult = {
        compared: 0, humanIncludes: 0, humanExcludes: 0, missed: 0, falseIncludes: 0,
        unresolved: { conflict: 0, maybe: 0, incomplete: 0, pending: 0 },
        missRate: null, specificity: null, agreement: null,
    };
    const latest = new Map<string, Decision>();
    for (const decision of params.aiDecisions) {
        if (!isTiabDecision(decision)) {
            continue;
        }
        const previous = latest.get(decision.ref_id);
        if (!previous || decision.decided_at >= previous.decided_at) {
            latest.set(decision.ref_id, decision);
        }
    }
    const humanKeys = params.reviewerKeys.filter(key => !key.startsWith('llm:'));
    for (const ref of params.refs) {
        const ai = latest.get(ref.ref_id);
        const note = ai ? parseLlmDecisionNote(ai.note || '') : null;
        if (!note) {
            continue;
        }
        const humanRef = {
            ...ref,
            allDecisions: (ref.allDecisions || []).filter(decision => isTiabDecision(decision)
                && !decision.reviewer_id.startsWith('llm:') && !isMlAutoDecision(decision.client_version)),
        };
        const { teamStatus } = summarizeTeamDecision(
            humanRef, humanKeys, params.treatMlAsManual, params.assignmentConfig,
        );
        if (teamStatus !== 'include' && teamStatus !== 'exclude') {
            if (teamStatus !== 'blinded') {
                result.unresolved[teamStatus]++;
            }
            continue;
        }
        const aiIncludes = applyThreshold(note.include_probability, params.threshold) === 'include';
        result.compared++;
        if (teamStatus === 'include') {
            result.humanIncludes++;
            if (!aiIncludes) {
                result.missed++;
            }
        } else {
            result.humanExcludes++;
            if (aiIncludes) {
                result.falseIncludes++;
            }
        }
    }
    result.missRate = result.humanIncludes ? result.missed / result.humanIncludes : null;
    result.specificity = result.humanExcludes ? (result.humanExcludes - result.falseIncludes) / result.humanExcludes : null;
    result.agreement = result.compared ? (result.compared - result.missed - result.falseIncludes) / result.compared : null;
    return result;
}

export function judgeValidation(result: LlmValidationResult, maxMissRate: number): 'pass' | 'fail' | 'insufficient' {
    if (result.humanIncludes === 0 || result.missRate === null) {
        return 'insufficient';
    }
    return result.missRate <= maxMissRate ? 'pass' : 'fail';
}
