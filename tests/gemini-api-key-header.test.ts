// Gemini の API キーを URL クエリでなくヘッダで送ることと、キーが例外・ログに出ないことの検査。
// 通信はせず、fetch を差し替える。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { callGeminiApiWithParts, GEMINI_API_KEY_HEADER } from '../src/lib/gemini-api';
import { GEMINI_ASK_API_KEY_HEADER } from '../src/lib/providers/gemini-ask';
import { clearSessionApiKey, setSessionApiKey } from '../src/lib/storage';
import { installDemoFetchMock } from '../src/demo/fetch-mock';

const KEY = 'test-key-AIza-0000';

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const originalError = console.error;
const originalWarn = console.warn;
let logged: string[] = [];

test.beforeEach(() => {
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
        i18n: {
            getMessage: (key: string, substitutions?: string | string[]) => {
                if (!substitutions) return key;
                const values = Array.isArray(substitutions) ? substitutions : [substitutions];
                return `${key}: ${values.join(',')}`;
            },
        },
    } as typeof chrome;
    logged = [];
    const collect = (...args: unknown[]) => { logged.push(args.map(a => String(a)).join(' ')); };
    console.error = collect;
    console.warn = collect;
    setSessionApiKey(KEY);
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as typeof globalThis & { chrome: unknown }).chrome = originalChrome;
    console.error = originalError;
    console.warn = originalWarn;
    clearSessionApiKey();
});

test('callGeminiApiWithParts: URL にキーを含めず x-goog-api-key ヘッダで送る', async () => {
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        seenUrl = String(url);
        seenHeaders = new Headers(init?.headers);
        return new Response('[]', { status: 400, statusText: 'Bad Request' });
    }) as typeof fetch;

    await assert.rejects(callGeminiApiWithParts([{ text: '質問' }], {}));
    assert.ok(seenUrl.endsWith(':streamGenerateContent'));
    assert.ok(!seenUrl.includes('key='));
    assert.ok(!seenUrl.includes(KEY));
    assert.equal(seenHeaders?.get('x-goog-api-key'), KEY);
    assert.equal(seenHeaders?.get('content-type'), 'application/json');
    assert.deepEqual(logged.filter(l => l.includes(KEY)), []);
});

test('callGeminiApiWithParts: HTTP 400 の例外とログにキーが出ない', async () => {
    globalThis.fetch = (async () => new Response(
        JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }),
        { status: 400, statusText: 'Bad Request', headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;

    await assert.rejects(
        callGeminiApiWithParts([{ text: '質問' }], {}),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(!err.message.includes(KEY));
            assert.ok(!String(err).includes(KEY));
            return true;
        },
    );
    assert.deepEqual(logged.filter(l => l.includes(KEY)), []);
});

test('callGeminiApiWithParts: 通信失敗（URL を文言に入れる例外）でもキーが出ない', async () => {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
        throw new TypeError(`fetch failed: ${String(url)}`);
    }) as typeof fetch;

    await assert.rejects(
        callGeminiApiWithParts([{ text: '質問' }], {}),
        (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(!err.message.includes(KEY));
            assert.ok(!String(err).includes(KEY));
            return true;
        },
    );
    assert.deepEqual(logged.filter(l => l.includes(KEY)), []);
});

test('ヘッダ名の定数が gemini-api.ts と gemini-ask.ts で一致する', () => {
    assert.equal(GEMINI_API_KEY_HEADER, 'x-goog-api-key');
    assert.equal(GEMINI_ASK_API_KEY_HEADER, GEMINI_API_KEY_HEADER);
});

test('src/ 配下に URL クエリへ API キーを載せる書き方（?key=${...}）が無い', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                walk(path);
            } else if (path.endsWith('.ts')) {
                readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
                    if (/[?&]key=\$\{/.test(line)) offenders.push(`${path}:${i + 1}`);
                });
            }
        }
    };
    walk(join(process.cwd(), 'src'));
    assert.deepEqual(offenders, []);
});

test('デモの未対応リクエストの警告にクエリ文字列が出ない', async () => {
    globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
    installDemoFetchMock();
    await fetch('https://www.googleapis.com/unknown?key=abc');
    const warned = logged.filter(l => l.includes('[demo] 未対応の外部リクエスト'));
    assert.ok(warned.length >= 1);
    assert.ok(warned.every(l => !l.includes('key=') && !l.includes('abc')));
    assert.ok(warned.some(l => l.includes('https://www.googleapis.com/unknown')));
});
