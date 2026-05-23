// providers/openrouter.ts - OpenRouter プロバイダ実装
//
// experiments/openrouter-bench/openrouter-client.ts を本体に取り込んだもの。
// API キーは chrome.storage 経由（getEffectiveOpenRouterApiKey）。
//
// 設計判断:
// - response_format(JSON Schema) は OpenRouter の provider routing 先により対応がまちまちで
//   400 を返すことがあるため送らない。プロンプト側で JSON 形式を強制し、
//   テキスト中の {...} を抽出するフォールバックで吸収する（ベンチで実証済み）。
// - 失敗時は最大 2 回リトライ（指数バックオフ 5s, 10s）。
// - usage.prompt_tokens / completion_tokens / reasoning_tokens を返してコスト計算へ。

import type { LlmScreeningOutput, LlmCriteria } from '../types';
import type {
    LlmScreenParams,
    LlmScreenResult,
    ConvertCriteriaParams,
    ConvertCriteriaOptions,
    ConvertCriteriaResult,
} from '../llm-provider';
import { getEffectiveOpenRouterApiKey } from '../storage';
import { normalizeCriteriaConversionResult } from '../gemini-api';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPrompt(title: string, abstract: string, screeningPrompt: string, outputLanguage: string): string {
    // OpenRouter は json_object モードを使わず、プロンプトで JSON 形式を明示的に指示する。
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

async function getApiKey(): Promise<string> {
    const key = await getEffectiveOpenRouterApiKey();
    if (!key) {
        throw new Error('OPENROUTER_API_KEY が設定されていません。サイドパネルから OpenRouter APIキーを登録してください。');
    }
    return key;
}

async function callOnce(
    params: LlmScreenParams,
    promptText: string,
    timeoutMs: number
): Promise<LlmScreenResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
        model: params.model,
        temperature: params.temperature,
        messages: [{ role: 'user', content: promptText }],
        usage: { include: true },
    };
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.maxOutputTokens !== undefined) body.max_tokens = params.maxOutputTokens;
    if (params.reasoningEffort) {
        body.reasoning = { effort: params.reasoningEffort };
    }

    try {
        const apiKey = await getApiKey();
        const response = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/youkiti/tiab-review-plugin',
                'X-Title': 'tiab-review-plugin',
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
        const promptTokens = u.prompt_tokens || 0;
        const completionTokens = u.completion_tokens || 0;
        const reasoningTokens = u.completion_tokens_details?.reasoning_tokens || 0;
        const totalTokens = u.total_tokens || (promptTokens + completionTokens);

        return {
            output: parsed,
            usageMetadata: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: completionTokens,
                thoughtsTokenCount: reasoningTokens,
                totalTokenCount: totalTokens,
            },
            responseMetadata: {
                modelVersion: data.model || params.model,
                responseId: data.id,
            },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * リトライ付きで OpenRouter スクリーニングを実行
 *
 * `processWithRetry` 側でも 2 回リトライするが、ここでも軽い 2 回リトライを入れて
 * 一時的な provider routing 失敗・429 を吸収する。
 */
export async function screenViaOpenRouter(
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
            if (attempt < maxRetries) {
                const delay = 5000 * Math.pow(2, attempt);
                console.warn(`[openrouter] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${(err as Error).message}`);
                await sleep(delay);
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * OpenRouter で criteria 変換（PICO/PECO 等）を行う。
 *
 * Gemini 版 (`convertCriteria` in gemini-api.ts) と機能等価。差分:
 * - response_format は使わず、プロンプト側で JSON 形式を明示
 * - フォールバックパース ({...} 抽出) で provider routing 先の差異を吸収
 * - リトライは指数バックオフ (5s, 10s) を内部で実施
 *
 * 失敗時はエラーを投げる（呼び出し側で再試行可）。
 */
function buildCriteriaPrompt(protocolText: string, outputLanguage: string): string {
    const langLabel = outputLanguage === 'ja' ? '日本語' : outputLanguage;
    return `以下のプロトコルの組み入れ・除外基準を解析し、システマティックレビューのタイトル・抄録スクリーニングに最適な形式に変換してください。

## 入力: プロトコルの基準
${protocolText}

## 出力指示

以下の JSON スキーマに厳密に従って出力すること。余計なテキスト・コードフェンス・コメントは一切出力しないこと。

\`\`\`json
{
  "criteria": {
    "template": "pico" | "peco" | "spider" | "custom",
    "fields": {
      "P": "<対象患者/集団 (${langLabel})>",
      "I": "<介入 (PICO の場合)>",
      "E": "<曝露 (PECO の場合)>",
      "C": "<比較対照>",
      "O": "<アウトカム>",
      "S": "<サンプル/セッティング (SPIDER の場合)>",
      "PI": "<関心現象 (SPIDER の場合)>",
      "D": "<研究デザイン (SPIDER の場合)>",
      "R": "<研究タイプ (SPIDER の場合)>"
    }
  },
  "screening_prompt": "<スクリーニング用プロンプトテンプレート (${langLabel}) - 各要素のチェック方法を具体的に記述>"
}
\`\`\`

注意:
- template に応じて不要なフィールドは省略してよい（例: PICO なら P/I/C/O のみ）
- 各フィールドは ${langLabel} で簡潔に記述
- タイトル・抄録レベルのスクリーニングであることを念頭に置く
- フルテキストでしか確認できない基準は緩めに解釈する
- 明確に除外できる場合のみ低確率とする`;
}

async function callCriteriaOnce(
    params: ConvertCriteriaParams,
    promptText: string,
    timeoutMs: number
): Promise<ConvertCriteriaResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const body: Record<string, unknown> = {
        model: params.model,
        temperature: params.temperature,
        messages: [{ role: 'user', content: promptText }],
        usage: { include: true },
    };
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.maxOutputTokens !== undefined) body.max_tokens = params.maxOutputTokens;
    if (params.reasoningEffort) {
        body.reasoning = { effort: params.reasoningEffort };
    }

    try {
        const apiKey = await getApiKey();
        const response = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/youkiti/tiab-review-plugin',
                'X-Title': 'tiab-review-plugin',
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
            choices?: Array<{ message?: { content?: string } }>;
        };
        const text = data.choices?.[0]?.message?.content ?? '';
        if (!text) {
            throw new Error('OpenRouter: 空のレスポンス');
        }

        const parsed = tryParseCriteriaJson(text);
        if (!parsed) {
            throw new Error(`OpenRouter: criteria JSON パース失敗。先頭200文字=${text.slice(0, 200)}`);
        }

        return normalizeCriteriaConversionResult(parsed);
    } finally {
        clearTimeout(timer);
    }
}

function tryParseCriteriaJson(text: string): { criteria: LlmCriteria; screening_prompt: string } | null {
    const validate = (obj: unknown): obj is { criteria: LlmCriteria; screening_prompt: string } => {
        if (typeof obj !== 'object' || obj === null) return false;
        const o = obj as Record<string, unknown>;
        if (typeof o.screening_prompt !== 'string') return false;
        const c = o.criteria;
        if (typeof c !== 'object' || c === null) return false;
        const co = c as Record<string, unknown>;
        return typeof co.template === 'string' && typeof co.fields === 'object' && co.fields !== null;
    };
    try {
        const obj = JSON.parse(text);
        if (validate(obj)) return obj;
    } catch {
        // fall through to {...} extraction
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        return validate(obj) ? obj : null;
    } catch {
        return null;
    }
}

function criteriaSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function convertCriteriaViaOpenRouter(
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
            if (attempt >= maxRetries) break;
            const delay = (options.retryDelayMs ?? 5000) * Math.pow(2, attempt);
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[openrouter:criteria] retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${message}`);
            options.onRetry?.(attempt + 1, maxRetries, delay);
            await criteriaSleep(delay);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * OpenRouter API キーの簡易検証
 *
 * Gemini の testApiKeyWithTier と異なり tier の概念がないため、
 * `/api/v1/key` エンドポイントで 200 が返るかだけ確認する。
 */
export async function testOpenRouterApiKey(apiKey: string): Promise<{ isValid: boolean; reason?: string }> {
    try {
        const response = await fetch('https://openrouter.ai/api/v1/key', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
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
