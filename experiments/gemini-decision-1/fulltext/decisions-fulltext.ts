// 全文 Decisions API の二問の要求を組み立て、機密情報を残さず応答を検証する。
import fs from 'fs';
import { Config, Input, RecordRow, Result, nonnegative, validResult } from './common';

// PDF の配列形式は実 API との照合時にここだけを修正できるようにする。
export function pdfInput(title: string, bytes: Buffer) {
    return [{ type: 'text', text: `Title: ${title}\n` },
        { type: 'document', data: bytes.toString('base64'), mime_type: 'application/pdf' }];
}
export type Screen = (record: RecordRow, attempt: number, pdfFile: string) => Promise<Result>;
export function createScreen(config: Config, input: Input, apiKey: string): Screen {
    return async (record, _attempt, pdfFile) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
                method: 'POST',
                headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: config.model,
                    input: input === 'pdf' ? pdfInput(record.title, fs.readFileSync(pdfFile))
                        : `Title: ${record.title}\n\nFull text:\n${record.text}`,
                    questions: {
                        include: { type: 'noul', instructions: `${record.screening_prompt}\n\n${config.includeQuestion}` },
                        exclude_reason: { type: 'choice', instructions: `${record.screening_prompt}\n\n${config.reasonQuestion}`,
                            criteria: config.reasonCriteria },
                    } }),
                signal: controller.signal,
            });
            if (!response.ok) {
                let errorStatus: string | null = null;
                let tooLong = false;
                if (response.status === 400) {
                    try {
                        const body = await response.json();
                        const status = body?.error?.status;
                        if (typeof status === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(status)) {
                            errorStatus = status;
                        }
                        // 入力トークンの上限超えは送り直しても通らないため、文言で判定して再試行しない（文言は記録しない）。
                        const message = body?.error?.message;
                        tooLong = typeof message === 'string' && /input token count exceeds the maximum/i.test(message);
                    } catch {
                        // HTTP の分類だけで再試行し、応答本文は記録しない。
                    }
                }
                throw Object.assign(new Error(`API error ${response.status}`), {
                    httpStatus: response.status, errorStatus, kind: tooLong ? 'input_too_long' : 'http',
                    retryable: !tooLong && ![401, 403, 404].includes(response.status),
                });
            }
            let body;
            try {
                body = await response.json();
            } catch {
                throw Object.assign(new Error('応答 JSON が不正です。'), { kind: 'invalid_response' });
            }
            const result: Result = {
                include_probability: body?.answers?.include?.noul,
                reason_choice: body?.answers?.exclude_reason?.choice,
                reason_probabilities: body?.answers?.exclude_reason?.probabilities,
                input_tokens: body?.usage?.total_input_tokens,
                tokens_by_modality: Array.isArray(body?.usage?.input_tokens_by_modality) ? body.usage.input_tokens_by_modality : null,
                model_version: body?.modelVersion ?? body?.model_version ?? null,
            };
            if (!validResult(result, config.reasonCriteria) || !nonnegative(body?.usage?.total_output_tokens ?? 0)) {
                throw Object.assign(new Error('応答の形式が不正です。'), { kind: 'invalid_response' });
            }
            return result;
        } catch (error) {
            if (controller.signal.aborted) {
                throw Object.assign(new Error('要求がタイムアウトしました。'), { kind: 'timeout' });
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    };
}
