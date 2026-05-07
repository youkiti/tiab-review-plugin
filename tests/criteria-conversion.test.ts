import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionApiKey, setSessionApiKey } from '../src/lib/storage';
import { convertCriteria } from '../src/lib/gemini-api';

type FetchMock = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const originalGeminiApiKey = process.env.GEMINI_API_KEY;

function installChromeI18nMock(): void {
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
        i18n: {
            getMessage: (key: string, substitutions?: string | string[]) => {
                if (!substitutions) return key;
                const values = Array.isArray(substitutions) ? substitutions : [substitutions];
                return `${key}: ${values.join(',')}`;
            },
        },
    } as typeof chrome;
}

function createStreamResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createGeminiChunk(text: string): unknown {
    return {
        candidates: [
            {
                content: {
                    parts: [{ text }],
                },
            },
        ],
        usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            thoughtsTokenCount: 0,
            totalTokenCount: 2,
        },
    };
}

function setFetchMock(mock: FetchMock): void {
    globalThis.fetch = mock as typeof fetch;
}

test.beforeEach(() => {
    installChromeI18nMock();
    setSessionApiKey('test-api-key');
    process.env.GEMINI_API_KEY = '';
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
    clearSessionApiKey();
    if (originalGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
    } else {
        process.env.GEMINI_API_KEY = originalGeminiApiKey;
    }
});

test('convertCriteria は JSON 解析失敗をリトライし、PECO 欠損フィールドを補完する', async () => {
    let callCount = 0;
    const retryEvents: Array<{ attempt: number; maxRetries: number; delayMs: number }> = [];
    const successPayload = {
        criteria: {
            template: 'peco',
            fields: {
                P: '成人',
                S: 'RCT',
            },
        },
        screening_prompt: 'screening prompt',
    };

    setFetchMock(async () => {
        callCount += 1;
        if (callCount === 1) {
            return new Response('not-json', { status: 200 });
        }
        if (callCount === 2) {
            return createStreamResponse([]);
        }
        return createStreamResponse([createGeminiChunk(JSON.stringify(successPayload))]);
    });

    const result = await convertCriteria(
        'protocol text',
        { model: 'gemini-3-flash-preview', temperature: 0 },
        'ja',
        {
            retryDelayMs: 0,
            onRetry: (attempt, maxRetries, delayMs) => {
                retryEvents.push({ attempt, maxRetries, delayMs });
            },
        }
    );

    assert.equal(callCount, 3);
    assert.deepEqual(retryEvents, [
        { attempt: 1, maxRetries: 2, delayMs: 0 },
        { attempt: 2, maxRetries: 2, delayMs: 0 },
    ]);
    assert.deepEqual(result.criteria.fields, {
        P: '成人',
        E: '',
        C: '',
        O: '',
        S: 'RCT',
    });
    assert.equal(result.screening_prompt, 'screening prompt');
});

test('convertCriteria は 403 をリトライしない', async () => {
    let callCount = 0;
    const retryEvents: number[] = [];
    setFetchMock(async () => {
        callCount += 1;
        return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'Content-Type': 'application/json' },
        });
    });

    await assert.rejects(
        convertCriteria(
            'protocol text',
            { model: 'gemini-3-flash-preview', temperature: 0 },
            'ja',
            {
                retryDelayMs: 0,
                onRetry: (attempt) => retryEvents.push(attempt),
            }
        )
    );

    assert.equal(callCount, 1);
    assert.deepEqual(retryEvents, []);
});

test('convertCriteria は API キー未設定時に fetch を呼ばずリトライしない', async () => {
    clearSessionApiKey();
    delete process.env.GEMINI_API_KEY;
    let callCount = 0;
    const retryEvents: number[] = [];
    setFetchMock(async () => {
        callCount += 1;
        return createStreamResponse([]);
    });

    await assert.rejects(
        convertCriteria(
            'protocol text',
            { model: 'gemini-3-flash-preview', temperature: 0 },
            'ja',
            {
                retryDelayMs: 0,
                onRetry: (attempt) => retryEvents.push(attempt),
            }
        )
    );

    assert.equal(callCount, 0);
    assert.deepEqual(retryEvents, []);
});

test('convertCriteria は SPIDER の標準フィールドを補完し、追加フィールドを保持する', async () => {
    const successPayload = {
        criteria: {
            template: 'spider',
            fields: {
                S: '患者',
                E: '経験',
                extra: '追加条件',
            },
        },
        screening_prompt: 'screening prompt',
    };
    setFetchMock(async () => createStreamResponse([createGeminiChunk(JSON.stringify(successPayload))]));

    const result = await convertCriteria(
        'protocol text',
        { model: 'gemini-3-flash-preview', temperature: 0 },
        'ja',
        { retryDelayMs: 0 }
    );

    assert.deepEqual(result.criteria.fields, {
        S: '患者',
        PI: '',
        D: '',
        E: '経験',
        R: '',
        extra: '追加条件',
    });
});
