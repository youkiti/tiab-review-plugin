// gemini-api.ts - Gemini API クライアント

import type { LlmScreeningOutput, LlmCriteria, ApiKeyTestResult, ApiTier, UsageMetadata } from './types';
import { getEffectiveApiKey } from './storage';
import { t } from './i18n';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Gemini APIモデル設定
 */
export interface GeminiModelConfig {
    model: string;
    temperature: number;
    maxOutputTokens?: number;
    topP?: number;
    thinkingLevel?: string; // 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' - for Model B
}

interface GeminiApiErrorOptions {
    status?: number;
    code: string;
    retryable: boolean;
}

class GeminiApiError extends Error {
    status?: number;
    code: string;
    retryable: boolean;

    constructor(message: string, options: GeminiApiErrorOptions) {
        super(message);
        this.name = 'GeminiApiError';
        this.status = options.status;
        this.code = options.code;
        this.retryable = options.retryable;
    }
}

export interface CriteriaConversionOptions {
    maxRetries?: number;
    retryDelayMs?: number;
    onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

/**
 * デフォルト設定
 */
export const DEFAULT_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-3-flash-preview',
    temperature: 1.0,
    topP: 0.95,
    thinkingLevel: 'LOW',
};

/**
 * コスト重視設定 (Flash Lite)
 */
export const LITE_MODEL_CONFIG: GeminiModelConfig = {
    model: 'gemini-2.5-flash-lite',
    temperature: 0,
};

/**
 * スクリーニング出力のJSONスキーマ
 */
const SCREENING_OUTPUT_SCHEMA = {
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
const CRITERIA_CONVERSION_SCHEMA = {
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
 * Gemini APIを呼び出す（タイムアウト付き）
 * thinkingモデル対応のため、デフォルト60秒
 */
async function callGeminiApi<T>(
    prompt: string,
    responseSchema: object,
    config: GeminiModelConfig = DEFAULT_MODEL_CONFIG,
    timeoutMs: number = 300000
): Promise<{ result: T; usageMetadata: UsageMetadata }> {
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
                parts: [{ text: prompt }],
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
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error?.message || response.statusText;
            throw new GeminiApiError(t('error_geminiApi', errorMessage), {
                status: response.status,
                code: 'api_error',
                retryable: response.status === 429 || response.status >= 500,
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

        if (!fullText) {
            throw new GeminiApiError(t('error_geminiNoText'), {
                code: 'no_text',
                retryable: true,
            });
        }

        // JSONパース
        try {
            return { result: JSON.parse(fullText) as T, usageMetadata };
        } catch (e) {
            // Thinking modelの場合、テキストにJSON以外の内容が混ざることがある
            const jsonMatch = fullText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    return { result: JSON.parse(jsonMatch[0]) as T, usageMetadata };
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

function normalizeCriteriaConversionResult(result: { criteria: LlmCriteria; screening_prompt: string }): { criteria: LlmCriteria; screening_prompt: string } {
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
): Promise<{ output: LlmScreeningOutput; usageMetadata: UsageMetadata }> {
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

    const { result, usageMetadata } = await callGeminiApi<LlmScreeningOutput>(
        prompt,
        SCREENING_OUTPUT_SCHEMA,
        config
    );
    return { output: result, usageMetadata };
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
 */
export interface ModelOption {
    id: string;
    name: string;
    config: Omit<GeminiModelConfig, 'model'>;
}

/**
 * 利用可能なモデル一覧
 * 実験結果に基づき、Flash 3.0 (Thinking LOW) を推奨
 * 各モデルに固有のパラメータを含む
 */
export const AVAILABLE_MODELS: ModelOption[] = [
    {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        config: { temperature: 1.0, topP: 0.95, thinkingLevel: 'LOW' }
    },
    {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        config: { temperature: 0 }
    },
];

/**
 * モデルIDから設定を取得
 */
export function getModelConfig(modelId: string): GeminiModelConfig {
    const modelOption = AVAILABLE_MODELS.find(m => m.id === modelId);
    if (modelOption) {
        return {
            model: modelOption.id,
            ...modelOption.config,
        };
    }
    // フォールバック: デフォルト設定
    return DEFAULT_MODEL_CONFIG;
}
