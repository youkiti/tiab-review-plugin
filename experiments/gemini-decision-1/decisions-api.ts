// Decisions API の要求・応答処理を担当する。実 API を使う分岐からだけ読み込む。
import type { Screen } from './runner';

export function createScreen(model: string, prompt: string, apiKey: string): Screen {
    return async record => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/decisions', {
                method: 'POST',
                headers: {
                    'x-goog-api-key': apiKey,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    input: `Title: ${record.title}\n\nAbstract: ${record.abstract || '(no abstract)'}`,
                    questions: { include: {
                        type: 'noul',
                        instructions: `${prompt}\n\nShould this record be included at the title/abstract screening stage?`,
                    } },
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                let errorStatus: string | null = null;
                if (response.status === 400) {
                    try {
                        const body = await response.json();
                        const status = body?.error?.status;
                        if (typeof status === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(status)) {
                            errorStatus = status;
                        }
                    } catch {
                        // 本文を読めなくても HTTP ステータスだけで再試行する。
                    }
                }
                throw Object.assign(new Error(`API error ${response.status}`), {
                    httpStatus: response.status, errorStatus, kind: 'http',
                    retryable: ![401, 403, 404].includes(response.status),
                });
            }
            let body;
            try {
                body = await response.json();
            } catch {
                throw Object.assign(new Error('応答 JSON が不正です。'), { kind: 'invalid_response' });
            }
            const probability = body?.answers?.include?.noul;
            const input = body?.usage?.total_input_tokens;
            const output = body?.usage?.total_output_tokens ?? 0;
            const version = body?.modelVersion ?? body?.model_version;
            if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1
                || ![input, output].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
                || (version != null && typeof version !== 'string')) {
                throw Object.assign(new Error('応答の形式が不正です。'), { kind: 'invalid_response' });
            }
            return {
                output: { include_probability: probability },
                usageMetadata: { promptTokenCount: input, candidatesTokenCount: output },
                responseMetadata: { modelVersion: version ?? undefined },
            };
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
