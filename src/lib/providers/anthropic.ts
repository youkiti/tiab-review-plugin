// Anthropic Messages API でスクリーニングと基準の最適化を行う。
// スクリーニングの再試行は llm-processor.ts の processWithRetry に任せる。
// 内部で待つとガバナーから待ち時間が見えなくなるため、1回だけ通信する。

import type { LlmScreeningOutput, LlmCriteria, UsageMetadata, LlmModelResponseMetadata } from '../types';
import { getEffectiveAnthropicApiKey } from '../storage';
import { SCREENING_OUTPUT_SCHEMA, CRITERIA_CONVERSION_SCHEMA, normalizeCriteriaConversionResult } from '../gemini-api';
import { buildScreeningPrompt, buildCriteriaPrompt } from './structured-prompts';

// ディスパッチ層への型 import も循環になるため、使用する入力だけを構造型で受け取る。
interface AnthropicParams {
    model: string;
    reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
    outputLanguage: string;
}

interface AnthropicScreenParams extends AnthropicParams {
    title: string;
    abstract: string;
    screeningPrompt: string;
}

interface AnthropicCriteriaParams extends AnthropicParams {
    protocolText: string;
}

interface AnthropicCriteriaOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

interface AnthropicScreenResult {
    output: LlmScreeningOutput;
    usageMetadata: UsageMetadata;
    responseMetadata: LlmModelResponseMetadata;
}

interface AnthropicCriteriaResult {
    criteria: LlmCriteria;
    screening_prompt: string;
}

interface AnthropicUsage {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
}

interface AnthropicResponse {
    id?: string;
    model?: string;
    stop_reason?: string;
    content?: { type: string; text?: string }[];
    usage?: AnthropicUsage;
}

const MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_OUTPUT_TOKENS = 16000;
// max_tokens は本文と思考の合計なので、本文の希望量に思考の取り分を加え、対応上限で頭打ちにする。
const THINKING_TOKEN_ALLOWANCE = 4000;
const MAX_TOTAL_TOKENS = 64000;

/** 任意プロパティを維持しつつ、すべての object ノードで追加プロパティを禁止する。 */
export function toAnthropicSchema<T extends object>(schema: T): T {
    function cloneNode(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map(cloneNode);
        }
        if (value !== null && typeof value === 'object') {
            const node = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneNode(child)]));
            if (node.type === 'object') {
                node.additionalProperties = false;
            }
            return node;
        }
        return value;
    }
    return cloneNode(schema) as T;
}

const SCREENING_SCHEMA = toAnthropicSchema(SCREENING_OUTPUT_SCHEMA);
const CRITERIA_SCHEMA = toAnthropicSchema(CRITERIA_CONVERSION_SCHEMA);

type AnthropicEffort = 'low' | 'medium' | 'high';

// 基準の最適化は1回きりの処理で、判定より深く考えさせる。呼び出し側（features/llm/criteria.ts）は
// モデル設定の reasoningEffort（一括判定向けの値）をそのまま渡してくるため、ここでは受け取った値を使わず固定する。
const CRITERIA_EFFORT: AnthropicEffort = 'medium';

/** effort は low / medium / high だけを送る。none は実 API で確認していないため low に寄せる。 */
function resolveScreeningEffort(requested: AnthropicParams['reasoningEffort']): AnthropicEffort {
    if (requested === undefined || requested === 'none') {
        return 'low';
    }
    return requested;
}

function buildRequest(params: AnthropicParams, prompt: string, schema: object, effort: AnthropicEffort) {
    // temperature は両モデルが HTTP 400 で拒否する。top_p・top_k・thinking も送らず effort のみ指定する。
    return {
        model: params.model,
        max_tokens: Math.min((params.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS) + THINKING_TOKEN_ALLOWANCE, MAX_TOTAL_TOKENS),
        messages: [{ role: 'user', content: prompt }],
        output_config: {
            effort,
            format: { type: 'json_schema', schema },
        },
    };
}

function sanitizeApiKey(rawKey: string): string {
    let out = '';
    for (const ch of rawKey.trim()) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) {
            continue;
        }
        // 不可視 Unicode を除去: ZWSP系/Word joiner/BOM/NBSP
        if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060 || cp === 0xFEFF || cp === 0x00A0) {
            continue;
        }
        if (cp > 255) {
            throw new Error(
                'Anthropic APIキーに ISO-8859-1 範囲外の文字が含まれています。'
                + 'APIキーカードで再入力してください（コピペ時に全角文字や不可視文字が混入した可能性があります）。'
            );
        }
        out += ch;
    }
    return out;
}

/**
 * 認証ヘッダー。`anthropic-dangerous-direct-browser-access` は省略できない。
 * 拡張ページからの fetch には Origin ヘッダーが付き、このヘッダーが無いと Anthropic は本文を見る前に
 * HTTP 401（CORS requests must set 'anthropic-dangerous-direct-browser-access' header）で拒否する。
 * /v1/messages と /v1/models の両方で実 API により確認した（2026-10-10）。
 * 名前の "dangerous" はブラウザにキーを置くことへの警告で、利用者自身のキーを利用者の端末だけに保存する設計のため受け入れる。
 */
function authHeaders(apiKey: string): Record<string, string> {
    return {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
    };
}

function nonRetryableError(message: string): Error {
    return Object.assign(new Error(message), { retryable: false });
}

async function postMessages(body: ReturnType<typeof buildRequest>, timeoutMs: number): Promise<AnthropicResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const rawKey = await getEffectiveAnthropicApiKey();
        if (!rawKey) {
            throw new Error('ANTHROPIC_API_KEY が設定されていません。サイドパネルから Anthropic APIキーを登録してください。');
        }
        const apiKey = sanitizeApiKey(rawKey);
        const response = await fetch(MESSAGES_ENDPOINT, {
            method: 'POST',
            headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const errText = (await response.text().catch(() => '')).split(apiKey).join('[REDACTED]');
            const message = response.status === 404
                ? `モデル ${body.model} が見つかりません（提供終了の可能性があります。拡張機能の更新が必要です）。応答=${errText.slice(0, 200)}`
                : `Anthropic API error ${response.status}: ${errText.slice(0, 200)}`;
            const error = Object.assign(new Error(message), { status: response.status });
            const retryAfter = Number(response.headers.get('retry-after'));
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
                Object.assign(error, { retryAfterMs: retryAfter * 1000 });
            }
            if (response.status === 401 || response.status === 403 || response.status === 404) {
                Object.assign(error, { retryable: false });
            }
            throw error;
        }
        return await response.json() as AnthropicResponse;
    } finally {
        clearTimeout(timer);
    }
}

function parseOutput<T>(data: AnthropicResponse): T {
    if (data.stop_reason === 'refusal') {
        throw nonRetryableError('Anthropic: モデルが応答を拒否しました (stop_reason=refusal)');
    }
    if (data.stop_reason === 'max_tokens') {
        const thinkingTokens = data.usage?.output_tokens_details?.thinking_tokens ?? 0;
        const outputTokens = data.usage?.output_tokens ?? 0;
        throw nonRetryableError(
            'Anthropic: max_tokens に達したため応答が打ち切られました '
            + `(thinking_tokens=${thinkingTokens}, output_tokens=${outputTokens})。`
            + 'max_tokens を増やすか effort を下げてください。'
        );
    }
    const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('');
    if (!text) {
        throw new Error('Anthropic: 空のレスポンス');
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`Anthropic: JSON パース失敗。先頭200文字=${text.slice(0, 200)}`);
    }
}

export async function screenViaAnthropic(params: AnthropicScreenParams, timeoutMs = 120000): Promise<AnthropicScreenResult> {
    const prompt = buildScreeningPrompt(params.title, params.abstract, params.screeningPrompt, params.outputLanguage);
    const data = await postMessages(buildRequest(params, prompt, SCREENING_SCHEMA, resolveScreeningEffort(params.reasoningEffort)), timeoutMs);
    const output = parseOutput<LlmScreeningOutput>(data);
    const cachedInputTokens = data.usage?.cache_read_input_tokens ?? 0;
    const promptTokenCount = (data.usage?.input_tokens ?? 0) + cachedInputTokens + (data.usage?.cache_creation_input_tokens ?? 0);
    const candidatesTokenCount = data.usage?.output_tokens ?? 0;
    return {
        output,
        usageMetadata: {
            promptTokenCount,
            candidatesTokenCount,
            thoughtsTokenCount: data.usage?.output_tokens_details?.thinking_tokens ?? 0,
            totalTokenCount: promptTokenCount + candidatesTokenCount,
            cachedInputTokens,
        },
        responseMetadata: { modelVersion: data.model || params.model, responseId: data.id },
    };
}

export async function convertCriteriaViaAnthropic(
    params: AnthropicCriteriaParams,
    options: AnthropicCriteriaOptions = {},
    timeoutMs = 120000
): Promise<AnthropicCriteriaResult> {
    const prompt = buildCriteriaPrompt(params.protocolText, params.outputLanguage);
    const maxRetries = options.maxRetries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const data = await postMessages(buildRequest(params, prompt, CRITERIA_SCHEMA, CRITERIA_EFFORT), timeoutMs);
            const parsed = parseOutput<AnthropicCriteriaResult>(data);
            const fields: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed.criteria.fields)) {
                if (typeof value === 'string') {
                    fields[key] = value;
                }
            }
            return normalizeCriteriaConversionResult({ ...parsed, criteria: { ...parsed.criteria, fields } });
        } catch (err) {
            lastErr = err;
            if ((err as { retryable?: boolean }).retryable === false) {
                throw err;
            }
            if (attempt >= maxRetries) {
                break;
            }
            const delay = (options.retryDelayMs ?? 5000) * Math.pow(2, attempt);
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[anthropic:criteria] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${message}`);
            options.onRetry?.(attempt + 1, maxRetries, delay);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function testAnthropicApiKey(apiKey: string): Promise<{ isValid: boolean; reason?: string }> {
    let cleanKey: string;
    try {
        cleanKey = sanitizeApiKey(apiKey);
    } catch (err) {
        return { isValid: false, reason: err instanceof Error ? err.message : String(err) };
    }
    try {
        const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
            method: 'GET',
            headers: authHeaders(cleanKey),
        });
        return response.ok ? { isValid: true } : { isValid: false, reason: `HTTP ${response.status}` };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isValid: false, reason: apiKey ? message.split(apiKey).join('[REDACTED]') : message };
    }
}
