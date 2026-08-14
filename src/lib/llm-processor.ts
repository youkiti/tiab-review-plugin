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
import { GeminiModelConfig, AVAILABLE_MODELS } from './gemini-api';
import { resolveProviderId, screenWithProvider } from './llm-provider';
import type { LlmProviderId, LlmScreenParams, LlmScreenResult } from './llm-provider';
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
    // --- テスト用の依存注入（本番コードでは既定値をそのまま使う） ---
    /** 実際の screenWithProvider の代わりに使う（完全オフラインテスト用） */
    screenFn?: (providerId: LlmProviderId, params: LlmScreenParams) => Promise<LlmScreenResult>;
    /** 時刻取得の注入（既定 Date.now） */
    now?: () => number;
    /** sleep 実装の注入（既定は setTimeout ベース） */
    sleepFn?: (ms: number) => Promise<void>;
    /** クールダウンのジッタに使う乱数生成の注入（既定 Math.random） */
    random?: () => number;
    /**
     * 429 適応スロットリングの詳細設定（省略時は RateLimitGovernor の既定値を使う）。
     * minConcurrency: 並列度の下限 / maxSlotDwellMs: スロット滞在時間の上限 /
     * recoverAfterSuccesses: この件数だけ連続成功したら1段回復 /
     * fallbackCooldownMs: retryAfterMs が取れない429のクールダウン既定値 / jitterMs: クールダウンの乱数幅
     */
    governorOptions?: Pick<RateLimitGovernorOptions, 'minConcurrency' | 'maxSlotDwellMs' | 'recoverAfterSuccesses' | 'fallbackCooldownMs' | 'jitterMs'>;
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
 * メッセージ内レート制限シグナルの検出パターン。
 * OpenRouter/OpenAI の実装は現状 `` `OpenRouter API error 429: ...` `` /
 * `` `OpenAI API error 429: ...` `` (providers/openrouter.ts, providers/openai.ts) の形で
 * 429 を投げる。裸の `\b429\b` は使わない — この検出経路には JSON パース失敗時に
 * モデルの生成テキスト・抄録の抜粋がそのまま連結されて流れてくる
 * （例: `error_geminiJsonParseFailed: ...n = 429 patients...` や
 * `` `OpenRouter: JSON パース失敗。先頭200文字=...429...` ``）ため、本文中に偶然
 * "429" という数字が含まれるだけで誤ってレート制限と判定してしまう（並列度が不要に
 * 半減し、クールダウンが立ってしまう）。明示的なレート制限シグナルの語だけに絞る。
 */
const RATE_LIMIT_MESSAGE_PATTERN = /API error 429|Too Many Requests|RESOURCE_EXHAUSTED|rate limit/i;

/**
 * エラーが 429 (レート制限) かどうかを判定し、可能なら retryAfterMs を取り出す。
 *
 * GeminiApiError（gemini-api.ts）は status / retryAfterMs をフィールドとして直接持つので
 * そのまま拾える。OpenRouter/OpenAI 実装は status を持たない Error しか投げないため、
 * メッセージ中の明示的なレート制限シグナル（RATE_LIMIT_MESSAGE_PATTERN）を最後の手段として
 * 拾う（この場合 retryAfterMs は取れない）。
 * 循環依存を避けるため `instanceof GeminiApiError` ではなくダックタイピングで判定する。
 */
function detectRateLimit(error: unknown): { isRateLimit: boolean; retryAfterMs?: number } {
    if (error && typeof error === 'object') {
        const err = error as { status?: number; retryAfterMs?: number; message?: string };
        if (err.status === 429) {
            return { isRateLimit: true, retryAfterMs: err.retryAfterMs };
        }
        if (typeof err.message === 'string' && RATE_LIMIT_MESSAGE_PATTERN.test(err.message)) {
            return { isRateLimit: true, retryAfterMs: err.retryAfterMs };
        }
    }
    return { isRateLimit: false };
}

/**
 * processWithRetry が使う外部依存（テストでは全てオフラインの注入値に差し替える）
 */
interface ProcessWithRetryDeps {
    governor: RateLimitGovernor;
    screenFn: (providerId: LlmProviderId, params: LlmScreenParams) => Promise<LlmScreenResult>;
    sleepFn: (ms: number) => Promise<void>;
    maxRetries?: number;             // 429 以外の既定リトライ上限（既定2）
    maxRetriesOnRateLimit?: number;  // 429 のリトライ上限（既定5、429以外より緩める）
    maxCumulativeWaitMs?: number;    // 1件あたりの累積待ち時間の上限（既定3分）
}

/**
 * 1件の文献を処理（リトライ付き）
 * - 429 (レート制限) 以外は指数バックオフで最大2回（既定）リトライ
 * - 429 は共有ガバナー (deps.governor) のクールダウンに従って待ち、最大5回（既定）まで
 *   リトライする。ただし1件あたりの累積待ち時間が上限（既定3分）を超えたら諦める
 * 全リトライ失敗時は include_probability=1.0 のフォールバック判定を返す
 *  （SR で組入候補の見逃しを防ぐ安全側設計。この挙動は変更しない）
 */
async function processWithRetry(
    ref: Reference,
    screeningPrompt: string,
    modelConfig: GeminiModelConfig,
    outputLanguage: string,
    executionId: string,
    model: string,
    timestamp: Date,
    deps: ProcessWithRetryDeps
): Promise<ProcessOutcome> {
    const maxRetries = deps.maxRetries ?? 2;
    const maxRetriesOnRateLimit = deps.maxRetriesOnRateLimit ?? 5;
    const maxCumulativeWaitMs = deps.maxCumulativeWaitMs ?? 3 * 60 * 1000;

    let lastErrorMessage = 'Unknown error';
    let cumulativeWaitMs = 0;
    const providerId = resolveProviderId(modelConfig.model, AVAILABLE_MODELS);

    for (let attempt = 0; ; attempt++) {
        // 送信前に共有クールダウンを尊重する（他ワーカーが 429 を受けていても足並みを揃える）
        await deps.governor.waitForSlot();

        try {
            const { output, usageMetadata, responseMetadata } = await deps.screenFn(providerId, {
                title: ref.title,
                abstract: ref.abstract || '',
                screeningPrompt,
                model: modelConfig.model,
                temperature: modelConfig.temperature,
                topP: modelConfig.topP,
                thinkingLevel: modelConfig.thinkingLevel,
                reasoningEffort: modelConfig.reasoningEffort,
                maxOutputTokens: modelConfig.maxOutputTokens,
                outputLanguage,
            });
            deps.governor.recordSuccess();

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

            const rateLimit = detectRateLimit(error);
            if (rateLimit.isRateLimit) {
                // 429: 並列度・スロット滞在時間を絞り、共有クールダウンを立てる（他ワーカーにも効く）
                const waitMs = deps.governor.recordRateLimit(rateLimit.retryAfterMs);
                if (attempt >= maxRetriesOnRateLimit || cumulativeWaitMs + waitMs > maxCumulativeWaitMs) {
                    console.warn(`[processWithRetry] Rate limit retry budget exhausted for ${ref.ref_id} (attempt=${attempt + 1}, cumulativeWaitMs=${cumulativeWaitMs + waitMs}ms). Falling back.`);
                    break;
                }
                cumulativeWaitMs += waitMs;
                console.log(`[processWithRetry] 429 for ${ref.ref_id}. Shared cooldown ~${waitMs}ms (attempt ${attempt + 1}/${maxRetriesOnRateLimit}).`);
                continue; // 実際の待機は次ループ冒頭の governor.waitForSlot() に任せる
            }

            if (attempt >= maxRetries) {
                console.error(`[processWithRetry] Failed after ${maxRetries} retries for ${ref.ref_id}:`, error);
                break;
            }
            // 指数バックオフ: 5秒, 10秒（429 以外のフォールバック）
            const delay = 5000 * Math.pow(2, attempt);
            if (cumulativeWaitMs + delay > maxCumulativeWaitMs) {
                console.warn(`[processWithRetry] Cumulative wait budget exhausted for ${ref.ref_id}. Falling back.`);
                break;
            }
            cumulativeWaitMs += delay;
            console.log(`[processWithRetry] Retry ${attempt + 1}/${maxRetries} for ${ref.ref_id} after ${delay}ms. Reason: ${lastErrorMessage}`);
            await deps.sleepFn(delay);
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
 * - setLimit() で実行中に上限を動的変更できる（429 適応スロットリングで使用）
 */
class Semaphore {
    private active = 0;
    private limit: number;
    private readonly waiters: (() => void)[] = [];

    constructor(limit: number) {
        this.limit = Math.max(1, limit);
    }

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
        this.wakeWaiters();
    }

    /**
     * 並列度の上限を動的に変更する。429 適応スロットリングで実行中に concurrency を
     * 半減・回復させるために使う。上限を上げた場合は待機中のタスクをその場で起こす。
     * 上限を下げた場合、既に走っている分を強制終了はしない（release されるたびに自然に絞られる）。
     */
    setLimit(newLimit: number): void {
        this.limit = Math.max(1, newLimit);
        this.wakeWaiters();
    }

    private wakeWaiters(): void {
        while (this.active < this.limit && this.waiters.length > 0) {
            const next = this.waiters.shift();
            if (next) next();
        }
    }
}

/**
 * 429 適応スロットリングの状態を processBatch の全ワーカーで共有するガバナー。
 *
 * Gemini のレート制限は API キー単位（プロジェクト単位）にかかるため、1ワーカーだけ待っても
 * 他のワーカーが送信を続けると意味がない。あるワーカーが recordRateLimit() を呼ぶと、
 * 以後 waitForSlot() を呼ぶ全ワーカーが同じクールダウンで足止めされる。
 */
export interface RateLimitGovernorOptions {
    initialConcurrency: number;
    initialSlotDwellMs: number;
    minConcurrency?: number;          // 並列度の下限（既定1）
    maxSlotDwellMs?: number;          // スロット滞在時間の上限（既定13000ms = 無料プロファイル相当）
    recoverAfterSuccesses?: number;   // この件数だけ連続成功したら1段だけ回復（既定20）
    fallbackCooldownMs?: number;      // retryAfterMs が取れない429のクールダウン既定値（既定5000ms）
    jitterMs?: number;                // クールダウンに乗せる乱数の幅（サンダリングハード回避、既定500ms）
    now?: () => number;               // テスト用: 時刻取得の注入（既定 Date.now）
    sleepFn?: (ms: number) => Promise<void>; // テスト用: sleep実装の注入（既定 setTimeout ベース）
    random?: () => number;            // テスト用: 乱数生成の注入（既定 Math.random）
}

export class RateLimitGovernor {
    private concurrencyValue: number;
    private slotDwellMsValue: number;
    private cooldownUntilValue = 0;
    private consecutiveSuccesses = 0;
    private rateLimitHitsValue = 0;

    private readonly initialConcurrency: number;
    private readonly initialSlotDwellMs: number;
    private readonly minConcurrency: number;
    private readonly maxSlotDwellMs: number;
    private readonly recoverAfterSuccesses: number;
    private readonly fallbackCooldownMs: number;
    private readonly jitterMs: number;
    private readonly now: () => number;
    private readonly sleepFn: (ms: number) => Promise<void>;
    private readonly random: () => number;

    constructor(options: RateLimitGovernorOptions) {
        this.initialConcurrency = Math.max(1, options.initialConcurrency);
        this.initialSlotDwellMs = Math.max(0, options.initialSlotDwellMs);
        this.concurrencyValue = this.initialConcurrency;
        this.slotDwellMsValue = this.initialSlotDwellMs;
        this.minConcurrency = options.minConcurrency ?? 1;
        this.maxSlotDwellMs = options.maxSlotDwellMs ?? 13000;
        this.recoverAfterSuccesses = options.recoverAfterSuccesses ?? 20;
        this.fallbackCooldownMs = options.fallbackCooldownMs ?? 5000;
        this.jitterMs = options.jitterMs ?? 500;
        this.now = options.now ?? Date.now;
        this.sleepFn = options.sleepFn ?? sleep;
        this.random = options.random ?? Math.random;
    }

    get concurrency(): number { return this.concurrencyValue; }
    get slotDwellMs(): number { return this.slotDwellMsValue; }
    get rateLimitHits(): number { return this.rateLimitHitsValue; }
    get cooldownUntil(): number { return this.cooldownUntilValue; }
    /**
     * 既定の並列度・スロット滞在時間より絞られている、またはクールダウン中か
     * （UIの「減速中」表示に使う）。
     * 無料プロファイル（concurrency=1, slotDwell=13000=上限）のように既に下限/上限に
     * 達している設定では、429 を受けても concurrency/slotDwellMs 自体は変化しないため、
     * それだけで判定すると「一番レート制限を踏みやすいユーザーで減速中と表示されない」
     * 事故になる。クールダウンが有効な間は無条件で throttled とみなす。
     */
    get isThrottled(): boolean {
        return this.concurrencyValue < this.initialConcurrency
            || this.slotDwellMsValue > this.initialSlotDwellMs
            || this.cooldownUntilValue > this.now();
    }

    /**
     * 429 受信時に呼ぶ。並列度を半減（下限 minConcurrency）・スロット滞在時間を倍
     * （上限 maxSlotDwellMs）にし、共有クールダウンを延長する。
     * 戻り値は「このワーカーが次に waitForSlot() したときに実際に待つおおよその ms」
     * （他ワーカーが既により長いクールダウンを設定していれば、そちらが優先される）。
     */
    recordRateLimit(retryAfterMs?: number): number {
        this.rateLimitHitsValue++;
        this.consecutiveSuccesses = 0;
        this.concurrencyValue = Math.max(this.minConcurrency, Math.floor(this.concurrencyValue / 2));
        const doubled = this.slotDwellMsValue > 0 ? this.slotDwellMsValue * 2 : 1000;
        this.slotDwellMsValue = Math.min(this.maxSlotDwellMs, doubled);

        const waitMs = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.fallbackCooldownMs;
        const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
        const candidate = this.now() + waitMs + jitter;
        // 複数ワーカーがほぼ同時に 429 を受けても、より遠い（安全側の）クールダウンだけを延長する
        this.cooldownUntilValue = Math.max(this.cooldownUntilValue, candidate);
        return Math.max(0, this.cooldownUntilValue - this.now());
    }

    /**
     * 成功時に呼ぶ。並列度・スロット滞在時間のどちらかが既定値より絞られている間だけ
     * 連続成功を数え、閾値（recoverAfterSuccesses）に達したら1段だけ回復させる（急に戻さない）。
     */
    recordSuccess(): void {
        if (!this.isThrottled) {
            this.consecutiveSuccesses = 0;
            return;
        }
        this.consecutiveSuccesses++;
        if (this.consecutiveSuccesses < this.recoverAfterSuccesses) return;
        this.consecutiveSuccesses = 0;
        this.concurrencyValue = Math.min(this.initialConcurrency, this.concurrencyValue + 1);
        const halved = Math.floor(this.slotDwellMsValue / 2);
        this.slotDwellMsValue = Math.max(this.initialSlotDwellMs, halved);
    }

    /** クールダウン中なら残り時間だけ待つ。送信直前に全ワーカーが呼ぶ */
    async waitForSlot(): Promise<void> {
        const remaining = this.cooldownUntilValue - this.now();
        if (remaining > 0) {
            await this.sleepFn(remaining);
        }
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

    // 429 適応スロットリング: 全ワーカーが共有する状態（クールダウン・並列度・スロット滞在時間）
    const governor = new RateLimitGovernor({
        initialConcurrency: concurrency,
        initialSlotDwellMs: slotDwellMs,
        now: options.now,
        sleepFn: options.sleepFn,
        random: options.random,
        ...options.governorOptions,
    });
    const sleepFn = options.sleepFn ?? sleep;
    const screenFn = options.screenFn ?? screenWithProvider;

    const progress: LlmBatchProgress = {
        total: references.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        parseErrorFallback: 0,
        isRunning: true,
        rateLimitHits: governor.rateLimitHits,
        currentConcurrency: governor.concurrency,
        throttled: governor.isThrottled,
    };

    console.log(`[processBatch] concurrency=${concurrency}, slotDwell=${slotDwellMs}ms, saveBatchSize=${saveBatchSize}`);

    const sem = new Semaphore(governor.concurrency);

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
                timestamp,
                { governor, screenFn, sleepFn }
            );

            // 429 適応スロットリングで並列度が変わっていたら Semaphore にも反映する
            sem.setLimit(governor.concurrency);

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

            progress.rateLimitHits = governor.rateLimitHits;
            progress.currentConcurrency = governor.concurrency;
            progress.throttled = governor.isThrottled;
            options.onProgress?.(progress);

            if (pendingForSave.length >= saveBatchSize) {
                scheduleFlush();
            }

            // スロットを最低 slotDwellMs 確保することで、簡易的に RPM をクランプ
            // （429 を受けると governor.slotDwellMs が動的に伸びる）
            const dwellMs = governor.slotDwellMs;
            if (dwellMs > 0) {
                await sleepFn(dwellMs);
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
    progress.rateLimitHits = governor.rateLimitHits;
    progress.currentConcurrency = governor.concurrency;
    progress.throttled = governor.isThrottled;
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
