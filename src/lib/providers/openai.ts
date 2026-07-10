// providers/openai.ts - OpenAI (Responses API) プロバイダ実装
//
// gpt-5.x 系 reasoning モデル向け。Chat Completions ではなく Responses API
// (`POST /v1/responses`) を使用し、`text.format` に strict json_schema を指定して
// 出力形式を API 側で強制する（OpenRouter のようなプロンプトでの JSON 強制 +
// フォールバックパースは不要）。
//
// 設計判断:
// - **`temperature` / `top_p` は絶対に送らない**: gpt-5.x reasoning モデルは
//   これらのパラメータを HTTP 400 で拒否する。LlmScreenParams.temperature /
//   ConvertCriteriaParams.temperature は型の都合上残っているが、Gemini が
//   OpenRouter 専用の reasoningEffort を無視するのと同様にここでは無視する。
// - strict json_schema の制約（全プロパティ必須 + additionalProperties:false）を
//   満たすため、既存の Gemini 用スキーマ (SCREENING_OUTPUT_SCHEMA /
//   CRITERIA_CONVERSION_SCHEMA) を `toStrictSchema()` で変換して使う。元々 optional な
//   プロパティは type に 'null' を追加し「必須だが null 許容」に変換する。
// - 失敗時は最大2回リトライ（指数バックオフ 5s, 10s）。ただし refusal・
//   max_output_tokens による打ち切り・4xx 系の認証/形式エラーなど再試行しても
//   意味がないものは `retryable: false` を付けて即座に投げ、リトライループで
//   即rethrowする。
// - usage.input_tokens / output_tokens / output_tokens_details.reasoning_tokens を
//   Gemini/OpenRouter と同じ UsageMetadata 形式にマッピングする。

import type { LlmScreeningOutput, LlmCriteria, UsageMetadata } from '../types';
import type {
    LlmScreenParams,
    LlmScreenResult,
    ConvertCriteriaParams,
    ConvertCriteriaOptions,
    ConvertCriteriaResult,
} from '../llm-provider';
import { getEffectiveOpenAiApiKey } from '../storage';
import { normalizeCriteriaConversionResult, SCREENING_OUTPUT_SCHEMA, CRITERIA_CONVERSION_SCHEMA } from '../gemini-api';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * リトライ不要なエラーを作る（認証エラー・refusal・max_output_tokens 打ち切り等）。
 * リトライループ側で `retryable === false` を見て即座に rethrow する。
 */
function nonRetryableError(message: string): Error {
    return Object.assign(new Error(message), { retryable: false });
}

// ---------------------------------------------------------------------------
// strict json_schema 変換
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
    type?: string | string[];
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    items?: JsonSchemaNode;
    additionalProperties?: boolean;
    [key: string]: unknown;
}

/**
 * Gemini responseSchema 形式 (optional プロパティあり) を OpenAI strict json_schema
 * 形式に変換する。strict モードでは全プロパティが required かつ
 * additionalProperties:false である必要があるため、元々 optional だったプロパティは
 * type に 'null' を追加して「必須だが null 許容」に変換する。
 */
function strictifyNode(node: JsonSchemaNode): void {
    if (node.type === 'object' && node.properties) {
        const properties = node.properties;
        const originalRequired = new Set(node.required ?? []);
        const newRequired = Object.keys(properties);

        for (const key of newRequired) {
            if (!originalRequired.has(key)) {
                const prop = properties[key];
                if (Array.isArray(prop.type)) {
                    if (!prop.type.includes('null')) {
                        prop.type = [...prop.type, 'null'];
                    }
                } else if (typeof prop.type === 'string') {
                    prop.type = [prop.type, 'null'];
                }
            }
        }

        node.additionalProperties = false;
        node.required = newRequired;
    }

    if (node.properties) {
        for (const key of Object.keys(node.properties)) {
            strictifyNode(node.properties[key]);
        }
    }

    if (node.items) {
        strictifyNode(node.items);
    }
}

function toStrictSchema<T extends object>(schema: T): T {
    const clone = JSON.parse(JSON.stringify(schema)) as JsonSchemaNode;
    strictifyNode(clone);
    return clone as unknown as T;
}

// テスト用 export
export const _toStrictSchemaForTest = toStrictSchema;

const STRICT_SCREENING_SCHEMA = toStrictSchema(SCREENING_OUTPUT_SCHEMA);
// NOTE: criteria.fields はテンプレート (pico/peco/spider/custom) 共通の器で、
// 元スキーマに required が無い（P,I,E,C,O,S,PI,D,R の9個すべてが optional）。
// toStrictSchema により9個すべてが required かつ nullable になる。これは意図した
// 挙動であり、未使用フィールドは null として返ってくる想定（呼び出し側で除去する）。
const STRICT_CRITERIA_SCHEMA = toStrictSchema(CRITERIA_CONVERSION_SCHEMA);

// ---------------------------------------------------------------------------
// プロンプト構築
// ---------------------------------------------------------------------------

function buildPrompt(title: string, abstract: string, screeningPrompt: string, outputLanguage: string): string {
    // strict json_schema が出力形式を強制するため、OpenRouter 版と違い
    // "## 出力指示" の JSON フォーマット指定ブロックは不要。意味的な注意事項のみ残す。
    return `${screeningPrompt}

## 対象文献

**タイトル:**
${title}

**抄録:**
${abstract || '(抄録なし)'}

## 注意事項
- include_probability は組み入れ基準に合致する確率（0.0=完全に除外, 1.0=確実に組入）
- reasons は判断理由の短文を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で記述する
- quote は title または abstract 内の正確な部分文字列でなければならない
- evidence が無い場合でも空配列 [] を出力する（フィールド省略不可）`;
}

function buildCriteriaPrompt(protocolText: string, outputLanguage: string): string {
    const langLabel = outputLanguage === 'ja' ? '日本語' : outputLanguage;
    return `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
${protocolText}

## 注意事項
- criteria.template は "pico" | "peco" | "spider" | "custom" のいずれかを選択する
- criteria.fields は template に応じて必要なフィールドのみ埋める
  (P: 対象患者/集団, I: 介入, E: 曝露, C: 比較対照, O: アウトカム,
   S: サンプル/セッティング, PI: 関心現象, D: 研究デザイン, R: 研究タイプ)
- 各フィールドは${langLabel}で簡潔に記述する
- screening_prompt はタイトル・抄録レベルのスクリーニング用プロンプトテンプレート
  (${langLabel}) とし、各要素のチェック方法を具体的に記述する
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;
}

// ---------------------------------------------------------------------------
// API キー
// ---------------------------------------------------------------------------

/**
 * API キー文字列を HTTP ヘッダーで送れる形に正規化する（OpenRouter 版と同じロジック）。
 */
// テスト用 export（プロダクションでは getApiKey/testOpenAiApiKey 経由でのみ使用）
export function _sanitizeApiKeyForTest(rawKey: string): string {
    return sanitizeApiKey(rawKey);
}

function sanitizeApiKey(rawKey: string): string {
    let out = '';
    for (const ch of rawKey.trim()) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        // 不可視 Unicode を除去: ZWSP系/Word joiner/BOM/NBSP
        if (cp === 0x200B || cp === 0x200C || cp === 0x200D ||
            cp === 0x2060 || cp === 0xFEFF || cp === 0x00A0) continue;
        if (cp > 255) {
            throw new Error(
                'OpenAI APIキーに ISO-8859-1 範囲外の文字が含まれています。'
                + 'APIキーカードで再入力してください（コピペ時に全角文字や不可視文字が混入した可能性があります）。'
            );
        }
        out += ch;
    }
    return out;
}

async function getApiKey(): Promise<string> {
    const key = await getEffectiveOpenAiApiKey();
    if (!key) {
        throw new Error('OPENAI_API_KEY が設定されていません。サイドパネルから OpenAI APIキーを登録してください。');
    }
    return sanitizeApiKey(key);
}

// ---------------------------------------------------------------------------
// Responses API 呼び出し共通処理
// ---------------------------------------------------------------------------

interface OpenAiResponseContentPart {
    type: string;
    text?: string;
    refusal?: string;
}

interface OpenAiResponseOutputItem {
    type: string;
    content?: OpenAiResponseContentPart[];
}

interface OpenAiResponseUsage {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
}

interface OpenAiResponseBody {
    id?: string;
    model?: string;
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { message?: string; code?: string; type?: string };
    output?: OpenAiResponseOutputItem[];
    usage?: OpenAiResponseUsage;
}

async function postResponses(body: Record<string, unknown>, timeoutMs: number): Promise<OpenAiResponseBody> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const apiKey = await getApiKey();
        const response = await fetch(OPENAI_RESPONSES_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            const message = `OpenAI API error ${response.status}: ${errText.slice(0, 200)}`;
            const retryable = response.status === 429 || response.status >= 500;
            if (!retryable) {
                throw nonRetryableError(message);
            }
            throw new Error(message);
        }

        return await response.json() as OpenAiResponseBody;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * status: incomplete / failed を検査し、該当すればエラーを投げる。
 * - incomplete + max_output_tokens: reasoning トークン枯渇を明示して非リトライエラー
 * - incomplete + その他理由 (content_filter 等): 非リトライエラー
 * - failed: error.code が rate_limit/server 系ならリトライ可、それ以外は非リトライ
 */
function checkResponseStatus(data: OpenAiResponseBody): void {
    if (data.status === 'incomplete') {
        const reason = data.incomplete_details?.reason;
        if (reason === 'max_output_tokens') {
            const reasoningTokens = data.usage?.output_tokens_details?.reasoning_tokens ?? 0;
            const outputTokens = data.usage?.output_tokens ?? 0;
            throw nonRetryableError(
                `OpenAI: max_output_tokens に達したため応答が打ち切られました `
                + `(reasoning_tokens=${reasoningTokens}, output_tokens=${outputTokens})。`
                + `max_output_tokens を増やすか reasoning effort を下げてください。`
            );
        }
        throw nonRetryableError(`OpenAI: 応答が不完全です (reason=${reason ?? 'unknown'})`);
    }
    if (data.status === 'failed') {
        const code = data.error?.code ?? '';
        const message = data.error?.message ?? 'unknown error';
        const retryable = /rate_limit|server/i.test(code);
        const err = new Error(`OpenAI: リクエストが失敗しました (code=${code}): ${message}`);
        if (!retryable) {
            (err as { retryable?: boolean }).retryable = false;
        }
        throw err;
    }
}

/**
 * output 配列からテキストを抽出する。refusal パートが含まれる場合は非リトライエラー。
 */
function extractOutputText(data: OpenAiResponseBody): string {
    const outputs = data.output ?? [];
    const allParts = outputs.flatMap(item => item.content ?? []);

    const refusal = allParts.find(part => part.type === 'refusal');
    if (refusal) {
        throw nonRetryableError(`OpenAI: モデルが応答を拒否しました。refusal=${refusal.refusal ?? ''}`);
    }

    return outputs
        .filter(item => item.type === 'message')
        .flatMap(item => item.content ?? [])
        .filter(part => part.type === 'output_text')
        .map(part => part.text ?? '')
        .join('');
}

function toUsageMetadata(usage: OpenAiResponseUsage | undefined): UsageMetadata {
    const promptTokens = usage?.input_tokens ?? 0;
    const cachedInputTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;
    const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
    const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);
    return {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        thoughtsTokenCount: reasoningTokens,
        totalTokenCount: totalTokens,
        cachedInputTokens,
    };
}

// ---------------------------------------------------------------------------
// スクリーニング
// ---------------------------------------------------------------------------

async function callOnce(
    params: LlmScreenParams,
    promptText: string,
    timeoutMs: number
): Promise<LlmScreenResult> {
    // temperature / top_p は送らない（gpt-5.x reasoning モデルは HTTP 400 で拒否する）
    const body: Record<string, unknown> = {
        model: params.model,
        input: [{ role: 'user', content: promptText }],
        text: {
            format: {
                type: 'json_schema',
                name: 'screening_output',
                strict: true,
                schema: STRICT_SCREENING_SCHEMA,
            },
            verbosity: 'low',
        },
        reasoning: { effort: params.reasoningEffort ?? 'low' },
        store: false,
    };
    if (params.maxOutputTokens) {
        body.max_output_tokens = params.maxOutputTokens;
    }

    const data = await postResponses(body, timeoutMs);
    checkResponseStatus(data);

    const text = extractOutputText(data);
    if (!text) {
        throw new Error('OpenAI: 空のレスポンス');
    }

    let parsed: LlmScreeningOutput;
    try {
        parsed = JSON.parse(text) as LlmScreeningOutput;
    } catch {
        // strict json_schema なので通常発生しないはずだが、防御的にリトライ可能扱いとする
        throw new Error(`OpenAI: JSON パース失敗。先頭200文字=${text.slice(0, 200)}`);
    }

    return {
        output: parsed,
        usageMetadata: toUsageMetadata(data.usage),
        responseMetadata: {
            modelVersion: data.model || params.model,
            responseId: data.id,
        },
    };
}

/**
 * リトライ付きで OpenAI (Responses API) スクリーニングを実行
 */
export async function screenViaOpenAi(
    params: LlmScreenParams,
    maxRetries: number = 2,
    timeoutMs: number = 120000
): Promise<LlmScreenResult> {
    const promptText = buildPrompt(params.title, params.abstract, params.screeningPrompt, params.outputLanguage);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await callOnce(params, promptText, timeoutMs);
        } catch (err) {
            lastErr = err;
            if ((err as { retryable?: boolean }).retryable === false) {
                throw err;
            }
            if (attempt < maxRetries) {
                const delay = 5000 * Math.pow(2, attempt);
                console.warn(`[openai] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${(err as Error).message}`);
                await sleep(delay);
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// criteria 変換
// ---------------------------------------------------------------------------

/**
 * toStrictSchema により criteria.fields の未使用フィールドは null で返ってくる
 * (テンプレート共通の器を nullable required にしているため)。
 * normalizeCriteriaConversionResult に渡す前に null 値のキーを取り除く。
 */
function stripNullCriteriaFields(fields: Record<string, string>): Record<string, string> {
    const cleaned: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields as Record<string, string | null>)) {
        if (value !== null) {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

async function callCriteriaOnce(
    params: ConvertCriteriaParams,
    promptText: string,
    timeoutMs: number
): Promise<ConvertCriteriaResult> {
    const body: Record<string, unknown> = {
        model: params.model,
        input: [{ role: 'user', content: promptText }],
        text: {
            format: {
                type: 'json_schema',
                name: 'criteria_conversion',
                strict: true,
                schema: STRICT_CRITERIA_SCHEMA,
            },
            // verbosity は既定値のまま（screening と異なり省略する）
        },
        reasoning: { effort: params.reasoningEffort ?? 'medium' },
        store: false,
    };
    if (params.maxOutputTokens) {
        body.max_output_tokens = params.maxOutputTokens;
    }

    const data = await postResponses(body, timeoutMs);
    checkResponseStatus(data);

    const text = extractOutputText(data);
    if (!text) {
        throw new Error('OpenAI: 空のレスポンス');
    }

    let parsed: { criteria: LlmCriteria; screening_prompt: string };
    try {
        parsed = JSON.parse(text) as { criteria: LlmCriteria; screening_prompt: string };
    } catch {
        throw new Error(`OpenAI: criteria JSON パース失敗。先頭200文字=${text.slice(0, 200)}`);
    }

    const cleaned = {
        ...parsed,
        criteria: {
            ...parsed.criteria,
            fields: stripNullCriteriaFields(parsed.criteria.fields),
        },
    };

    return normalizeCriteriaConversionResult(cleaned);
}

export async function convertCriteriaViaOpenAi(
    params: ConvertCriteriaParams,
    options: ConvertCriteriaOptions = {},
    timeoutMs: number = 120000
): Promise<ConvertCriteriaResult> {
    const promptText = buildCriteriaPrompt(params.protocolText, params.outputLanguage);
    const maxRetries = options.maxRetries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await callCriteriaOnce(params, promptText, timeoutMs);
        } catch (err) {
            lastErr = err;
            if ((err as { retryable?: boolean }).retryable === false) {
                throw err;
            }
            if (attempt >= maxRetries) break;
            const delay = (options.retryDelayMs ?? 5000) * Math.pow(2, attempt);
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[openai:criteria] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${message}`);
            options.onRetry?.(attempt + 1, maxRetries, delay);
            await sleep(delay);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// テスト用ヘルパー
// ---------------------------------------------------------------------------

/**
 * カスタム OpenAI モデルの動作確認
 *
 * 極小スクリーニング用プロンプトを1回だけ投げ、strict json_schema のレスポンスが
 * 得られるかをもって「実用可能」と判定する。リトライなし・短めタイムアウト。
 * maxOutputTokens は reasoning トークンも消費するため、テスト probe でも
 * 十分な余裕 (4096) を持たせる。
 */
export async function testOpenAiModel(
    modelId: string,
    timeoutMs: number = 60000
): Promise<{ ok: boolean; error?: string }> {
    try {
        await screenViaOpenAi(
            {
                title: 'Test article on cardiovascular disease',
                abstract: 'A randomized controlled trial evaluating treatment outcomes in adults.',
                screeningPrompt:
                    'You are evaluating whether to include this study in a systematic review. Respond strictly in the requested JSON format.',
                model: modelId,
                temperature: 0,
                outputLanguage: 'en',
                maxOutputTokens: 4096,
            },
            0,
            timeoutMs
        );
        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
    }
}

/**
 * OpenAI API キーの簡易検証
 *
 * `GET /v1/models` で 200 が返るかだけ確認する（OpenRouter の `/api/v1/key` 相当）。
 */
export async function testOpenAiApiKey(apiKey: string): Promise<{ isValid: boolean; reason?: string }> {
    let cleanKey: string;
    try {
        cleanKey = sanitizeApiKey(apiKey);
    } catch (err) {
        return { isValid: false, reason: err instanceof Error ? err.message : String(err) };
    }
    try {
        const response = await fetch('https://api.openai.com/v1/models', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${cleanKey}`,
            },
        });
        if (response.ok) {
            return { isValid: true };
        }
        return { isValid: false, reason: `HTTP ${response.status}` };
    } catch (err) {
        return { isValid: false, reason: (err as Error).message };
    }
}
