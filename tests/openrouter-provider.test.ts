// OpenRouter チャットモデルの判定: HTTP エラーの印・API キーの伏せ字・内側の再試行を、実 API なしで検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenViaOpenRouter } from '../src/lib/providers/openrouter';
import { setSessionOpenRouterApiKey, clearSessionOpenRouterApiKey } from '../src/lib/storage';
import { processBatch } from '../src/lib/llm-processor';

const API_KEY = 'test-openrouter-key';
const params = {
    title: '対象文献', abstract: '抄録', screeningPrompt: '基準',
    model: 'qwen/qwen3-235b-a22b-2507', outputLanguage: 'ja',
};

type ErrorWithMarks = Error & { retryable?: boolean; status?: number };

/** fetch を差し替え、内側の待ち（setTimeout）を即時にする。 */
async function withMocks(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    setSessionOpenRouterApiKey(API_KEY);
    globalThis.fetch = mock;
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
        originalSetTimeout(fn, ms && ms >= 5000 ? 0 : ms)) as typeof setTimeout;
    try {
        await run();
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
        clearSessionOpenRouterApiKey();
    }
}

async function callWith(status: number, body: string): Promise<{ calls: number; error: ErrorWithMarks }> {
    let calls = 0;
    let error: ErrorWithMarks | undefined;
    await withMocks(async () => { calls++; return new Response(body, { status }); }, async () => {
        try { await screenViaOpenRouter(params); } catch (e) { error = e as ErrorWithMarks; }
    });
    assert.ok(error, 'エラーが投げられるはず');
    return { calls, error };
}

const unknownModelBody = '{"error":{"message":"qwen/x is not a valid model ID"}}';

test('HTTP 401・402・403・404・モデル不明の 400 は1回だけ通信し、再試行不可の印と status を持つ', async () => {
    const cases: Array<[number, string]> = [
        [401, ''], [402, ''], [403, ''], [404, ''],
        [400, unknownModelBody], [400, '{"error":{"message":"model does not exist"}}'],
    ];
    for (const [status, body] of cases) {
        const { calls, error } = await callWith(status, body);
        assert.equal(calls, 1, `${status} ${body}`);
        assert.equal(error.retryable, false);
        assert.equal(error.status, status);
        assert.match(error.message, new RegExp(`^OpenRouter API error ${status}:`));
    }
});

test('モデル不明の 400 のメッセージは TypeSafe と同じ形になる', async () => {
    const { error } = await callWith(400, unknownModelBody);
    assert.match(error.message, /モデル qwen\/qwen3-235b-a22b-2507 が見つかりません（提供終了の可能性があります。拡張機能の更新が必要です）。応答=/);
});

test('本文がモデル不明でない 400 と 408・429・500 は再試行可能で、内側で3回通信する', async () => {
    for (const status of [400, 408, 429, 500]) {
        const { calls, error } = await callWith(status, '{"error":{"message":"temporary"}}');
        assert.equal(calls, 3, String(status));
        assert.notEqual(error.retryable, false);
        assert.equal(error.status, status);
    }
});

test('応答本文に API キーが含まれても、エラーメッセージでは [REDACTED] になる', async () => {
    const { error } = await callWith(401, `invalid key ${API_KEY} rejected`);
    assert.ok(!error.message.includes(API_KEY));
    assert.match(error.message, /\[REDACTED\]/);
});

test('HTTP 401 の一括判定は1件1回の通信でフォールバックになる', async () => {
    let calls = 0;
    await withMocks(async () => { calls++; return new Response('', { status: 401 }); }, async () => {
        const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
            batchSize: 1, model: params.model, screeningPrompt: '基準', outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            sleepFn: async () => {}, random: () => 0,
        });
        assert.equal(result.fallbackCount, 1);
    });
    assert.equal(calls, 1);
});
