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
    UsageMetadata,
    LlmModelResponseMetadata,
} from './types';
import { RATE_LIMIT_PAID } from './types';
import { screenReference, GeminiModelConfig } from './gemini-api';
import { PROMPT_VERSION } from './prompt-templates';
import { getClientVersion } from './client-version';

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
    output: LlmScreeningOutput,
    usageMetadata?: UsageMetadata,
    responseMetadata?: LlmModelResponseMetadata
): LlmDecisionNote {
    return {
        type: 'llm',
        execution_id: executionId,
        model,
        requested_model: model,
        model_version: responseMetadata?.modelVersion,
        response_id: responseMetadata?.responseId,
        include_probability: output.include_probability,
        reasons: output.reasons,
        evidence: output.evidence,
        prompt_version: PROMPT_VERSION,
        usageMetadata,
    };
}

/**
 * LLM 出力解析失敗時のフォールバック note を生成
 * - SR で組入候補の見逃しを防ぐため include_probability=1.0 で記録
 * - parse_error フラグで通常の判定と区別
 */
export function createLlmFallbackDecisionNote(
    executionId: string,
    model: string,
    errorMessage: string
): LlmDecisionNote {
    return {
        type: 'llm',
        execution_id: executionId,
        model,
        requested_model: model,
        include_probability: 1.0,
        reasons: [`LLM 出力が解析できませんでした (${errorMessage})`],
        evidence: [],
        prompt_version: PROMPT_VERSION,
        parse_error: true,
        error_message: errorMessage,
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
    /**
     * 既に閾値が確定している Run に追加するバッチで指定する。
     * 設定すると pending ではなく include/exclude として保存され、
     * 閾値確認 UI を出さずに即時確定される。
     */
    applyThreshold?: number;
    // 呼び出し側で事前に execution_id を生成して LLM_Executions 行を先書きする運用のため、
    // 同じ id/timestamp をバッチ内でも使えるように受け取れるようにする
    executionId?: string;
    timestamp?: Date;
}

/**
 * バッチ処理の結果
 */
export interface BatchProcessResult {
    executionId: string;
    processedCount: number;
    successCount: number;       // 通常の成功件数（フォールバックは含まない）
    failCount: number;          // decision を作れなかった件数（abort 等）
    fallbackCount: number;      // LLM 出力解析失敗で確率 1.0 として保存した件数
    modelVersions: string[];
    responseIds: string[];
    resolvedModelVersion?: string;
    latestResponseId?: string;
    decisions: Decision[];
    failedRefIds: string[];     // リトライ対象（完全失敗 + フォールバック保存）
    fallbackRefIds: string[];   // フォールバック保存された ref_id（再判定したい場合の参照用）
}

type ProcessOutcome =
    | { success: true; decision: Decision; refId: string; isFallback: boolean; responseMetadata?: LlmModelResponseMetadata }
    | { success: false; decision: null; refId: string };

/**
 * 1件の文献を処理（リトライ付き）
 * 失敗時は指数バックオフで最大2回リトライ
 * 全リトライ失敗時は include_probability=1.0 のフォールバック判定を返す
 *  （SR で組入候補の見逃しを防ぐ安全側設計）
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
): Promise<ProcessOutcome> {
    let lastErrorMessage = 'Unknown error';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const { output, usageMetadata, responseMetadata } = await screenReference(
                ref.title,
                ref.abstract || '',
                screeningPrompt,
                modelConfig,
                outputLanguage
            );

            const noteData = createLlmDecisionNote(executionId, model, output, usageMetadata, responseMetadata);
            const decision: Decision = {
                decision_id: crypto.randomUUID(),
                ref_id: ref.ref_id,
                reviewer_id: executionId,
                decision: 'pending',
                reason: '',
                note: JSON.stringify(noteData),
                decided_at: timestamp.toISOString(),
                client_version: getClientVersion('-llm'),
            };

            return { success: true, decision, refId: ref.ref_id, isFallback: false, responseMetadata };
        } catch (error) {
            lastErrorMessage = error instanceof Error ? error.message : 'Unknown error';
            // 同条件リトライが無意味なエラー（MAX_TOKENS 切り詰め等）は即座にフォールバックへ
            const errorCode = (error as { code?: string } | null)?.code;
            const nonRetryable = errorCode === 'max_tokens_truncated';
            if (nonRetryable) {
                console.warn(`[processWithRetry] Non-retryable error for ${ref.ref_id}: ${lastErrorMessage}`);
                break;
            }
            if (attempt < maxRetries) {
                // 指数バックオフ: 5秒, 10秒
                const delay = 5000 * Math.pow(2, attempt);
                console.log(`[processWithRetry] Retry ${attempt + 1}/${maxRetries} for ${ref.ref_id} after ${delay}ms. Reason: ${lastErrorMessage}`);
                await sleep(delay);
            } else {
                console.error(`[processWithRetry] Failed after ${maxRetries} retries for ${ref.ref_id}:`, error);
            }
        }
    }

    // フォールバック: include_probability=1.0 で記録（人間レビューに必ず残す）
    const fallbackNote = createLlmFallbackDecisionNote(executionId, model, lastErrorMessage);
    const fallbackDecision: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: executionId,
        decision: 'pending',
        reason: '',
        note: JSON.stringify(fallbackNote),
        decided_at: timestamp.toISOString(),
        client_version: getClientVersion('-llm'),
    };
    return { success: true, decision: fallbackDecision, refId: ref.ref_id, isFallback: true };
}

/**
 * 並列度を制限する軽量セマフォ
 * - 外部依存を増やさず、tier毎の concurrency を実際に強制するために導入
 * - acquire/release 方式。release 漏れを防ぐため、呼び出し側は try/finally で使う
 */
class Semaphore {
    private active = 0;
    private readonly waiters: (() => void)[] = [];

    constructor(private readonly limit: number) {}

    async acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return;
        }
        return new Promise<void>(resolve => {
            this.waiters.push(() => {
                this.active++;
                resolve();
            });
        });
    }

    release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

/**
 * 複数の文献をバッチ処理
 * - `concurrency`: 同時並列数（tier毎の上限を尊重）
 * - `batchSize`: スプレッドシートへの保存単位（並列数とは独立）
 * - `delayBetweenRequests`: 各スロットの最低滞在時間として作用させ、簡易的なRPM制御に使う
 */
export async function processBatch(
    references: Reference[],
    options: BatchProcessOptions
): Promise<BatchProcessResult> {
    const timestamp = options.timestamp ?? new Date();
    const executionId = options.executionId ?? generateLlmReviewerId(options.model, timestamp);

    const progress: LlmBatchProgress = {
        total: references.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        parseErrorFallback: 0,
        isRunning: true,
    };

    const allDecisions: Decision[] = [];
    const fallbackRefIds: string[] = [];
    const pendingForSave: Decision[] = [];
    const modelVersions = new Set<string>();
    const responseIds = new Set<string>();
    let latestResponseId: string | undefined;

    const modelConfig: GeminiModelConfig = {
        model: options.model,
        temperature: options.temperature,
        topP: options.topP,
        thinkingLevel: options.thinkingLevel,
        maxOutputTokens: options.maxOutputTokens,
    };

    const rateLimit = options.rateLimitConfig || RATE_LIMIT_PAID;
    const concurrency = Math.max(rateLimit.concurrency, 1);
    const slotDwellMs = Math.max(rateLimit.delayBetweenRequests, 0);
    const saveBatchSize = Math.max(options.batchSize, 1);

    console.log(`[processBatch] concurrency=${concurrency}, slotDwell=${slotDwellMs}ms, saveBatchSize=${saveBatchSize}`);

    const sem = new Semaphore(concurrency);

    // 保存処理は直列化（同時に複数の append が走らないようにする）
    let saveChain: Promise<void> = Promise.resolve();
    let firstSaveError: Error | null = null;

    function scheduleFlush(): void {
        if (!options.onSaveBatch || pendingForSave.length === 0) return;
        const toSave = pendingForSave.splice(0, pendingForSave.length);
        // applyThreshold が指定されていれば、保存直前に判定を確定させる
        // （Run 単位で閾値が決まっているため、バッチ追加時の即時確定に使う）
        const finalized = options.applyThreshold !== undefined
            ? applyThresholdToDecisions(toSave, options.applyThreshold)
            : toSave;
        saveChain = saveChain.then(() => options.onSaveBatch!(finalized)).catch(err => {
            console.error('[processBatch] onSaveBatch error:', err);
            if (!firstSaveError) {
                firstSaveError = err instanceof Error ? err : new Error(String(err));
            }
        });
    }

    const tasks = references.map(async (ref) => {
        if (options.abortSignal?.aborted) return;
        await sem.acquire();
        try {
            if (options.abortSignal?.aborted) return;

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
                if (result.isFallback) {
                    progress.parseErrorFallback++;
                    fallbackRefIds.push(result.refId);
                } else {
                    progress.succeeded++;
                }
                allDecisions.push(result.decision);
                pendingForSave.push(result.decision);
                if (result.responseMetadata?.modelVersion) {
                    modelVersions.add(result.responseMetadata.modelVersion);
                }
                if (result.responseMetadata?.responseId) {
                    responseIds.add(result.responseMetadata.responseId);
                    latestResponseId = result.responseMetadata.responseId;
                }
            } else {
                progress.failed++;
            }

            options.onProgress?.(progress);

            if (pendingForSave.length >= saveBatchSize) {
                scheduleFlush();
            }

            // スロットを最低 slotDwellMs 確保することで、簡易的に RPM をクランプ
            if (slotDwellMs > 0) {
                await sleep(slotDwellMs);
            }
        } finally {
            sem.release();
        }
    });

    await Promise.all(tasks);

    // 残件をフラッシュして直列保存チェーンの完了を待つ
    scheduleFlush();
    await saveChain;

    progress.isRunning = false;
    progress.currentRefId = undefined;
    options.onProgress?.(progress);

    if (firstSaveError) {
        throw firstSaveError;
    }

    const decisionRefIds = new Set(allDecisions.map(d => d.ref_id));
    const noDecisionRefIds = references
        .filter(r => !decisionRefIds.has(r.ref_id))
        .map(r => r.ref_id);

    // リトライ対象: 完全失敗 + フォールバック保存（parse_error: true で保存されたもの）
    const failedRefIds = [...noDecisionRefIds, ...fallbackRefIds];

    return {
        executionId,
        processedCount: progress.processed,
        successCount: progress.succeeded,
        failCount: progress.failed,
        fallbackCount: progress.parseErrorFallback,
        modelVersions: Array.from(modelVersions),
        responseIds: Array.from(responseIds),
        resolvedModelVersion: Array.from(modelVersions).join(', '),
        latestResponseId,
        decisions: allDecisions,
        failedRefIds,
        fallbackRefIds,
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
    isActive: boolean = true,
    // Model parameters
    temperature?: number,
    topP?: number,
    thinkingLevel?: string
): LlmExecution {
    return {
        execution_id: executionId,
        execution_type: executionType,
        timestamp: new Date().toISOString(),
        model,
        requested_model: model,
        temperature,
        topP,
        thinkingLevel,
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
