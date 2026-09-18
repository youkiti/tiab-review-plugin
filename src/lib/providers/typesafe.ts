// TypeSafe System One プロバイダ。1文献を1リクエストで判定し、noul を組入確率として扱う。
// 総合質問と基準の要素別質問を送り、文章の理由や抜粋は要求しない。
// リトライは llm-processor.ts の processWithRetry / RateLimitGovernor に任せる。
// 内部で待つとガバナーから待ち時間が見えなくなるため、ここでは1回だけ通信する。

import type { LlmCriteria, LlmScreeningOutput, UsageMetadata, LlmModelResponseMetadata } from '../types';
import { getEffectiveTypeSafeApiKey, getEffectiveOpenRouterApiKey } from '../storage';

// ディスパッチ層への型 import も循環になるため、使用する入力だけを構造型で受け取る。
interface TypeSafeScreenParams {
    title: string;
    abstract: string;
    screeningPrompt: string;
    model: string;
    outputLanguage: string;
    criteria?: LlmCriteria | null;
}

interface TypeSafeScreenResult {
    output: LlmScreeningOutput;
    usageMetadata: UsageMetadata;
    responseMetadata: LlmModelResponseMetadata;
}

const INCLUDE_QUESTION = 'Based on `screening_prompt`, should this record be included at the title/abstract screening stage?';
const CRITERION_QUESTION = 'Does this record meet `criterion`, or is it impossible to rule it out from the title and abstract alone?';

interface NoulQuestion {
    type: 'noul';
    instructions: {
        screening_prompt?: string;
        criterion?: { key: string; description: string };
        question: string;
    };
}

/** 質問 ID は連番にし、表示用のキーと送信順を別に保持する。 */
export function buildTypeSafeScreeningRequest(params: TypeSafeScreenParams) {
    const questions: Record<string, NoulQuestion> = {
        include: { type: 'noul', instructions: { screening_prompt: params.screeningPrompt, question: INCLUDE_QUESTION } },
    };
    const criterionKeys: string[] = [];
    for (const [key, value] of Object.entries(params.criteria?.fields ?? {})) {
        if (typeof value !== 'string' || !value.trim()) continue;
        questions[`criterion_${criterionKeys.length}`] = {
            type: 'noul',
            instructions: { criterion: { key, description: value.trim() }, question: CRITERION_QUESTION },
        };
        criterionKeys.push(key);
    }
    return {
        body: { model: params.model, state: { title: params.title, abstract: params.abstract || '(no abstract)' }, questions },
        criterionKeys,
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** 壊れた総合確率はリトライ対象とし、欠損した要素別確率は読み飛ばす。 */
export function parseTypeSafeScreeningResponse(
    data: unknown,
    params: TypeSafeScreenParams,
    criterionKeys: readonly string[]
): TypeSafeScreenResult {
    const response = asRecord(data);
    const answers = asRecord(response.answers);
    const probability = asRecord(answers.include).noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
        throw new Error('TypeSafe: 応答の include.noul が有限の数値ではありません');
    }
    const matches: string[] = [];
    criterionKeys.forEach((key, index) => {
        const noul = asRecord(answers[`criterion_${index}`]).noul;
        if (typeof noul === 'number' && Number.isFinite(noul)) matches.push(`${key} ${noul.toFixed(2)}`);
    });
    const prefix = params.outputLanguage === 'ja'
        ? '基準の要素ごとの合致確率: ' : 'Per-criterion match probability: ';
    const usage = asRecord(response.usage);
    const promptTokenCount = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
    const candidatesTokenCount = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
    return {
        output: {
            include_probability: Math.min(1, Math.max(0, probability)),
            // summarizeReasons() は先頭3件だけを Decisions の reason 列に使うため、
            // 4要素以上でも末尾が落ちないよう1つの文字列にまとめる。
            reasons: matches.length ? [prefix + matches.join(' / ')] : [],
            evidence: [],
        },
        usageMetadata: {
            promptTokenCount, candidatesTokenCount, thoughtsTokenCount: 0, totalTokenCount: promptTokenCount + candidatesTokenCount,
            ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { costUsd: usage.cost } : {}),
        },
        responseMetadata: {
            modelVersion: typeof response.model === 'string' && response.model.trim() ? response.model : params.model,
            ...(typeof response.id === 'string' ? { responseId: response.id } : {}),
        },
    };
}

function sanitizeApiKey(rawKey: string, providerName = 'TypeSafe'): string {
    let out = '';
    for (const ch of rawKey.trim()) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        // 不可視 Unicode を除去: ZWSP系/Word joiner/BOM/NBSP
        if (cp === 0x200B || cp === 0x200C || cp === 0x200D ||
            cp === 0x2060 || cp === 0xFEFF || cp === 0x00A0) continue;
        if (cp > 255) {
            throw new Error(`${providerName} APIキーに ISO-8859-1 範囲外の文字が含まれています。`
                + 'APIキーカードで再入力してください（コピペ時に全角文字や不可視文字が混入した可能性があります）。');
        }
        out += ch;
    }
    return out;
}

export async function screenViaTypeSafe(
    params: TypeSafeScreenParams, timeoutMs = 60000, route: 'typesafe' | 'openrouter' = 'typesafe'
): Promise<TypeSafeScreenResult> {
    const viaOpenRouter = route === 'openrouter';
    const rawKey = await (viaOpenRouter ? getEffectiveOpenRouterApiKey() : getEffectiveTypeSafeApiKey());
    const apiKey = rawKey ? sanitizeApiKey(rawKey, viaOpenRouter ? 'OpenRouter' : 'TypeSafe') : '';
    if (!apiKey) {
        throw new Error(viaOpenRouter
            ? 'OPENROUTER_API_KEY が設定されていません。サイドパネルから OpenRouter APIキーを登録してください。'
            : 'TYPE_SAFE_API_KEY が設定されていません。サイドパネルから TypeSafe APIキーを登録してください。');
    }
    const { body, criterionKeys } = buildTypeSafeScreeningRequest(params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = viaOpenRouter ? 'https://openrouter.ai/api/alpha/decisions' : 'https://api.typesafe.ai/v1/systemone';
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            // 応答にキーが含まれてもエラーメッセージへ流出させない。
            const text = (await response.text().catch(() => '')).split(apiKey).join('[REDACTED]');
            const unknownModel = response.status === 400 && text.includes(viaOpenRouter ? 'does not exist' : 'Unknown model');
            const detail = unknownModel
                ? `モデル ${params.model} が見つかりません（提供終了の可能性があります。拡張機能の更新が必要です）。応答=${text.slice(0, 200)}`
                : text.slice(0, 200);
            const error = new Error(`${viaOpenRouter ? 'OpenRouter Decisions' : 'TypeSafe'} API error ${response.status}: ${detail}`);
            // 4xx を恒久的な失敗と決めつけない。負荷時の 400 は直後に通ることがあるため、
            // キー不正・権限なし・モデル不明と、OpenRouter の残高不足だけを再試行不可にする。
            if (response.status === 401 || response.status === 403
                || (viaOpenRouter && response.status === 402) || unknownModel) Object.assign(error, { retryable: false });
            throw error;
        }
        // JSON として読めない場合も通常の Error のまま外側のリトライへ渡す。
        return parseTypeSafeScreeningResponse(await response.json(), params, criterionKeys);
    } finally {
        clearTimeout(timer);
    }
}

/** モデル一覧へのアクセス可否だけでキーを検証する。 */
export async function testTypeSafeApiKey(apiKey: string): Promise<{ isValid: boolean; reason?: string }> {
    try {
        const cleanKey = sanitizeApiKey(apiKey);
        const response = await fetch('https://api.typesafe.ai/v1/models', {
            method: 'GET', headers: { 'Authorization': `Bearer ${cleanKey}` },
        });
        return response.ok ? { isValid: true } : { isValid: false, reason: `HTTP ${response.status}` };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isValid: false, reason: apiKey ? message.split(apiKey).join('[REDACTED]') : message };
    }
}
