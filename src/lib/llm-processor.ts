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
import type { LlmTargetMode } from './llm-target-selection';
import { RATE_LIMIT_PAID } from './types';
import { GeminiModelConfig, AVAILABLE_MODELS } from './gemini-api';
import { resolveProviderId, screenWithProvider } from './llm-provider';
import type { LlmProviderId, LlmScreenParams, LlmScreenResult } from './llm-provider';
import { PROMPT_VERSION } from './prompt-templates';
import { getClientVersion } from './client-version';
import { generateLlmReviewerId } from './llm-reviewer-id';

/**
 * 進捗コールバック型
 */
export type ProgressCallback = (progress: LlmBatchProgress) => void;

export { generateLlmReviewerId } from './llm-reviewer-id';

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
    // Gemini 3.8 以降は公式移行ガイドで temperature / topP が非推奨のため、
    // 未指定なら送らない運用を許容する optional にしている。
    temperature?: number;
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
     * fallbackCooldownMs: retryAfterMs が取れない429のクールダウン既定値 /
     * maxCooldownMs: クールダウン待ちの上限（1(a)） / jitterMs: waitForSlot の乱数幅
     */
    governorOptions?: Pick<RateLimitGovernorOptions, 'minConcurrency' | 'maxSlotDwellMs' | 'recoverAfterSuccesses' | 'fallbackCooldownMs' | 'maxCooldownMs' | 'jitterMs'>;
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
    | { success: true; decision: Decision; refId: string; isFallback: boolean; responseMetadata?: LlmModelResponseMetadata; aborted?: false }
    | { success: false; decision: null; refId: string; aborted?: false }
    // 中断（Stop）で待機中に打ち切られた場合。フォールバック判定（pending / include_probability=1.0）を
    // 書いてはいけないので、成功/フォールバックとは別の形にする（1(c)）
    | { success: false; decision: null; refId: string; aborted: true };

/**
 * メッセージ内レート制限シグナルの検出パターン。
 *
 * 自然言語表現（`rate limit` のような空白区切りの語）は使わない — この検出経路には
 * JSON パース失敗時にモデルの生成テキスト・抄録の抜粋がそのまま連結されて流れてくる
 * （例: gemini-api.ts の `error_geminiJsonParseFailed: ...` + `fullText.substring(0,100)`、
 * providers/openrouter.ts の `` `OpenRouter: JSON パース失敗。先頭200文字=...` ``）。
 * 薬理・生理の抄録には `rate limiting step` / `flow rate limitation` のような語が頻出し、
 * 空白区切りの `rate limit` はこれらに誤ってマッチしてしまう（ハイフン付きの
 * `rate-limiting` はマッチしないので実際に踏んだ実例あり）。そのため、抄録には出てこない
 * アンダースコア付きのコード名・明示的な HTTP シグナルだけに絞る:
 * - `API error 429` / `Too Many Requests`: OpenRouter/OpenAI 実装
 *   (providers/openrouter.ts, providers/openai.ts) が投げる形
 * - `RESOURCE_EXHAUSTED`: Gemini のステータス文字列
 * - `rate_limit_exceeded`: providers/openai.ts が投げる
 *   `OpenAI: リクエストが失敗しました (code=rate_limit_exceeded): ...` の形
 */
const RATE_LIMIT_MESSAGE_PATTERN = /API error 429|Too Many Requests|RESOURCE_EXHAUSTED|rate_limit_exceeded/i;

/**
 * クールダウン待ちの既定上限 (ms)。RateLimitGovernor のクールダウン（1(a)）にも、
 * processWithRetry の 5xx バックオフ（11番: retryAfterMs をヒントに使うが無検証では
 * 信頼しない）にも共通で使う。サーバの retryAfterMs（RPD枯渇時など）をそのまま使うと
 * 全ワーカーが長時間固まってしまうため。
 */
const DEFAULT_MAX_COOLDOWN_MS = 60000;

/**
 * sleep と abort を競争させる。abort が先に来たら sleep の残りを待たずに即座に解決する。
 * - `signal` が undefined の場合は普通に `sleepFn(ms)` を待つだけ
 * - 呼び出し時点で既に aborted の場合は `sleepFn` を呼ばずに即座に解決する
 * - abort リスナは必ず外す（1件の文献処理につき何度も呼ばれるため、外し忘れるとリスナが
 *   際限なく積み上がる）
 */
async function sleepOrAbort(
    ms: number,
    sleepFn: (ms: number) => Promise<void>,
    signal?: AbortSignal
): Promise<void> {
    if (!signal) {
        await sleepFn(ms);
        return;
    }
    if (signal.aborted) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        sleepFn(ms).then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }).catch((err) => {
            signal.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}

/**
 * エラーが 429 (レート制限) かどうかを判定する。retryAfterMs は 429 か否かに関わらず、
 * エラーオブジェクトに載っていればそのまま返す（11番: gemini-api.ts は 5xx にも
 * RetryInfo 由来の retryAfterMs を詰めることがあるため、429 以外のバックオフにも使う）。
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
        const isRateLimit = err.status === 429
            || (typeof err.message === 'string' && RATE_LIMIT_MESSAGE_PATTERN.test(err.message));
        return { isRateLimit, retryAfterMs: err.retryAfterMs };
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
    // 1件あたりの累積待ち時間の上限（既定3分）。プロバイダ内部のリトライ待ちは見えない
    // （例: providers/openrouter.ts:213-230 は内部で 5s+10s の2回リトライを持つため、
    // 外側からは1試行あたり15秒が不可視）ので、実際の待ちはこの上限より長くなりうる
    maxCumulativeWaitMs?: number;
    maxCooldownMs?: number;          // 429以外(5xx等)のバックオフ上限（既定 DEFAULT_MAX_COOLDOWN_MS）
    abortSignal?: AbortSignal;       // Stop による中断（1(b)）
}

/**
 * 1件の文献を処理（リトライ付き）
 * - 429 (レート制限) 以外は指数バックオフで最大2回（既定）リトライ。サーバの retryAfterMs
 *   （5xx にも詰まることがある。11番）があればそちらを優先し、無ければ 5秒, 10秒…
 *   いずれも maxCooldownMs でクランプする（サーバ値を無検証で信頼しない）
 * - 429 は共有ガバナー (deps.governor) のクールダウンに従って待ち、最大5回（既定）まで
 *   リトライする。ただし1件あたりの累積待ち時間が上限（既定3分）を超えたら諦める
 * - deps.abortSignal が中断されたら、待機中であっても即座に打ち切る。この場合は
 *   フォールバック判定を書かず aborted:true を返す（1(c): Stop した文献に AI 判定を残さない）
 * 全リトライ失敗時（中断以外）は include_probability=1.0 のフォールバック判定を返す
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
    const maxCooldownMs = deps.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    const abortSignal = deps.abortSignal;

    let lastErrorMessage = 'Unknown error';
    let cumulativeWaitMs = 0;
    const providerId = resolveProviderId(modelConfig.model, AVAILABLE_MODELS);
    const aborted = (): ProcessOutcome => ({ success: false, decision: null, refId: ref.ref_id, aborted: true });

    for (let attempt = 0; ; attempt++) {
        if (abortSignal?.aborted) return aborted();

        // 送信前に共有クールダウンを尊重する（他ワーカーが 429 を受けていても足並みを揃える）。
        // waitForSlot は実際に待った ms を返すので、他ワーカーが立てたクールダウンで寝た分も
        // 含めて累積待ち時間へ積む（6番: 429分岐側では予測値を積まないことで二重計上を避ける）
        const waited = await deps.governor.waitForSlot(abortSignal);
        cumulativeWaitMs += waited;
        if (abortSignal?.aborted) return aborted();

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
                // 429: 並列度・スロット滞在時間を絞り、共有クールダウンを立てる（他ワーカーにも効く）。
                // 実際の待機・累積計上は次ループ冒頭の governor.waitForSlot() に任せる（6番）
                const waitMs = deps.governor.recordRateLimit(rateLimit.retryAfterMs);
                if (attempt >= maxRetriesOnRateLimit || cumulativeWaitMs + waitMs > maxCumulativeWaitMs) {
                    console.warn(`[processWithRetry] Rate limit retry budget exhausted for ${ref.ref_id} (attempt=${attempt + 1}, cumulativeWaitMs=${cumulativeWaitMs + waitMs}ms). Falling back.`);
                    break;
                }
                console.log(`[processWithRetry] 429 for ${ref.ref_id}. Shared cooldown ~${waitMs}ms (attempt ${attempt + 1}/${maxRetriesOnRateLimit}).`);
                continue;
            }

            if (attempt >= maxRetries) {
                console.error(`[processWithRetry] Failed after ${maxRetries} retries for ${ref.ref_id}:`, error);
                break;
            }
            // 指数バックオフ: サーバの retryAfterMs があれば優先（11番: 5xx にも詰まることがある）、
            // 無ければ 5秒, 10秒…。いずれも maxCooldownMs でクランプする
            const backoff = rateLimit.retryAfterMs !== undefined && rateLimit.retryAfterMs > 0
                ? rateLimit.retryAfterMs
                : 5000 * Math.pow(2, attempt);
            const delay = Math.min(backoff, maxCooldownMs);
            if (cumulativeWaitMs + delay > maxCumulativeWaitMs) {
                console.warn(`[processWithRetry] Cumulative wait budget exhausted for ${ref.ref_id}. Falling back.`);
                break;
            }
            console.log(`[processWithRetry] Retry ${attempt + 1}/${maxRetries} for ${ref.ref_id} after ${delay}ms. Reason: ${lastErrorMessage}`);
            await sleepOrAbort(delay, deps.sleepFn, abortSignal);
            if (abortSignal?.aborted) return aborted();
            cumulativeWaitMs += delay;
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
    // スロット滞在時間の上限（既定13000ms = 無料プロファイル相当）。
    // initialSlotDwellMs より小さい値を渡しても、コンストラクタで initialSlotDwellMs まで
    // 引き上げる（10番: そうしないと 429 で dwell が initialSlotDwellMs → maxSlotDwellMs と
    // 逆に「速くなる」「isThrottled が false を返す」という潜在バグになる）
    maxSlotDwellMs?: number;
    recoverAfterSuccesses?: number;   // この件数だけ連続成功したら1段だけ回復（既定20）
    fallbackCooldownMs?: number;      // retryAfterMs が取れない429のクールダウン既定値（既定5000ms）
    // クールダウン待ちの上限（既定 DEFAULT_MAX_COOLDOWN_MS=60000ms）。RPD枯渇等でサーバの
    // retryAfterMs が巨大な値を返しても、ここでクランプして全ワーカーが長時間固まるのを防ぐ（1(a)）
    maxCooldownMs?: number;
    // waitForSlot() が実際に待つ長さに乗せる乱数の幅（既定500ms）。
    // 9番: recordRateLimit ではなく waitForSlot 側で乗せることで、共有の絶対時刻
    // cooldownUntilValue は1つでも各ワーカーの起床タイミングをばらけさせ、サンダリングハードを避ける
    jitterMs?: number;
    // 429/5xx でクールダウンを立てた・延長した時点で呼ばれる（5番）。processBatch はこれで
    // progress を最新化して onProgress を叩き、クールダウン中の無言停止を防ぐ
    onThrottleChange?: () => void;
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
    private readonly maxCooldownMs: number;
    private readonly jitterMs: number;
    private readonly onThrottleChange?: () => void;
    private readonly now: () => number;
    private readonly sleepFn: (ms: number) => Promise<void>;
    private readonly random: () => number;

    constructor(options: RateLimitGovernorOptions) {
        this.initialConcurrency = Math.max(1, options.initialConcurrency);
        this.initialSlotDwellMs = Math.max(0, options.initialSlotDwellMs);
        this.concurrencyValue = this.initialConcurrency;
        this.slotDwellMsValue = this.initialSlotDwellMs;
        this.minConcurrency = options.minConcurrency ?? 1;
        // 10番: maxSlotDwellMs が initialSlotDwellMs を下回るプロファイルが来ても引き上げる
        this.maxSlotDwellMs = Math.max(options.maxSlotDwellMs ?? 13000, this.initialSlotDwellMs);
        this.recoverAfterSuccesses = options.recoverAfterSuccesses ?? 20;
        this.fallbackCooldownMs = options.fallbackCooldownMs ?? 5000;
        this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
        this.jitterMs = options.jitterMs ?? 500;
        this.onThrottleChange = options.onThrottleChange;
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
     * 429 受信時に呼ぶ。共有クールダウンを延長し、まだクールダウン中でなければ
     * （＝新しいレート制限エピソードの最初の1回だけ）並列度を半減（下限 minConcurrency）・
     * スロット滞在時間を倍（上限 maxSlotDwellMs）にする（3番: 「1エピソード1減少」）。
     * 既にクールダウン中に他ワーカーが立て続けに 429 を報告しても、rateLimitHits の計上と
     * クールダウンの延長（より遠い方を採用）は毎回行うが、並列度・滞在時間の減少はスキップする。
     * これをしないと、Tier誤判定などで並列ワーカーが同時に同じ 429 を踏んだとき
     * 並列度・滞在時間が一気に下限/上限まで落ち、実効レートが空きクォータより
     * 大幅に遅くなってしまう。
     *
     * 戻り値は「このワーカーが次に waitForSlot() したときに実際に待つおおよその ms」
     * （他ワーカーが既により長いクールダウンを設定していれば、そちらが優先される。
     * jitter は含まない。jitter は waitForSlot() 側で乗せる。9番）。
     */
    recordRateLimit(retryAfterMs?: number): number {
        const now = this.now();
        const alreadyCoolingDown = now < this.cooldownUntilValue;

        this.rateLimitHitsValue++;
        this.consecutiveSuccesses = 0;
        if (!alreadyCoolingDown) {
            this.concurrencyValue = Math.max(this.minConcurrency, Math.floor(this.concurrencyValue / 2));
            const doubled = this.slotDwellMsValue > 0 ? this.slotDwellMsValue * 2 : 1000;
            this.slotDwellMsValue = Math.min(this.maxSlotDwellMs, doubled);
        }

        // retryAfterMs はサーバ値を無検証で信頼せず、上限でクランプする（1(a)）
        const waitMsRaw = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : this.fallbackCooldownMs;
        const waitMs = Math.min(waitMsRaw, this.maxCooldownMs);
        const candidate = now + waitMs;
        // 複数ワーカーがほぼ同時に 429 を受けても、より遠い（安全側の）クールダウンだけを延長する
        this.cooldownUntilValue = Math.max(this.cooldownUntilValue, candidate);
        this.onThrottleChange?.();
        return Math.max(0, this.cooldownUntilValue - now);
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

    /**
     * クールダウン中なら残り時間だけ待つ。送信直前に全ワーカーが呼ぶ。
     * jitter はここで乗せる（9番: recordRateLimit ではなくここで乗せることで、共有の絶対時刻
     * cooldownUntilValue は1つでも各ワーカーの起床タイミングをばらけさせる）。
     * abortSignal を渡すと待機中の中断にも即座に反応する（1(b)）。
     * 戻り値は実際に待った ms（6番: processWithRetry の cumulativeWaitMs 会計に使う）。
     */
    async waitForSlot(abortSignal?: AbortSignal): Promise<number> {
        const remaining = this.cooldownUntilValue - this.now();
        if (remaining <= 0) return 0;
        const jitter = this.jitterMs > 0 ? Math.floor(this.random() * this.jitterMs) : 0;
        const waitMs = remaining + jitter;
        const before = this.now();
        await sleepOrAbort(waitMs, this.sleepFn, abortSignal);
        return Math.max(0, this.now() - before);
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
    const maxCooldownMs = options.governorOptions?.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;

    const sleepFn = options.sleepFn ?? sleep;
    const screenFn = options.screenFn ?? screenWithProvider;

    // governor 構築前に計算できる初期値で progress を作る（この時点では governor.rateLimitHits 等と
    // 同じ値になる: rateLimitHits=0, currentConcurrency=initialConcurrency, throttled=false）
    const progress: LlmBatchProgress = {
        total: references.length,
        processed: 0,
        succeeded: 0,
        failed: 0,
        parseErrorFallback: 0,
        isRunning: true,
        rateLimitHits: 0,
        currentConcurrency: concurrency,
        throttled: false,
    };

    // 429/5xx でクールダウンが立った・延長された時点で progress を最新化して onProgress を叩く。
    // クールダウン中はワーカーが寝ているだけで他に onProgress を呼ぶ箇所が無いため、
    // これが無いとクールダウン開始と同時に UI が無言停止する（5番）
    const syncProgressFromGovernor = (): void => {
        progress.rateLimitHits = governor.rateLimitHits;
        progress.currentConcurrency = governor.concurrency;
        progress.throttled = governor.isThrottled;
        options.onProgress?.(progress);
    };

    // 429 適応スロットリング: 全ワーカーが共有する状態（クールダウン・並列度・スロット滞在時間）
    const governor = new RateLimitGovernor({
        initialConcurrency: concurrency,
        initialSlotDwellMs: slotDwellMs,
        now: options.now,
        sleepFn: options.sleepFn,
        random: options.random,
        onThrottleChange: syncProgressFromGovernor,
        ...options.governorOptions,
    });

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
                { governor, screenFn, sleepFn, abortSignal: options.abortSignal, maxCooldownMs }
            );

            // 429 適応スロットリングで並列度が変わっていたら Semaphore にも反映する
            sem.setLimit(governor.concurrency);

            if (result.aborted) {
                // 1(c): 中断（Stop）された文献にはフォールバック判定を書かない。
                // decision が無いので、既存の noDecisionRefIds 経由でそのまま failedRefIds に入る
                // （進捗も加算しない: processed++ / failed++ どちらもしない）
                return;
            }

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

            syncProgressFromGovernor();

            if (pendingForSave.length >= saveBatchSize) {
                scheduleFlush();
            }

            // スロットを最低 slotDwellMs 確保することで、簡易的に RPM をクランプ
            // （429 を受けると governor.slotDwellMs が動的に伸びる）。dwell 中の中断にも対応する（2番）
            const dwellMs = governor.slotDwellMs;
            if (dwellMs > 0) {
                await sleepOrAbort(dwellMs, sleepFn, options.abortSignal);
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
    syncProgressFromGovernor();

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
    thinkingLevel?: string,
    targetMeta?: { mode: LlmTargetMode; sets?: string; selectedCount?: number }
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
        ...(targetMeta ? {
            target_mode: targetMeta.mode,
            target_sets: targetMeta.sets,
            target_selected_count: targetMeta.selectedCount,
        } : {}),
    };
}

/**
 * スリープユーティリティ
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
