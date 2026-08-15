// gemini-api.ts - Gemini API クライアント

import type { LlmScreeningOutput, LlmCriteria, ApiKeyTestResult, ApiTier, UsageMetadata, LlmModelResponseMetadata } from './types';
import { getEffectiveApiKey } from './storage';
import { t } from './i18n';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * LLM モデル設定（Gemini / OpenRouter 共通）
 *
 * 名前は歴史的経緯で `GeminiModelConfig` を維持しているが、
 * OpenRouter モデル用フィールド (`reasoningEffort`) もここに同居させ、
 * batch.ts などからは provider に関係なく同じ型で扱えるようにしている。
 * Gemini 実装は `reasoningEffort` を無視し、OpenRouter 実装は `thinkingLevel` を無視する。
 */
export interface GeminiModelConfig {
    model: string;
    temperature: number;
    maxOutputTokens?: number;
    topP?: number;
    thinkingLevel?: string;                          // Gemini 専用: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
    reasoningEffort?: 'low' | 'medium' | 'high';     // OpenRouter 専用
}

interface GeminiApiErrorOptions {
    status?: number;
    code: string;
    retryable: boolean;
    /** 429 (RESOURCE_EXHAUSTED) の RetryInfo/メッセージから抽出した待機時間 (ms)。取得できなければ undefined */
    retryAfterMs?: number;
    /** QuotaFailure.violations[].quotaId（判明した場合のみ） */
    quotaId?: string;
    /** quotaId に "FreeTier" を含むかどうか（無料枠クォータ超過の判定） */
    isFreeTierQuota?: boolean;
}

export class GeminiApiError extends Error {
    status?: number;
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    quotaId?: string;
    isFreeTierQuota: boolean;

    constructor(message: string, options: GeminiApiErrorOptions) {
        super(message);
        this.name = 'GeminiApiError';
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
        this.retryAfterMs = options.retryAfterMs;
        this.quotaId = options.quotaId;
        this.isFreeTierQuota = options.isFreeTierQuota ?? false;
    }
}

/** Gemini エラーの `details[]` に含まれる @type（RetryInfo / QuotaFailure） */
const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';
const QUOTA_FAILURE_TYPE = 'type.googleapis.com/google.rpc.QuotaFailure';

export interface ParsedGeminiError {
    /** エラーメッセージの1行目相当（ユーザー表示用。URL/キーは含まれない） */
    message?: string;
    /** 429 の再試行までの待機時間 (ms)。RetryInfo → message の順で抽出。どちらも無ければ undefined */
    retryAfterMs?: number;
    /** QuotaFailure.violations[0].quotaId */
    quotaId?: string;
    /** quotaId に "FreeTier" を含む違反が1件でもあれば true */
    isFreeTierQuota: boolean;
}

/**
 * `"8s"` / `"8.7s"` 形式の RetryInfo.retryDelay を ms に変換する。
 * 形式が想定外なら undefined を返す（例外を投げない）。
 */
function parseRetryDelaySeconds(retryDelay: unknown): number | undefined {
    if (typeof retryDelay !== 'string') return undefined;
    const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/);
    if (!match) return undefined;
    return Number(match[1]);
}

/**
 * message 中の "Please retry in 8.710506329s." のような文言から秒数を抽出する。
 * RetryInfo が details に無い場合のフォールバック。
 */
function parseRetryDelayFromMessage(message: string): number | undefined {
    const match = message.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
    if (!match) return undefined;
    return Number(match[1]);
}

function secondsToMs(seconds: number | undefined): number | undefined {
    if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
    return Math.round(seconds * 1000);
}

/**
 * Gemini API のエラーボディを解析する純関数。
 *
 * streamGenerateContent は配列形式 `[{"error":{...}}]` で、通常のエンドポイントは
 * オブジェクト形式 `{"error":{...}}` でエラーを返す。両方に対応する。
 * 壊れたボディ・空ボディが渡されても例外を投げず、抽出できないフィールドは undefined を返す
 * （message の statusText フォールバックは呼び出し側の責務）。
 *
 * message にはクォータのドキュメントURL（例: https://ai.google.dev/gemini-api/docs/rate-limits ,
 * https://ai.dev/rate-limit）が含まれることが実測で確認されている（Google 公式ドキュメントへの
 * 案内リンクであり機密情報ではない）。一方、APIキーを含む**リクエストURL**（呼び出し元の
 * fetch() に渡した URL）はこの関数の入力（エラーボディ）に含まれないため、返り値にも含まれない。
 */
export function parseGeminiErrorPayload(rawBody: unknown): ParsedGeminiError {
    const errorObj = extractErrorObject(rawBody);
    const rawMessage = typeof errorObj?.message === 'string' ? errorObj.message : undefined;
    const message = rawMessage ? rawMessage.split('\n')[0].trim() : undefined;

    const details = Array.isArray(errorObj?.details) ? errorObj!.details as unknown[] : [];

    const retryInfo = details.find(
        (d): d is { '@type': string; retryDelay?: unknown } =>
            typeof d === 'object' && d !== null && (d as { '@type'?: unknown })['@type'] === RETRY_INFO_TYPE
    );
    let retryAfterMs = retryInfo ? secondsToMs(parseRetryDelaySeconds(retryInfo.retryDelay)) : undefined;
    if (retryAfterMs === undefined && rawMessage) {
        retryAfterMs = secondsToMs(parseRetryDelayFromMessage(rawMessage));
    }

    const quotaFailure = details.find(
        (d): d is { '@type': string; violations?: unknown } =>
            typeof d === 'object' && d !== null && (d as { '@type'?: unknown })['@type'] === QUOTA_FAILURE_TYPE
    );
    const violations = Array.isArray(quotaFailure?.violations) ? quotaFailure!.violations as unknown[] : [];
    const quotaIds = violations
        .map(v => (typeof v === 'object' && v !== null ? (v as { quotaId?: unknown }).quotaId : undefined))
        .filter((id): id is string => typeof id === 'string');
    const quotaId = quotaIds[0];
    const isFreeTierQuota = quotaIds.some(id => id.includes('FreeTier'));

    return { message, retryAfterMs, quotaId, isFreeTierQuota };
}

function extractErrorObject(rawBody: unknown): { message?: unknown; details?: unknown } | undefined {
    if (Array.isArray(rawBody)) {
        const first = rawBody[0];
        if (first && typeof first === 'object' && 'error' in first) {
            return (first as { error?: unknown }).error as { message?: unknown; details?: unknown } | undefined;
        }
        return undefined;
    }
    if (rawBody && typeof rawBody === 'object' && 'error' in rawBody) {
        return (rawBody as { error?: unknown }).error as { message?: unknown; details?: unknown } | undefined;
    }
    return undefined;
}

export interface CriteriaConversionOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

/**
 * デフォルト設定
 * 速度・コスト優先で `gemini-3.1-flash-lite` (GA, Temp 0) を既定とする。
 * 精度優先で動かしたい場合は `FLASH_MODEL_CONFIG` を選択する。
 *
 * `latest` エイリアスは Google 側の実体更新で挙動 (Recall・コスト) が変わるリスクが
 * あるため、ベンチマーク済みの固定バージョン ID を採用する (2026-05 判断)。
 */
export const DEFAULT_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-3.1-flash-lite',
    temperature: 0,
};

/**
 * 安定版 Flash-Lite 設定 (DEFAULT_MODEL_CONFIG と同一、後方互換のため残置)
 */
export const LITE_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-3.1-flash-lite',
    temperature: 0,
};

/**
 * Flash (精度重視) 設定
 * gemini-3-flash-preview を固定採用 (Recall 96.1%, depression データセット)。
 * `gemini-flash-latest` エイリアスは将来 gemini-3.5-flash (Recall 93.2%) に
 * 切り替わるリスクがあるため使用しない。
 */
export const FLASH_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-3-flash-preview',
    temperature: 1.0,
    topP: 0.95,
    thinkingLevel: 'LOW',
};

/**
 * スクリーニング出力のJSONスキーマ
 */
export const SCREENING_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        include_probability: {
            type: 'number',
            description: 'タイトル・抄録レベルで最終的に組み入れになり得る確率（0-1）',
        },
        reasons: {
            type: 'array',
            items: { type: 'string' },
            description: 'この確率になった理由（短文の配列）',
        },
        evidence: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    field: {
                        type: 'string',
                        enum: ['title', 'abstract'],
                        description: '抜粋元フィールド',
                    },
                    quote: {
                        type: 'string',
                        description: '原文からの正確な抜粋',
                    },
                    start_char: {
                        type: 'integer',
                        description: 'field内テキストの0始まり開始位置',
                    },
                    end_char: {
                        type: 'integer',
                        description: 'field内テキストの終了位置（排他的）',
                    },
                },
                required: ['field', 'quote', 'start_char', 'end_char'],
            },
            description: 'ハイライト用の根拠',
        },
    },
    required: ['include_probability', 'reasons', 'evidence'],
};

/**
 * 基準変換出力のJSONスキーマ
 */
export const CRITERIA_CONVERSION_SCHEMA = {
    type: 'object',
    properties: {
        criteria: {
            type: 'object',
            properties: {
                template: {
                    type: 'string',
                    enum: ['pico', 'peco', 'spider', 'custom'],
                    description: '使用するテンプレート形式',
                },
                fields: {
                    type: 'object',
                    description: 'テンプレートに応じたフィールド（P, I, C, O など）',
                    properties: {
                        P: { type: 'string', description: '対象患者/集団' },
                        I: { type: 'string', description: '介入' },
                        E: { type: 'string', description: '曝露' },
                        C: { type: 'string', description: '比較対照' },
                        O: { type: 'string', description: 'アウトカム' },
                        S: { type: 'string', description: '研究デザイン/セッティング' },
                        PI: { type: 'string', description: '関心現象' },
                        D: { type: 'string', description: '研究デザイン' },
                        R: { type: 'string', description: '研究タイプ' },
                    },
                },
            },
            required: ['template', 'fields'],
        },
        screening_prompt: {
            type: 'string',
            description: 'スクリーニング用のプロンプトテンプレート',
        },
    },
    required: ['criteria', 'screening_prompt'],
};

/**
 * Gemini API へ渡す part。テキスト or インラインバイナリ（PDF画像等）。
 * REST(v1beta) のフィールド名に合わせて snake_case を使う。
 */
export type GeminiPart =
    | { text: string }
    | { inline_data: { mime_type: string; data: string } };

/**
 * Gemini APIを呼び出す（タイムアウト付き）— テキストプロンプト版（後方互換ラッパー）。
 */
async function callGeminiApi<T>(
    prompt: string,
    responseSchema: object,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    timeoutMs: number = 90000
): Promise<{ result: T; usageMetadata: UsageMetadata; responseMetadata: LlmModelResponseMetadata }> {
    return callGeminiApiWithParts<T>([{ text: prompt }], responseSchema, config, timeoutMs);
}

/**
 * Gemini APIを呼び出す（タイムアウト付き）— parts 版。
 * テキストに加えて inline_data（PDF等）を同梱できる。フルテキスト判定で使用する。
 *
 * timeoutMs はチャンク間の無音タイムアウト（リクエスト全体のタイムアウトではない）。
 * `includeThoughts: true` を指定しているため reasoning 中も思考チャンクが流れ続ける前提で、
 * 既定90秒無音 = 異常とみなして abort し、リトライに回す設計。
 */
export async function callGeminiApiWithParts<T>(
    parts: GeminiPart[],
    responseSchema: object,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    timeoutMs: number = 90000
): Promise<{ result: T; usageMetadata: UsageMetadata; responseMetadata: LlmModelResponseMetadata }> {
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        throw new GeminiApiError(t('error_geminiApiKeyMissing'), {
            code: 'api_key_missing',
            retryable: false,
        });
    }

    // streamGenerateContentを使用
    const url = `${GEMINI_API_BASE}/${config.model}:streamGenerateContent?key=${apiKey}`;

    const requestBody = {
        contents: [
            {
                parts,
            },
        ],
        generationConfig: {
            temperature: config.temperature,
            maxOutputTokens: config.maxOutputTokens,
            topP: config.topP,
            ...(config.thinkingLevel ? { thinkingConfig: { thinkingLevel: config.thinkingLevel.toLowerCase(), includeThoughts: true } } : {}),
            responseMimeType: 'application/json',
            responseSchema: responseSchema,
        },
    };

    // タイムアウト用のAbortController
    const controller = new AbortController();
    // タイムアウトIDを再代入可能にする
    let timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });

        // 最初のレスポンスが来た時点でクリアするが、読み込み中に再設定する
        clearTimeout(timeoutId);

        if (!response.ok) {
            // streamGenerateContent は配列 `[{"error":{...}}]`、それ以外はオブジェクト
            // `{"error":{...}}` でエラーを返す。壊れたボディでも例外を投げないよう .catch で吸収する。
            const errorData = await response.json().catch(() => undefined);
            const parsedError = parseGeminiErrorPayload(errorData);
            const errorMessage = parsedError.message || response.statusText;
            throw new GeminiApiError(t('error_geminiApi', errorMessage), {
                status: response.status,
                code: 'api_error',
                retryable: response.status === 429 || response.status >= 500,
                retryAfterMs: parsedError.retryAfterMs,
                quotaId: parsedError.quotaId,
                isFreeTierQuota: parsedError.isFreeTierQuota,
            });
        }

        // ストリーミング読み込み
        if (!response.body) {
            throw new Error(t('error_geminiEmptyResponse'));
        }

        // Web Streams API (for browser / Node 18+)
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aggregatedText = '';

        while (true) {
            // 待機中にタイムアウトを設定（チャンク間のタイムアウト）
            // 注意: read() を待っている間にタイムアウトが発生するようにする
            timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const { done, value } = await reader.read();
                clearTimeout(timeoutId); // 読めたらクリア

                if (done) break;

                // チャンクをデコードして結合
                aggregatedText += decoder.decode(value, { stream: true });
            } catch (e) {
                clearTimeout(timeoutId);
                throw e;
            }
        }

        // JSON配列としてパース
        let responses: any[];
        try {
            responses = JSON.parse(aggregatedText);
        } catch (e) {
            console.error('Failed to parse streaming response:', aggregatedText.substring(0, 200) + '...');
            throw new GeminiApiError(t('error_geminiParseFailed'), {
                code: 'stream_parse_failed',
                retryable: true,
            });
        }

        if (!Array.isArray(responses) || responses.length === 0) {
            throw new GeminiApiError(t('error_geminiInvalidFormat'), {
                code: 'invalid_stream_format',
                retryable: true,
            });
        }

        // usageMetadata を最後のチャンクから抽出
        const lastResponse = responses[responses.length - 1];
        const rawUsage = lastResponse?.usageMetadata || {};
        const usageMetadata: UsageMetadata = {
            promptTokenCount: rawUsage.promptTokenCount || 0,
            candidatesTokenCount: rawUsage.candidatesTokenCount || 0,
            thoughtsTokenCount: rawUsage.thoughtsTokenCount || 0,
            totalTokenCount: rawUsage.totalTokenCount || 0,
        };
        const metadataSource = [...responses].reverse().find(res => res?.modelVersion || res?.responseId) || {};
        const responseMetadata: LlmModelResponseMetadata = {
            modelVersion: metadataSource.modelVersion || lastResponse?.modelVersion,
            responseId: metadataSource.responseId || lastResponse?.responseId,
        };

        // 全レスポンスからテキストを結合（Thinking部分を除く）
        let fullText = '';
        for (const res of responses) {
            const parts = res.candidates?.[0]?.content?.parts;
            if (parts) {
                for (const part of parts) {
                    // thought: true は思考プロセスなのでスキップ（ログに出してもいいが）
                    // 将来的にはここで思考プロセスを保存可能
                    if (part.thought === true) continue;
                    if (part.text) {
                        fullText += part.text;
                    }
                }
            }
        }

        // finishReason を全レスポンスから抽出（最後の非空を採用）
        const finishReason = responses
            .map(res => res.candidates?.[0]?.finishReason)
            .filter((r): r is string => Boolean(r))
            .pop();

        // MAX_TOKENS で打ち切られた場合は専用エラー（同条件リトライ無意味なので retryable=false）
        if (finishReason === 'MAX_TOKENS') {
            throw new GeminiApiError(`Output truncated by MAX_TOKENS (thoughts=${usageMetadata.thoughtsTokenCount}, candidates=${usageMetadata.candidatesTokenCount})`, {
                code: 'max_tokens_truncated',
                retryable: false,
            });
        }

        if (!fullText) {
            throw new GeminiApiError(t('error_geminiNoText'), {
                code: 'no_text',
                retryable: true,
            });
        }

        // JSONパース
        try {
            return { result: JSON.parse(fullText) as T, usageMetadata, responseMetadata };
        } catch (e) {
            // Thinking modelの場合、テキストにJSON以外の内容が混ざることがある
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    return { result: JSON.parse(jsonMatch[0]) as T, usageMetadata, responseMetadata };
                } catch (e2) {
                    throw new GeminiApiError(t('error_geminiJsonParseFailed'), {
                        code: 'json_parse_failed',
                        retryable: true,
                    });
                }
            }
            throw new GeminiApiError(t('error_geminiJsonParseFailed') + ': ' + fullText.substring(0, 100), {
                code: 'json_parse_failed',
                retryable: true,
            });
        }

    } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
            throw new GeminiApiError(t('error_geminiTimeout', String(timeoutMs)), {
                code: 'timeout',
                retryable: true,
            });
        }
        throw error;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error: unknown): boolean {
    if (error instanceof GeminiApiError) {
        return error.retryable;
    }
    if (error instanceof TypeError) {
        return true;
    }
    return false;
}

const STANDARD_CRITERIA_FIELDS: Record<LlmCriteria['template'], string[]> = {
    pico: ['P', 'I', 'C', 'O'],
    peco: ['P', 'E', 'C', 'O'],
    spider: ['S', 'PI', 'D', 'E', 'R'],
    custom: [],
};

export function getStandardCriteriaFields(template: LlmCriteria['template']): string[] {
    return STANDARD_CRITERIA_FIELDS[template] || [];
}

export function normalizeCriteriaConversionResult(result: { criteria: LlmCriteria; screening_prompt: string }): { criteria: LlmCriteria; screening_prompt: string } {
    const template = result.criteria.template;
    const normalizedFields: Record<string, string> = {};

    for (const key of getStandardCriteriaFields(template)) {
        const value = result.criteria.fields?.[key];
        normalizedFields[key] = typeof value === 'string' ? value : '';
    }

    for (const [key, value] of Object.entries(result.criteria.fields || {})) {
        if (!(key in normalizedFields)) {
            normalizedFields[key] = typeof value === 'string' ? value : String(value ?? '');
        }
    }

    return {
        ...result,
        criteria: {
            ...result.criteria,
            fields: normalizedFields,
        },
    };
}

/**
 * 文献をスクリーニング
 */
export async function screenReference(
    title: string,
    abstract: string,
    screeningPrompt: string,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    outputLanguage: string = 'ja'
): Promise<{ output: LlmScreeningOutput; usageMetadata: UsageMetadata; responseMetadata: LlmModelResponseMetadata }> {
    const prompt = `${screeningPrompt}

## 対象文献

**タイトル:**
${title}

**抄録:**
${abstract || '(抄録なし)'}

## 出力指示
- include_probability: 組み入れ基準に合致する確率を0.0〜1.0で出力
- reasons: 判断理由を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で短文配列で出力
- evidence: タイトルまたは抄録から判断根拠となる部分を正確に抜粋（quote）し、その開始位置（start_char）と終了位置（end_char）を指定

注意: quoteはtitleまたはabstract内の正確な部分文字列でなければなりません。`;

    const { result, usageMetadata, responseMetadata } = await callGeminiApi<LlmScreeningOutput>(
        prompt,
        SCREENING_OUTPUT_SCHEMA,
        config
    );
    return { output: result, usageMetadata, responseMetadata };
}

/**
 * プロトコルの基準を最適化（PICO形式等に変換）
 */
export async function convertCriteria(
    protocolText: string,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    outputLanguage: string = 'ja',
    options: CriteriaConversionOptions = {}
): Promise<{ criteria: LlmCriteria; screening_prompt: string }> {
    const prompt = `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
${protocolText}

## 出力指示

1. **criteria**: PICO/PECO形式で構造化
   - template: "pico"（または適切な形式）
   - fields: 各要素を${outputLanguage === 'ja' ? '日本語' : outputLanguage}で簡潔に記述
     - P: 対象患者/集団
     - I: 介入（または E: 曝露）
     - C: 比較対照
     - O: アウトカム
     - 必要に応じて「研究デザイン」等の追加フィールド

2. **screening_prompt**: スクリーニング用のプロンプトテンプレート
   - タイトル・抄録から組み入れ/除外を判断するための詳細な指示
   - 各PICO要素をどのようにチェックするかの具体的なガイダンス
   - ${outputLanguage === 'ja' ? '日本語' : outputLanguage}で記述

注意:
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;

    const maxRetries = options.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const { result } = await callGeminiApi<{ criteria: LlmCriteria; screening_prompt: string }>(
                prompt,
                CRITERIA_CONVERSION_SCHEMA,
                config
            );
            return normalizeCriteriaConversionResult(result);
        } catch (error) {
            if (attempt >= maxRetries || !isRetryableGeminiError(error)) {
                throw error;
            }

            const delay = (options.retryDelayMs ?? 5000) * Math.pow(2, attempt);
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[convertCriteria] Retry ${attempt + 1}/${maxRetries} after ${delay}ms. Reason: ${message}`);
            options.onRetry?.(attempt + 1, maxRetries, delay);
            await sleep(delay);
        }
    }

    throw new Error(t('error_geminiJsonParseFailed'));
}

/**
 * APIキーの有効性とtierをテスト
 * models.list APIでモデル一覧を取得し、モデル数でtierを判定
 */
export async function testApiKeyWithTier(apiKey: string): Promise<ApiKeyTestResult> {
    const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    try {
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            return {
                isValid: false,
                tier: 'unknown',
                availableModels: [],
            };
        }

        const data = await response.json();
        const models = data.models || [];
        const modelNames: string[] = models.map((m: { name: string }) => m.name);

        // モデル数でtierを判定
        // 無料版: 2-3モデル程度（gemini-2.5-flash, gemini-2.5-flash-lite など）
        // 有料版: より多くのモデル（10以上）
        let tier: ApiTier = 'unknown';
        if (modelNames.length <= 5) {
            tier = 'free';
        } else if (modelNames.length > 5) {
            tier = 'paid';
        }

        console.log(`[testApiKeyWithTier] Models: ${modelNames.length}, Tier: ${tier}`);

        return {
            isValid: true,
            tier,
            availableModels: modelNames,
        };
    } catch (error) {
        console.error('[testApiKeyWithTier] Error:', error);
        return {
            isValid: false,
            tier: 'unknown',
            availableModels: [],
        };
    }
}

/**
 * APIキーの有効性をテスト（後方互換性のためのラッパー）
 */
export async function testApiKey(apiKey: string): Promise<boolean> {
    const result = await testApiKeyWithTier(apiKey);
    return result.isValid;
}

/**
 * モデルオプション（UI表示 + パラメータ）
 *
 * `config` は Gemini / OpenRouter で共通のパラメータ集合。
 * - Gemini 専用: `thinkingLevel`
 * - OpenRouter 専用: `reasoningEffort`
 * いずれもプロバイダ実装側でフィールド存在チェックして参照する。
 */
export interface ModelOption {
    id: string;
    name: string;        // フォールバック表示 (i18n 未取得時)
    nameKey?: string;    // i18n キー (UI 描画時に t() で解決)
    provider: 'gemini' | 'openrouter' | 'openai';
    config: Omit<GeminiModelConfig, 'model'>;
    /** ユーザーが手動追加した OpenRouter モデル（ベンチマーク未検証） */
    custom?: boolean;
}

/**
 * 利用可能なモデル一覧
 * latest エイリアスではなく、ベンチマーク済みの固定バージョン ID を採用する。
 * (2026-05 判断: `gemini-flash-latest` が `gemini-3.5-flash` に切り替わると
 *  Recall が 96.1% → 93.2% に低下するリスクを回避するため)
 *
 * OpenRouter モデルは [experiments/openrouter-bench/results/](../../experiments/openrouter-bench/results/) の
 * 全件ベンチ結果に基づき採用したもののみを載せる:
 *  - qwen/qwen3-235b-a22b-2507 : Recall 93.9% / Specificity 92.2% / 約 $0.135/1K件
 *  - deepseek/deepseek-v4-flash : Recall 91.1% / Specificity 90.5% / 約 $0.756/1K件
 *
 * `nameKey` は i18n キー (未定義時は `name` をフォールバック表示)。
 * 実応答の modelVersion は履歴ログへ保存。
 */
export const AVAILABLE_MODELS: ModelOption[] = [
    {
        id: 'gemini-3.1-flash-lite',
        name: 'Gemini 3.1 Flash-Lite',
        nameKey: 'llm_modelName_3_1_flash_lite',
        provider: 'gemini',
        config: { temperature: 0 }
    },
    {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        nameKey: 'llm_modelName_3_flash_preview',
        provider: 'gemini',
        config: { temperature: 1.0, topP: 0.95, thinkingLevel: 'LOW' }
    },
    {
        id: 'qwen/qwen3-235b-a22b-2507',
        name: 'Qwen3 235B Instruct (2507)',
        nameKey: 'llm_modelName_qwen3_235b_2507',
        provider: 'openrouter',
        config: { temperature: 0 }
    },
    {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        nameKey: 'llm_modelName_deepseek_v4_flash',
        provider: 'openrouter',
        config: { temperature: 0 }
    },
    {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        nameKey: 'llm_modelName_gpt_5_6_terra',
        provider: 'openai',
        // temperature は GeminiModelConfig の必須フィールドだが openai プロバイダでは無視される
        config: { temperature: 0, reasoningEffort: 'medium' }
    },
    {
        id: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        nameKey: 'llm_modelName_gpt_5_6_luna',
        provider: 'openai',
        // temperature は GeminiModelConfig の必須フィールドだが openai プロバイダでは無視される
        config: { temperature: 0, reasoningEffort: 'medium' }
    },
];

// MODEL_ID_MIGRATIONS は共有コード（sheets-api）からも参照するため
// chrome/LLM 非依存の model-migrations.ts へ分離。互換のため再エクスポートする。
export { MODEL_ID_MIGRATIONS } from './model-migrations';

/**
 * モデルIDから設定を取得
 *
 * AVAILABLE_MODELS に登録されていない場合の優先順:
 *  1. スラッシュ含む（`provider/model` 形式）→ OpenRouter カスタムモデルとみなし
 *     `{ model: modelId, temperature: 0 }` を返す。ユーザー登録カスタムモデルでも
 *     batch / criteria フローが正しく動くようにする。
 *  2. それ以外 → Gemini の DEFAULT_MODEL_CONFIG。
 */
export function getModelConfig(modelId: string): GeminiModelConfig {
    const modelOption = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (modelOption) {
        return {
            model: modelOption.id,
            ...modelOption.config,
        };
    }
    if (modelId.includes('/')) {
        return { model: modelId, temperature: 0 };
    }
    return DEFAULT_MODEL_CONFIG;
}

/**
 * ビルトイン + ユーザー登録カスタム OpenRouter モデルを合成した一覧を返す。
 *
 * カスタムモデルは `chrome.storage.local` に保存されたものを読み込み、
 * `provider: 'openrouter'`, `custom: true`, `config.temperature: 0` で展開する。
 * 既存ビルトイン ID と重複するものは無視する（ビルトイン優先）。
 *
 * 動的 import は循環依存（storage → gemini-api）を避けるため。
 */
export async function getAllAvailableModels(): Promise<ReadonlyArray<ModelOption>> {
    const { getCustomOpenRouterModels } = await import('./storage');
    let customs: { id: string; label?: string }[] = [];
    try {
        customs = await getCustomOpenRouterModels();
    } catch (err) {
        console.warn('[getAllAvailableModels] Failed to load custom models:', err);
    }
    const builtInIds = new Set(AVAILABLE_MODELS.map(m => m.id));
    const customModels: ModelOption[] = customs
        .filter(c => !builtInIds.has(c.id))
        .map(c => ({
            id: c.id,
            name: c.label && c.label.length > 0 ? `${c.label} (${c.id})` : c.id,
            provider: 'openrouter' as const,
            config: { temperature: 0 },
            custom: true,
        }));
    return [...AVAILABLE_MODELS, ...customModels];
}
