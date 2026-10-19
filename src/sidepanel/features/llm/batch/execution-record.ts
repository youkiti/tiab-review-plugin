// 通常実行とリトライで、送信条件と履歴の結合キーを同じ手順で確定する。
import { createLlmExecution, generateLlmReviewerId } from '../../../../lib/llm-processor';
import type { GeminiModelConfig } from '../../../../lib/gemini-api';
import type { LlmCriteria } from '../../../../lib/types';
import type { LlmTargetMode } from '../../../../lib/llm-target-selection';
import { sentGenerationSettings } from '../../../../lib/model-generation-settings';
import { buildTiabPromptTemplate, recordPromptTemplate } from '../../../../lib/llm-prompt-record';

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
