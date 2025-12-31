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
    RateLimitConfig,
} from './types';
import { RATE_LIMIT_PAID } from './types';
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
    topP?: number;
    thinkingLevel?: string;
    maxOutputTokens?: number;
    outputLanguage: string;
    rateLimitConfig?: RateLimitConfig; // レート制限設定（無料版/有料版）
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
    failedRefIds: string[];  // リトライ後も失敗したref_id一覧
}

/**
 * 1件の文献を処理（リトライ付き）
 * 失敗時は指数バックオフで最大2回リトライ
 */
async function processWithRetry(
    ref: Reference,
    screeningPrompt: string,
    modelConfig: GeminiModelConfig,
    outputLanguage: string,
    executionId: string,
    model: string,
    timestamp: Date,
    maxRetries: number = 2
): Promise<{ success: boolean; decision: Decision | null; refId: string }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const output = await screenReference(
                ref.title,
                ref.abstract || '',
                screeningPrompt,
                modelConfig,
                outputLanguage
            );

            const noteData = createLlmDecisionNote(executionId, model, output);
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

            return { success: true, decision, refId: ref.ref_id };
        } catch (error) {
            if (attempt < maxRetries) {
                // 指数バックオフ: 5秒, 10秒
                const delay = 5000 * Math.pow(2, attempt);
                console.log(`[processWithRetry] Retry ${attempt + 1}/${maxRetries} for ${ref.ref_id} after ${delay}ms`);
                await sleep(delay);
            } else {
                console.error(`[processWithRetry] Failed after ${maxRetries} retries for ${ref.ref_id}:`, error);
            }
        }
    }
    return { success: false, decision: null, refId: ref.ref_id };
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
        topP: options.topP,
        thinkingLevel: options.thinkingLevel,
        maxOutputTokens: options.maxOutputTokens,
    };

    // レート制限設定（デフォルトは有料版設定）
    const rateLimit = options.rateLimitConfig || RATE_LIMIT_PAID;
    const isSequential = rateLimit.concurrency === 1;

    console.log(`[processBatch] Rate limit: concurrency=${rateLimit.concurrency}, delay=${rateLimit.delayBetweenRequests}ms`);

    // バッチサイズごとに処理
    for (let batchStart = 0; batchStart < references.length; batchStart += options.batchSize) {
        // アボートチェック
        if (options.abortSignal?.aborted) {
            progress.isRunning = false;
            options.onProgress?.(progress);
            break;
        }

        const batchEnd = Math.min(batchStart + options.batchSize, references.length);
        const batchRefs = references.slice(batchStart, batchEnd);
        const batchDecisions: Decision[] = [];

        if (isSequential) {
            // 無料版: 順次実行（1件ずつ処理し、間にwait）+ 自動リトライ
            for (const ref of batchRefs) {
                // アボートチェック
                if (options.abortSignal?.aborted) {
                    break;
                }

                const result = await processWithRetry(
                    ref,
                    options.screeningPrompt,
                    modelConfig,
                    options.outputLanguage,
                    executionId,
                    options.model,
                    timestamp
                );

                progress.processed++;
                if (result.success && result.decision) {
                    progress.succeeded++;
                    batchDecisions.push(result.decision);
                    allDecisions.push(result.decision);
                } else {
                    progress.failed++;
                }

                options.onProgress?.(progress);

                // レート制限: リクエスト間でwait
                if (rateLimit.delayBetweenRequests > 0) {
                    await sleep(rateLimit.delayBetweenRequests);
                }
            }
        } else {
            // 有料版: 並列処理 + 自動リトライ
            const batchPromises = batchRefs.map(ref =>
                processWithRetry(
                    ref,
                    options.screeningPrompt,
                    modelConfig,
                    options.outputLanguage,
                    executionId,
                    options.model,
                    timestamp
                )
            );

            const results = await Promise.all(batchPromises);

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

            // レート制限: バッチ間でwait
            if (batchEnd < references.length && rateLimit.delayBetweenRequests > 0) {
                await sleep(rateLimit.delayBetweenRequests);
            }
        }

        // バッチを保存
        if (batchDecisions.length > 0 && options.onSaveBatch) {
            await options.onSaveBatch(batchDecisions);
        }
    }

    progress.isRunning = false;
    progress.currentRefId = undefined;
    options.onProgress?.(progress);

    // 失敗したref_idを特定（成功したref_id以外）
    const successRefIds = new Set(allDecisions.map(d => d.ref_id));
    const failedRefIds = references
        .filter(r => !successRefIds.has(r.ref_id))
        .map(r => r.ref_id);

    return {
        executionId,
        processedCount: progress.processed,
        successCount: progress.succeeded,
        failCount: progress.failed,
        decisions: allDecisions,
        failedRefIds,
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
