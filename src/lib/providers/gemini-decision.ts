// Gemini Decisions API で総合・要素別の確率を取得する。
// 再試行と負荷調整は呼び出し側に任せ、1回だけ送信する。
import type { LlmCriteria, LlmScreeningOutput, UsageMetadata, LlmModelResponseMetadata } from '../types';
import { getEffectiveApiKey } from '../storage';
import { parseGeminiErrorPayload } from '../gemini-api';
import { sanitizeApiKey } from './sanitize-api-key';

interface GeminiDecisionScreenParams {
    title: string;
    abstract: string;
    screeningPrompt: string;
    model: string;
    outputLanguage: string;
    criteria?: LlmCriteria | null;
}

interface GeminiDecisionScreenResult {
    output: LlmScreeningOutput;
    usageMetadata: UsageMetadata;
    responseMetadata: LlmModelResponseMetadata;
}

const INCLUDE_QUESTION = 'Should this record be included at the title/abstract screening stage?';
const CRITERION_QUESTION = 'Does this record meet this criterion, or is it impossible to rule it out from the title and abstract alone?';

export function buildGeminiDecisionScreeningRequest(params: GeminiDecisionScreenParams) {
    const questions: Record<string, { type: 'noul'; instructions: string }> = {
        include: { type: 'noul', instructions: `${params.screeningPrompt}\n\n${INCLUDE_QUESTION}` },
    };
    const criterionKeys: string[] = [];
    for (const [key, value] of Object.entries(params.criteria?.fields ?? {})) {
        if (typeof value !== 'string' || !value.trim()) {
            continue;
        }
        questions[`criterion_${criterionKeys.length}`] = {
            type: 'noul',
            instructions: `${key}: ${value.trim()}\n\n${CRITERION_QUESTION}`,
        };
        criterionKeys.push(key);
    }
    return {
        body: {
            model: params.model,
            input: `Title: ${params.title}\n\nAbstract: ${params.abstract || '(no abstract)'}`,
            questions,
        },
        criterionKeys,
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseGeminiDecisionScreeningResponse(
    data: unknown, params: GeminiDecisionScreenParams, criterionKeys: readonly string[]
): GeminiDecisionScreenResult {
    const response = asRecord(data);
    const answers = asRecord(response.answers);
    const probability = asRecord(answers.include).noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
        throw new Error('Gemini Decision: 応答の include.noul が有限の数値ではありません');
    }
    const matches: string[] = [];
    criterionKeys.forEach((key, index) => {
        const noul = asRecord(answers[`criterion_${index}`]).noul;
        if (typeof noul === 'number' && Number.isFinite(noul)) {
            matches.push(`${key} ${noul.toFixed(2)}`);
        }
    });
    const prefix = params.outputLanguage === 'ja'
        ? '基準の要素ごとの合致確率: ' : 'Per-criterion match probability: ';
    const usage = asRecord(response.usage);
    const input = usage.total_input_tokens;
    const promptTokenCount = typeof input === 'number' && Number.isFinite(input) ? input : 0;
    return {
        output: {
            include_probability: Math.min(1, Math.max(0, probability)),
            reasons: matches.length ? [prefix + matches.join(' / ')] : [],
            evidence: [],
        },
        usageMetadata: { promptTokenCount, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: promptTokenCount },
        responseMetadata: { modelVersion: params.model },
    };
}

export async function screenViaGeminiDecision(
    params: GeminiDecisionScreenParams, timeoutMs = 60000
): Promise<GeminiDecisionScreenResult> {
    const rawKey = await getEffectiveApiKey();
    const apiKey = rawKey ? sanitizeApiKey(rawKey, 'Gemini') : '';
    if (!apiKey) {
        throw Object.assign(new Error('Gemini APIキーが設定されていません。サイドパネルから登録してください。'), { retryable: false });
    }
    const { body, criterionKeys } = buildGeminiDecisionScreeningRequest(params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
            method: 'POST',
            headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = (await response.text().catch(() => '')).split(apiKey).join('[REDACTED]');
            let payload: unknown;
            try {
                payload = JSON.parse(text);
            } catch {
                payload = { error: { message: text } };
            }
            const parsed = parseGeminiErrorPayload(payload);
            const error = Object.assign(new Error(`Gemini Decision API error ${response.status}: ${text.slice(0, 200)}`), {
                status: response.status,
                ...(response.status === 429 && parsed.retryAfterMs !== undefined ? { retryAfterMs: parsed.retryAfterMs } : {}),
            });
            // generateContent の経路（gemini-api.ts）と同じく、429 と 5xx だけを再試行する。
            // 誤った API キーは 401 ではなく 400 で返る（2026-11-12 実測）ため、400 も1回で打ち切る。
            if (response.status !== 429 && response.status < 500) {
                Object.assign(error, { retryable: false });
            }
            throw error;
        }
        return parseGeminiDecisionScreeningResponse(await response.json(), params, criterionKeys);
    } finally {
        clearTimeout(timer);
    }
}
