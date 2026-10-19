// 通常実行の記録と、失敗を生んだ実行の再開条件を組み立てる。
import { createLlmExecution, generateLlmReviewerId } from '../../../../lib/llm-processor';
import { findModelConfig, type GeminiModelConfig } from '../../../../lib/gemini-api';
import type { Decision, LlmCriteria, LlmExecution } from '../../../../lib/types';
import type { LlmTargetMode } from '../../../../lib/llm-target-selection';
import { getModelGenerationSettings, sentGenerationSettings } from '../../../../lib/model-generation-settings';
import { buildTiabPromptTemplate, recordPromptTemplate } from '../../../../lib/llm-prompt-record';

export function resolveBatchRetry(
    failedState: { failedSourceExecutionId: string | null },
    executions: readonly LlmExecution[],
    timestamp = new Date(),
) {
    const execution = executions.find(row => row.execution_id === failedState.failedSourceExecutionId);
    if (!execution) {
        return { error: 'llm_retryMissingExecution' as const };
    }
    const model = execution.requested_model || execution.model;
    const base = findModelConfig(model);
    if (!base) {
        return { error: 'llm_retryUnavailableModel' as const };
    }
    const provider = getModelGenerationSettings(model).provider;
    const effort = execution.prompt_sha256 ? execution.reasoning_effort
        : provider === 'openai' || provider === 'anthropic' ? 'low' : undefined;
    const modelConfig: GeminiModelConfig = {
        model: base.model,
        temperature: execution.temperature,
        topP: execution.topP,
        thinkingLevel: execution.thinkingLevel,
        reasoningEffort: effort as GeminiModelConfig['reasoningEffort'],
        // Anthropic の記録は思考分を加算済みなので、送信時の二重加算を避ける。
        maxOutputTokens: provider === 'anthropic' && execution.max_output_tokens !== undefined
            ? execution.max_output_tokens - 4000 : execution.max_output_tokens,
    };
    return { execution, modelConfig, executionId: execution.execution_id, timestamp };
}

export function countExecutionReferences(decisions: readonly Decision[], executionId: string): number {
    return new Set(decisions.filter(d => d.reviewer_id === executionId).map(d => d.ref_id)).size;
}

export async function buildBatchExecutionRecord(options: {
    modelConfig: GeminiModelConfig;
    criteria: LlmCriteria | null;
    screeningPrompt: string;
    outputLanguage: string;
    runId: string;
    executedBy: string;
    targetCount: number;
    targetMeta: { mode: LlmTargetMode; sets?: string; selectedCount?: number };
    timestamp?: Date;
}) {
    const timestamp = options.timestamp ?? new Date();
    const executionId = generateLlmReviewerId(options.modelConfig.model, timestamp);
    const execution = createLlmExecution(
        executionId, 'batch_screening', options.modelConfig.model, options.criteria,
        options.screeningPrompt, 0, options.targetCount, 0, 0, 'pending', false,
        undefined, undefined, undefined, options.targetMeta,
    );
    Object.assign(execution, sentGenerationSettings(options.modelConfig.model, options.modelConfig),
        await recordPromptTemplate(buildTiabPromptTemplate(
            options.modelConfig.model, options.screeningPrompt, options.outputLanguage, options.criteria,
        )));
    execution.timestamp = timestamp.toISOString();
    execution.run_id = options.runId;
    execution.executed_by = options.executedBy;
    return { execution, executionId, timestamp };
}
