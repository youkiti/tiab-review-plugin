// 自由問い合わせの中止・タイムアウト・不正応答を共通化する。
import type { AskParams } from './ask-types';

export function askError(kind: string): Error {
    return Object.assign(new Error(`ヘルプ相談: ${kind}`), { kind, retryable: false });
}

export function parseAskText(text: string, schema?: object): unknown {
    if (!text.trim()) {
        throw askError('invalid_response');
    }
    if (!schema) {
        return text;
    }
    try {
        return JSON.parse(text);
    } catch {
        throw askError('invalid_response');
    }
}

export async function withAskSignal<T>(params: AskParams, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let reason: 'aborted' | 'timeout' | undefined;
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
        rejectAbort = reject;
    });
    const abort = (kind: 'aborted' | 'timeout') => {
        if (!reason) {
            reason = kind;
            controller.abort();
            rejectAbort(askError(kind));
        }
    };
    const onAbort = () => abort('aborted');
    params.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort('timeout'), params.timeoutMs ?? 60000);
    try {
        if (params.signal?.aborted) {
            throw askError('aborted');
        }
        return await Promise.race([run(controller.signal), aborted]);
    } catch (error) {
        if (reason) {
            throw askError(reason);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onAbort);
    }
}
