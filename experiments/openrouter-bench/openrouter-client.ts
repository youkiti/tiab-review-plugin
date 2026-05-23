/**
 * OpenRouter 用の薄い API クライアント（ベンチマーク専用）
 *
 * 本体実装（src/lib/gemini-api.ts）には触らず、experiments 配下に閉じる。
 * OpenAI 互換 chat/completions エンドポイントに対し response_format: json_schema で
 * Gemini 側と同等のスキーマを強制する。
 *
 * 対象モデル:
 *  - qwen/qwen3-235b-a22b-instruct-2507
 *  - qwen/qwen3-235b-a22b-thinking-2507
 *  - moonshotai/kimi-k2-thinking
 *
 * 設計判断:
 *  - 失敗時は最大 2 回リトライ（指数バックオフ 5s, 10s）
 *  - JSON パース失敗時はテキスト中の {...} を最大抽出してフォールバック
 *  - usage（prompt_tokens / completion_tokens / reasoning_tokens）を返してコスト計算へ
 */

import type { LlmScreeningOutput } from '../../src/lib/types';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

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
                    field: { type: 'string', enum: ['title', 'abstract'] },
                    quote: { type: 'string' },
                    start_char: { type: 'integer' },
                    end_char: { type: 'integer' },
                },
                required: ['field', 'quote', 'start_char', 'end_char'],
                additionalProperties: false,
            },
        },
    },
    required: ['include_probability', 'reasons', 'evidence'],
    additionalProperties: false,
};

export interface OpenRouterUsage {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    totalTokens: number;
}

export interface OpenRouterResponseMetadata {
    model?: string;
    provider?: string;
    responseId?: string;
}

export interface OpenRouterModelConfig {
    model: string;
    temperature: number;
    topP?: number;
    /** OpenRouter の reasoning モードを使う場合に指定。Qwen Thinking / Kimi K2 Thinking 等 */
    reasoningEffort?: 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
}

export interface OpenRouterScreenResult {
    output: LlmScreeningOutput;
    usage: OpenRouterUsage;
    metadata: OpenRouterResponseMetadata;
}

function getApiKey(): string {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
        throw new Error('OPENROUTER_API_KEY が設定されていません。.env に追加してください。');
    }
    return key;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt(title: string, abstract: string, screeningPrompt: string, outputLanguage: string): string {
    // OpenRouter は json_object モードで返すため、JSON 形式を明示的に指示する。
    // Gemini 側は strict schema で同等の出力を強制している。
    return `${screeningPrompt}

## 対象文献

**タイトル:**
${title}

**抄録:**
${abstract || '(抄録なし)'}

## 出力指示
以下の JSON スキーマに厳密に従って出力すること。余計なテキスト・コードフェンス・コメントは一切出力しないこと。

\`\`\`json
{
  "include_probability": <0.0-1.0 の数値>,
  "reasons": ["<判断理由の短文 (${outputLanguage === 'ja' ? '日本語' : outputLanguage})>"],
  "evidence": [
    {
      "field": "title" | "abstract",
      "quote": "<title または abstract からの正確な部分文字列>",
      "start_char": <field 内テキストの0始まり開始位置 (整数)>,
      "end_char": <field 内テキストの終了位置 (整数, 排他的)>
    }
  ]
}
\`\`\`

注意:
- include_probability は組み入れ基準に合致する確率（0.0=完全に除外, 1.0=確実に組入）
- quote は title または abstract 内の正確な部分文字列でなければならない
- evidence が無い場合でも空配列 [] を出力する（フィールド省略不可）`;
}

function tryParseJson(text: string): LlmScreeningOutput | null {
    try {
        return JSON.parse(text) as LlmScreeningOutput;
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]) as LlmScreeningOutput;
        } catch {
            return null;
        }
    }
}

async function callOnce(
    config: OpenRouterModelConfig,
    promptText: string,
    timeoutMs: number
): Promise<OpenRouterScreenResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // OpenRouter の provider routing:
    // - response_format は provider ごとに対応がまちまち（Qwen3-Thinking では Alibaba のみ、
    //   Kimi K2 Thinking では Google のみ等）。AtlasCloud に振られると 400 を返す。
    // - そのため response_format は送らず、プロンプト側で JSON 形式を強制し、
    //   tryParseJson のフォールバック抽出で吸収する設計に倒す。
    const body: Record<string, unknown> = {
        model: config.model,
        temperature: config.temperature,
        messages: [
            { role: 'user', content: promptText },
        ],
        usage: { include: true },
    };
    if (config.topP !== undefined) body.top_p = config.topP;
    if (config.maxOutputTokens !== undefined) body.max_tokens = config.maxOutputTokens;
    if (config.reasoningEffort) {
        body.reasoning = { effort: config.reasoningEffort };
    }
    // SCREENING_OUTPUT_SCHEMA は参照のみ（型チェック・ドキュメント目的）。実送信はしない。
    void SCREENING_OUTPUT_SCHEMA;

    try {
        const response = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getApiKey()}`,
                'HTTP-Referer': 'https://github.com/youkiti/tiab-review-plugin',
                'X-Title': 'tiab-review-plugin benchmark',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`OpenRouter API error ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json() as {
            id?: string;
            model?: string;
            provider?: string;
            choices?: Array<{ message?: { content?: string } }>;
            usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                completion_tokens_details?: { reasoning_tokens?: number };
                total_tokens?: number;
            };
        };

        const text = data.choices?.[0]?.message?.content ?? '';
        if (!text) {
            throw new Error('OpenRouter: 空のレスポンス');
        }

        const parsed = tryParseJson(text);
        if (!parsed) {
            throw new Error(`OpenRouter: JSON パース失敗。先頭200文字=${text.slice(0, 200)}`);
        }

        const u = data.usage || {};
        const usage: OpenRouterUsage = {
            promptTokens: u.prompt_tokens || 0,
            completionTokens: u.completion_tokens || 0,
            reasoningTokens: u.completion_tokens_details?.reasoning_tokens || 0,
            totalTokens: u.total_tokens || 0,
        };

        return {
            output: parsed,
            usage,
            metadata: {
                model: data.model,
                provider: data.provider,
                responseId: data.id,
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * リトライ付きでスクリーニングを実行
 */
export async function screenViaOpenRouter(
    title: string,
    abstract: string,
    screeningPrompt: string,
    config: OpenRouterModelConfig,
    outputLanguage: string = 'ja',
    maxRetries: number = 2,
    timeoutMs: number = 120000
): Promise<OpenRouterScreenResult> {
    const promptText = buildPrompt(title, abstract, screeningPrompt, outputLanguage);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await callOnce(config, promptText, timeoutMs);
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                const delay = 5000 * Math.pow(2, attempt);
                console.warn(`[openrouter] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${(err as Error).message}`);
                await sleep(delay);
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
