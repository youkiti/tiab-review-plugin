/**
 * OpenRouter 用の薄い API クライアント（ベンチマーク専用、qwen/qwen3.8-27b 向け）
 *
 * 本体実装（src/lib/gemini-api.ts）には触らず、experiments 配下に閉じる。
 * OpenAI 互換 chat/completions エンドポイントに対し response_format: json_schema で
 * Gemini 側と同等のスキーマを強制する。
 *
 * 対象モデル:
 *  - qwen/qwen3.8-27b (配信プロバイダ AkashML、quantization bf16)
 *
 * openrouter-bench/openrouter-client.ts からのコピーを起点に、qwen3.8-27b の
 * 実測（Phase 0 疎通確認, 2026-08-16）を踏まえて以下を変更している:
 *  - provider ルーティングを bf16/AkashML に固定（下記コメント参照）
 *  - reasoning.enabled=false を明示送信できるようにした（下記コメント参照）
 *  - response_format: json_schema を実送信するようにした（下記コメント参照）
 *
 * 設計判断（コピー元から変更なし）:
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
    /**
     * qwen3.8-27b は thinking がデフォルト ON のモデル。何も指定しないと reasoning
     * トークンが出てしまうため、「非thinking条件」を作りたい場合は明示的に false を
     * 指定する必要がある（Phase 0 実測: reasoning.enabled=false を送ると reasoning
     * トークン数が 0 になることを確認済み）。
     */
    reasoningEnabled?: boolean;
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
    // response_format: json_schema で出力形式を強制しているが、モデルによっては
    // プロンプト側の指示も併用した方が安定するため、既存同様に明示指示も残す。
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

    const body: Record<string, unknown> = {
        model: config.model,
        temperature: config.temperature,
        messages: [
            { role: 'user', content: promptText },
        ],
        usage: { include: true },
        // qwen3.8-27b は配信プロバイダが AkashML 1社のみ、quantization は bf16。
        // Phase 0 で確認済みの構成に固定し、他の量子化（精度が変わりうる）に流れないようにする。
        // また 2026-08-14 リリース直後のモデルで今後プロバイダが増える可能性があるため、
        // allow_fallbacks: false により bf16 以外へ黙って切り替わらないようにする
        // （フォールバック時は素直にエラーにする設計）。
        provider: {
            quantizations: ['bf16'],
            allow_fallbacks: false,
        },
        // AkashML では response_format: json_schema (strict) が動作することを Phase 0 で
        // 実測確認済み（50件でパース失敗0・フォールバック0・打ち切り0）。
        // openrouter-bench 版はプロバイダごとに対応がまちまちという理由で送っていなかったが、
        // qwen3.8-27b はプロバイダが AkashML 固定のため送信して構造化出力を強制する。
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'screening',
                strict: true,
                schema: SCREENING_OUTPUT_SCHEMA,
            },
        },
    };
    if (config.topP !== undefined) body.top_p = config.topP;
    if (config.maxOutputTokens !== undefined) body.max_tokens = config.maxOutputTokens;
    if (config.reasoningEffort) {
        body.reasoning = { effort: config.reasoningEffort };
    } else if (config.reasoningEnabled === false) {
        // qwen3.8-27b は thinking がデフォルト ON のため、reasoningEffort 未指定なだけでは
        // 「非thinking条件」にならず黙って thinking ON のまま走ってしまう。
        // 非thinking条件を作るには enabled: false を明示送信する必要がある
        // （Phase 0 実測: これで reasoning トークン数が 0 になることを確認済み）。
        body.reasoning = { enabled: false };
    }

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
