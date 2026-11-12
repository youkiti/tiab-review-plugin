// TypeSafe 直 API で全文テキストを判定し、組入確率と除外理由を返す。
// 一時的な失敗だけを指数バックオフで再試行する。
import type { FulltextJudgeOutput, UsageMetadata, LlmModelResponseMetadata } from './types';
import { fallbackExcludeReasonKey, type ExcludeReasonItem } from './exclude-reasons';
import { getEffectiveTypeSafeApiKey } from './storage';
import { sanitizeApiKey } from './providers/sanitize-api-key';

export const TYPESAFE_FULLTEXT_INCLUDE_THRESHOLD = 0.3;
export const TYPESAFE_FULLTEXT_PROMPT_VERSION = 'fulltext-typesafe-v1.0.0';
const INCLUDE_QUESTION = 'Based on `screening_prompt`, should this record be included at the full-text screening stage?';

interface TypeSafeFulltextParams {
    model: string;
    title: string;
    fullText: string;
    screeningPrompt: string;
    reasonItems: readonly ExcludeReasonItem[];
    outputLanguage: string;
}

interface FulltextResult {
    output: FulltextJudgeOutput;
    reasonProbabilities?: Record<string, number>;
    usageMetadata: UsageMetadata;
    responseMetadata: LlmModelResponseMetadata;
}

function buildReasonQuestion(items: readonly ExcludeReasonItem[]): string {
    const fallback = fallbackExcludeReasonKey(items);
    return [
        'If this record is excluded at the full-text screening stage, which exclusion reason applies? '
        + 'The reasons are listed in priority order. If more than one applies, choose the one listed first. '
        + `If none of them applies, choose "${fallback}".`,
        ...items.map((item, index) => `${index + 1}. ${item.key} (${item.labelEn || item.label})`),
    ].join('\n');
}

export function buildTypeSafeFulltextRequest(params: Omit<TypeSafeFulltextParams, 'outputLanguage'>) {
    const items = params.reasonItems.filter(item => item.key.length > 0 && item.key.length <= 128 && item.key.trim() === item.key);
    const questions: Record<string, {
        type: 'noul' | 'choice';
        instructions: { screening_prompt: string; question: string };
        criteria?: Record<string, string>;
    }> = {
        include: { type: 'noul', instructions: { screening_prompt: params.screeningPrompt, question: INCLUDE_QUESTION } },
    };
    if (items.length >= 2) {
        questions.exclude_reason = {
            type: 'choice',
            instructions: { screening_prompt: params.screeningPrompt, question: buildReasonQuestion(items) },
            criteria: Object.fromEntries(items.map(item => [item.key, item.labelEn || item.label])),
        };
    }
    return { model: params.model, state: { title: params.title || '(no title)', full_text: params.fullText }, questions };
}

export function buildTypeSafeFulltextPromptRecord(screeningPrompt: string, reasonItems: readonly ExcludeReasonItem[]): string {
    return [screeningPrompt, INCLUDE_QUESTION, buildReasonQuestion(reasonItems)].join('\n\n');
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseTypeSafeFulltextResponse(
    data: unknown,
    params: Pick<TypeSafeFulltextParams, 'model' | 'reasonItems' | 'outputLanguage'>
): FulltextResult {
    const response = asRecord(data);
    const answers = asRecord(response.answers);
    const noul = asRecord(answers.include).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
        throw new Error('TypeSafe: 応答の include.noul が有限の数値ではありません');
    }
    const probability = Math.min(1, Math.max(0, noul));
    const decision = probability >= TYPESAFE_FULLTEXT_INCLUDE_THRESHOLD ? 'include' : 'exclude';
    const exclude = asRecord(answers.exclude_reason);
    const probabilities = Object.fromEntries(Object.entries(asRecord(exclude.probabilities))
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    const usage = asRecord(response.usage);
    const promptTokenCount = typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
    const candidatesTokenCount = typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
    return {
        output: {
            decision,
            include_probability: probability,
            ...(decision === 'exclude' && typeof exclude.choice === 'string' ? { exclude_reason_category: exclude.choice } : {}),
            reason: params.outputLanguage === 'ja'
                ? `組入の確率 ${probability.toFixed(2)}（閾値 0.3）`
                : `Inclusion probability ${probability.toFixed(2)} (threshold 0.3)`,
            evidence: [],
        },
        ...(Object.keys(probabilities).length ? { reasonProbabilities: probabilities } : {}),
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

/** 入力上限超過は、同じ本文を送り直しても解消しない。 */
export class TypeSafeInputTooLongError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TypeSafeInputTooLongError';
    }
}

export async function judgeFulltextViaTypeSafe(
    params: TypeSafeFulltextParams,
    options: { timeoutMs?: number; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<FulltextResult> {
    const rawKey = await getEffectiveTypeSafeApiKey();
    const apiKey = rawKey ? sanitizeApiKey(rawKey, 'TypeSafe') : '';
    if (!apiKey) {
        throw Object.assign(new Error(
            'TYPE_SAFE_API_KEY が設定されていません。サイドパネルから TypeSafe APIキーを登録してください。'
        ), { retryable: false });
    }
    const body = buildTypeSafeFulltextRequest(params);
    const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
        try {
            const response = await fetch('https://api.typesafe.ai/v1/systemone', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const text = (await response.text().catch(() => '')).split(apiKey).join('[REDACTED]');
                if (response.status === 400 && text.includes('max_tokens_exceeded')) {
                    throw new TypeSafeInputTooLongError(`TypeSafe API error 400: ${text.slice(0, 200)}`);
                }
                const unknownModel = response.status === 400 && text.includes('Unknown model');
                const detail = unknownModel
                    ? `モデル ${params.model} が見つかりません（提供終了の可能性があります。拡張機能の更新が必要です）。応答=${text.slice(0, 200)}`
                    : text.slice(0, 200);
                throw Object.assign(new Error(`TypeSafe API error ${response.status}: ${detail}`), {
                    status: response.status,
                    retryable: !([401, 402, 403].includes(response.status) || unknownModel),
                });
            }
            return parseTypeSafeFulltextResponse(await response.json(), params);
        } catch (err) {
            // 通信例外にもキーが混ざる可能性があるため、再送・伝播の前に伏せる。
            const error = err instanceof Error ? err : new Error(String(err));
            error.message = error.message.split(apiKey).join('[REDACTED]');
            if (error instanceof TypeSafeInputTooLongError
                || (error as Error & { retryable?: boolean }).retryable === false || attempt >= maxAttempts) {
                throw error;
            }
        } finally {
            clearTimeout(timer);
        }
        await sleep(2000 * 2 ** (attempt - 1));
    }
}
