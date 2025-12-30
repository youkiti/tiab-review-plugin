// llm-processor.ts - LLMバッチ処理ロジック

import type {
    Reference,
    Decision,
    LlmBatchProgress,
    LlmScreeningOutput,
    LlmDecisionNote,
    LlmConfig,
    LlmExecution,
    LlmCriteria,
} from './types';
import { screenReference, GeminiModelConfig } from './gemini-api';
import { PROMPT_VERSION } from './prompt-templates';

/**
 * 進捗コールバック型
 */
export type ProgressCallback = (progress: LlmBatchProgress) => void;

/**
 * LLM判定用のreviewer_idを生成
 * 形式: llm:{model}@{timestamp}
 */
export function generateLlmReviewerId(model: string, timestamp: Date): string {
    return `llm:${model}@${timestamp.toISOString()}`;
}

/**
 * reviewer_idがLLM判定かどうかを判定
 */
export function isLlmReviewerId(reviewerId: string): boolean {
    return reviewerId.startsWith('llm:');
}

/**
 * LLM判定のnote JSONを生成
 */
export function createLlmDecisionNote(
    executionId: string,
    model: string,
    output: LlmScreeningOutput
): LlmDecisionNote {
    return {
        type: 'llm',
        execution_id: executionId,
        model,
        include_probability: output.include_probability,
        reasons: output.reasons,
        evidence: output.evidence,
        prompt_version: PROMPT_VERSION,
    };
}

/**
 * noteフィールドからLlmDecisionNoteをパース
 */
export function parseLlmDecisionNote(note: string): LlmDecisionNote | null {
    if (!note) return null;
    try {
        const parsed = JSON.parse(note);
        if (parsed.type === 'llm') {
            return parsed as LlmDecisionNote;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * include_probabilityから閾値に基づいてdecisionを決定
 */
export function applyThreshold(
    includeProbability: number,
    threshold: number
): 'include' | 'exclude' {
    return includeProbability >= threshold ? 'include' : 'exclude';
}

/**
 * 理由配列を要約文字列に変換
 */
export function summarizeReasons(reasons: string[]): string {
    if (reasons.length === 0) return '';
    if (reasons.length === 1) return reasons[0];
    return reasons.slice(0, 3).join('。');
}

/**
 * バッチ処理オプション
 */
export interface BatchProcessOptions {
    batchSize: number; // 1回の保存単位の件数
    screeningPrompt: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
    outputLanguage: string;
    onProgress?: ProgressCallback;
    onSaveBatch?: (decisions: Decision[]) => Promise<void>;
    abortSignal?: AbortSignal;
}

/**
 * バッチ処理の結果
 */
export interface BatchProcessResult {
    executionId: string;
    processedCount: number;
    successCount: number;
    failCount: number;
    decisions: Decision[];
}

/**
 * 複数の文献をバッチ処理（並列実行）
 */
export async function processBatch(
    references: Reference[],
    options: BatchProcessOptions
): Promise<BatchProcessResult> {
    const timestamp = new Date();
    const executionId = generateLlmReviewerId(options.model, timestamp);

    const progress: LlmBatchProgress = {
        total: references.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        isRunning: true,
    };

    const allDecisions: Decision[] = [];

    const modelConfig: GeminiModelConfig = {
        model: options.model,
        temperature: options.temperature,
        maxOutputTokens: options.maxOutputTokens,
    };

    // バッチサイズごとに並列処理
    for (let batchStart = 0; batchStart < references.length; batchStart += options.batchSize) {
        // アボートチェック
        if (options.abortSignal?.aborted) {
            progress.isRunning = false;
            options.onProgress?.(progress);
            break;
        }

        const batchEnd = Math.min(batchStart + options.batchSize, references.length);
        const batchRefs = references.slice(batchStart, batchEnd);

        // バッチ内の文献を並列処理
        const batchPromises = batchRefs.map(async (ref) => {
            try {
                // LLMスクリーニング実行
                const output = await screenReference(
                    ref.title,
                    ref.abstract || '',
                    options.screeningPrompt,
                    modelConfig,
                    options.outputLanguage
                );

                // Decision作成（Phase 1: pending状態）
                const noteData = createLlmDecisionNote(executionId, options.model, output);
                const decision: Decision = {
                    decision_id: crypto.randomUUID(),
                    ref_id: ref.ref_id,
                    reviewer_id: executionId,
                    decision: 'pending',
                    reason: '',
                    note: JSON.stringify(noteData),
                    decided_at: timestamp.toISOString(),
                    client_version: 'llm-processor-v1',
                };

                return { success: true, decision };
            } catch (error) {
                console.error(`[processBatch] Failed to process ${ref.ref_id}:`, error);
                return { success: false, decision: null };
            }
        });

        // 並列処理の結果を待つ
        const results = await Promise.all(batchPromises);

        // 結果を集計
        const batchDecisions: Decision[] = [];
        for (const result of results) {
            progress.processed++;
            if (result.success && result.decision) {
                progress.succeeded++;
                batchDecisions.push(result.decision);
                allDecisions.push(result.decision);
            } else {
                progress.failed++;
            }
        }

        options.onProgress?.(progress);

        // バッチを保存
        if (batchDecisions.length > 0 && options.onSaveBatch) {
            await options.onSaveBatch(batchDecisions);
        }

        // レート制限対策: バッチ間で少し待機
        if (batchEnd < references.length) {
            await sleep(200);
        }
    }

    progress.isRunning = false;
    progress.currentRefId = undefined;
    options.onProgress?.(progress);

    return {
        executionId,
        processedCount: progress.processed,
        successCount: progress.succeeded,
        failCount: progress.failed,
        decisions: allDecisions,
    };
}

/**
 * 閾値を適用してdecisionを確定（Phase 2）
 */
export function applyThresholdToDecisions(
    decisions: Decision[],
    threshold: number
): Decision[] {
    return decisions.map((decision) => {
        const noteData = parseLlmDecisionNote(decision.note || '');
        if (!noteData) {
            return decision;
        }

        const newDecision = applyThreshold(noteData.include_probability, threshold);
        const reason = summarizeReasons(noteData.reasons);

        return {
            ...decision,
            decision: newDecision,
            reason,
        };
    });
}

/**
 * include_probabilityの分布を計算（ヒストグラム用）
 */
export function calculateProbabilityDistribution(
    decisions: Decision[],
    bins: number = 5
): { range: string; count: number; min: number; max: number }[] {
    const binSize = 1 / bins;
    const distribution: { range: string; count: number; min: number; max: number }[] = [];

    for (let i = 0; i < bins; i++) {
        const min = i * binSize;
        const max = (i + 1) * binSize;
        distribution.push({
            range: `${min.toFixed(1)}-${max.toFixed(1)}`,
            count: 0,
            min,
            max,
        });
    }

    for (const decision of decisions) {
        const noteData = parseLlmDecisionNote(decision.note || '');
        if (!noteData) continue;

        const prob = noteData.include_probability;
        const binIndex = Math.min(Math.floor(prob * bins), bins - 1);
        distribution[binIndex].count++;
    }

    return distribution;
}

/**
 * 閾値でのinclude/exclude件数をプレビュー
 */
export function previewThresholdCounts(
    decisions: Decision[],
    threshold: number
): { includeCount: number; excludeCount: number } {
    let includeCount = 0;
    let excludeCount = 0;

    for (const decision of decisions) {
        const noteData = parseLlmDecisionNote(decision.note || '');
        if (!noteData) continue;

        if (noteData.include_probability >= threshold) {
            includeCount++;
        } else {
            excludeCount++;
        }
    }

    return { includeCount, excludeCount };
}

/**
 * LLM実行履歴を作成
 */
export function createLlmExecution(
    executionId: string,
    executionType: 'prompt_generation' | 'batch_screening',
    model: string,
    criteria: LlmCriteria | null,
    screeningPrompt: string,
    threshold: number,
    targetCount: number,
    includeCount: number,
    excludeCount: number,
    status: 'pending' | 'confirmed' = 'confirmed',
    isActive: boolean = true
): LlmExecution {
    return {
        execution_id: executionId,
        execution_type: executionType,
        timestamp: new Date().toISOString(),
        model,
        criteria_snapshot: criteria,
        screening_prompt: screeningPrompt,
        include_threshold: threshold,
        target_count: targetCount,
        include_count: includeCount,
        exclude_count: excludeCount,
        status,
        is_active: isActive,
    };
}

/**
 * スリープユーティリティ
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
