// Gemini Decisions API に PDF をそのまま送り、全文の二値判定を返す。
// 恒久的な失敗は打ち切り、一時的な通信失敗だけを再試行する。
import type { ExcludeReasonItem } from './exclude-reasons';
import type { FulltextJudgeOutput } from './types';
import { getEffectiveApiKey } from './storage';
import { sanitizeApiKey } from './providers/sanitize-api-key';
import { parseGeminiErrorPayload } from './gemini-api';
import { PdfTooLargeError } from './fulltext-ai-failures';

const INCLUDE_QUESTION = 'Should this candidate study be included in the review at the full-text screening stage?';
const REASON_QUESTION = 'If this candidate study is excluded at the full-text screening stage, which reason applies?';
const MAX_PDF_BYTES = 50_000_000;
// Cochrane-bench の CC BY で凍結した全文 PDF 用の閾値（experiments/gemini-decision-1/fulltext/results/thresholds.json の pdf.threshold）。
// サイドパネルの初期 JS に載せないため、全文タブの遅延チャンクからだけ読まれるこのファイルに置く。
export const GEMINI_DECISION_FULLTEXT_INCLUDE_THRESHOLD = 0.23053827861929876;
export const GEMINI_DECISION_FULLTEXT_PROMPT_VERSION = 'fulltext-gemini-decision-v1.0.0';

interface GeminiDecisionFulltextParams {
    model: string;
    title: string;
    screeningPrompt: string;
    reasonItems: readonly ExcludeReasonItem[];
    outputLanguage: string;
    bytes: Uint8Array;
}

export function buildGeminiDecisionFulltextRequest(
    params: Pick<GeminiDecisionFulltextParams, 'model' | 'title' | 'screeningPrompt' | 'reasonItems'>,
    pdfBase64: string
) {
    const items = params.reasonItems.filter(item => item.key.length > 0 && item.key.length <= 128 && item.key.trim() === item.key);
    const questions: Record<string, { type: 'noul' | 'choice'; instructions: string; criteria?: Record<string, string> }> = {
        include: { type: 'noul', instructions: `${params.screeningPrompt}\n\n${INCLUDE_QUESTION}` },
    };
    if (items.length >= 2) {
        questions.exclude_reason = {
            type: 'choice',
            instructions: `${params.screeningPrompt}\n\n${REASON_QUESTION}`,
            criteria: Object.fromEntries(items.map(item => [item.key, item.labelEn.trim() || item.label])),
        };
    }
    return {
        model: params.model,
        input: [
            { type: 'text', text: `Title: ${params.title}\n` },
            { type: 'document', data: pdfBase64, mime_type: 'application/pdf' },
        ],
        questions,
    };
}

export function buildGeminiDecisionFulltextPromptRecord(screeningPrompt: string, reasonItems: readonly ExcludeReasonItem[]): string {
    return JSON.stringify(buildGeminiDecisionFulltextRequest({
        model: 'gemini-decision-1', title: '{{TITLE}}', screeningPrompt, reasonItems,
    }, '{{PDF_BASE64}}'));
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseGeminiDecisionFulltextResponse(
    data: unknown, params: Pick<GeminiDecisionFulltextParams, 'model' | 'outputLanguage'>
) {
    const response = asRecord(data);
    const answers = asRecord(response.answers);
    const noul = asRecord(answers.include).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
        throw new Error('Gemini Decision: 応答の include.noul が有限の数値ではありません');
    }
    const probability = Math.min(1, Math.max(0, noul));
    const decision = probability >= GEMINI_DECISION_FULLTEXT_INCLUDE_THRESHOLD ? 'include' : 'exclude';
    const exclude = asRecord(answers.exclude_reason);
    const probabilities = Object.fromEntries(Object.entries(asRecord(exclude.probabilities))
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
    const input = asRecord(response.usage).total_input_tokens;
    const promptTokenCount = typeof input === 'number' && Number.isFinite(input) ? input : 0;
    const output: FulltextJudgeOutput = {
        decision, include_probability: probability,
        ...(decision === 'exclude' && typeof exclude.choice === 'string' ? { exclude_reason_category: exclude.choice } : {}),
        reason: params.outputLanguage === 'ja'
            ? `組入の確率 ${probability.toFixed(2)}（閾値 0.2305）`
            : `Inclusion probability ${probability.toFixed(2)} (threshold 0.2305)`,
        evidence: [],
    };
    return {
        output,
        ...(Object.keys(probabilities).length ? { reasonProbabilities: probabilities } : {}),
        usageMetadata: { promptTokenCount, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: promptTokenCount },
        responseMetadata: { modelVersion: params.model },
    };
}

/** 同じ PDF の再送では解消しない入力トークンの上限超過。 */
export class GeminiDecisionInputTooLongError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeminiDecisionInputTooLongError';
    }
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
}

export async function judgeFulltextViaGeminiDecision(
    params: GeminiDecisionFulltextParams,
    options: { timeoutMs?: number; maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}
) {
    if (params.bytes.byteLength > MAX_PDF_BYTES) {
        throw new PdfTooLargeError('Gemini Decision: PDF が 50 MB を超えています');
    }
    const rawKey = await getEffectiveApiKey();
    const apiKey = rawKey ? sanitizeApiKey(rawKey, 'Gemini') : '';
    if (!apiKey) {
        throw new Error('Gemini APIキーが設定されていません。サイドパネルから登録してください。');
    }
    const body = JSON.stringify(buildGeminiDecisionFulltextRequest(params, bytesToBase64(params.bytes)));
    const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180000);
        let waitMs = 2000 * 2 ** (attempt - 1);
        let retryable = true;
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
                method: 'POST',
                headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
                body, signal: controller.signal,
            });
            if (!response.ok) {
                retryable = response.status === 429 || response.status >= 500;
                const text = (await response.text()).split(apiKey).join('[REDACTED]');
                let payload: unknown;
                try {
                    payload = JSON.parse(text);
                } catch {
                    payload = { error: { message: text } };
                }
                const message = asRecord(asRecord(payload).error).message;
                if (response.status === 400 && typeof message === 'string' && /input token count exceeds the maximum/i.test(message)) {
                    throw new GeminiDecisionInputTooLongError(`Gemini Decision API error 400: ${message.slice(0, 200)}`);
                }
                if (response.status === 429) {
                    waitMs = Math.min(60000, Math.max(waitMs, parseGeminiErrorPayload(payload).retryAfterMs ?? 0));
                }
                throw new Error(`Gemini Decision API error ${response.status}: ${text.slice(0, 200)}`);
            }
            let data: unknown;
            try {
                data = await response.json();
            } catch (err) {
                // 本文の受信中の通信失敗・タイムアウトは再試行し、形式不正は打ち切る。
                retryable = controller.signal.aborted || err instanceof TypeError;
                throw err;
            }
            retryable = false;
            return parseGeminiDecisionFulltextResponse(data, params);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            error.message = error.message.split(apiKey).join('[REDACTED]');
            if (!retryable || attempt >= maxAttempts) {
                throw error;
            }
        } finally {
            clearTimeout(timer);
        }
        await sleep(waitMs);
    }
}
