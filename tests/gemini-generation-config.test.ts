import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSessionApiKey, setSessionApiKey } from '../src/lib/storage';
import { screenReference } from '../src/lib/gemini-api';

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

const SCREENING_PAYLOAD = {
    include_probability: 0.8,
    reasons: ['reason'],
    evidence: [],
};

/**
 * fetch をスタブし、streamGenerateContent に送られたリクエストボディを JSON.parse して返す
 * getBody() を提供する（criteria-conversion.test.ts の fetch スタブの流儀を踏襲）。
 */
function captureRequestBody(): { getBody: () => { generationConfig: Record<string, unknown> } } {
    let capturedBody: { generationConfig: Record<string, unknown> } | undefined;
    setFetchMock(async (_input, init) => {
        capturedBody = JSON.parse((init?.body as string) ?? '{}');
        return createStreamResponse([createGeminiChunk(JSON.stringify(SCREENING_PAYLOAD))]);
    });
    return {
        getBody: () => {
            if (!capturedBody) throw new Error('fetch が呼ばれていません');
            return capturedBody;
        },
    };
}

test('screenReference は temperature を持たない config では generationConfig に temperature キーを含めない', async () => {
    const { getBody } = captureRequestBody();

    await screenReference('title', 'abstract', 'screening prompt', { model: 'gemini-3.8-flash' });

    const body = getBody();
    assert.equal('temperature' in body.generationConfig, false);
});

test('screenReference は temperature: 0 を指定すると generationConfig.temperature === 0 で送信する（0 が falsy で落ちないことの回帰確認）', async () => {
    const { getBody } = captureRequestBody();

    await screenReference('title', 'abstract', 'screening prompt', { model: 'gemini-3-flash-preview', temperature: 0 });

    const body = getBody();
    assert.equal(body.generationConfig.temperature, 0);
});

test('screenReference は topP を持たない config では generationConfig に topP キーを含めない', async () => {
    const { getBody } = captureRequestBody();

    await screenReference('title', 'abstract', 'screening prompt', { model: 'gemini-3.8-flash', temperature: 0 });

    const body = getBody();
    assert.equal('topP' in body.generationConfig, false);
});
