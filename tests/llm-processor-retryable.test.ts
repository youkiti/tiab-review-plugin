// 一括判定の再試行が、プロバイダ名でなくエラーの印（retryable）だけで決まることを検査する。
// 完全オフライン: screenFn を注入し、通信しない。

import test from 'node:test';
import assert from 'node:assert/strict';
import { processBatch } from '../src/lib/llm-processor';

const MODELS = [
    ['Gemini', 'gemini-3.1-flash-lite'],
    ['OpenAI', 'gpt-5.6-luna'],
    ['OpenRouter チャット', 'qwen/qwen3-235b-a22b-2507'],
    ['Anthropic', 'claude-haiku-5-5'],
    ['TypeSafe', 'jev-1.14.0'],
    ['ローカル LLM', 'local:model'],
] as const;

async function run(model: string, makeError: () => Error) {
    let calls = 0;
    const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
        batchSize: 1,
        model,
        screeningPrompt: '基準',
        outputLanguage: 'ja',
        rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
        screenFn: async () => { calls++; throw makeError(); },
        sleepFn: async () => {},
        random: () => 0,
    });
    return { calls, fallbackCount: result.fallbackCount };
}

for (const [label, model] of MODELS) {
    test(`${label}: retryable: false のエラーは1回で止まりフォールバックになる`, async () => {
        const r = await run(model, () => Object.assign(new Error('API error 401'), { retryable: false }));
        assert.deepEqual(r, { calls: 1, fallbackCount: 1 });
    });

    test(`${label}: retryable: true と印なしのエラーは3回送る`, async () => {
        const marked = await run(model, () => Object.assign(new Error('temporary'), { retryable: true }));
        assert.deepEqual(marked, { calls: 3, fallbackCount: 1 });
        const plain = await run(model, () => new Error('temporary'));
        assert.deepEqual(plain, { calls: 3, fallbackCount: 1 });
    });

    test(`${label}: status 429 のエラーは6回送る`, async () => {
        const r = await run(model, () => Object.assign(new Error('rate limited'), { status: 429 }));
        assert.deepEqual(r, { calls: 6, fallbackCount: 1 });
    });
}

// API キー未設定: screenFn を注入しない既定の経路で、通信せず待たずに1回で止まる。
for (const [label, model] of [
    ['OpenAI', 'gpt-5.6-luna'],
    ['OpenRouter', 'qwen/qwen3-235b-a22b-2507'],
    ['OpenRouter Jev', '~typesafe/jev-latest'],
    ['Anthropic', 'claude-haiku-5-5'],
    ['TypeSafe', 'jev-1.14.0'],
] as const) {
    test(`${label}: API キー未設定のまま一括判定すると、通信も待ちも無く1件フォールバックになる`, async () => {
        const originalFetch = globalThis.fetch;
        let fetchCalls = 0;
        const waits: number[] = [];
        globalThis.fetch = (async () => { fetchCalls++; return new Response('{}'); }) as typeof fetch;
        try {
            const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
                batchSize: 1, model, screeningPrompt: '基準', outputLanguage: 'ja',
                rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
                sleepFn: async ms => { waits.push(ms); },
                random: () => 0,
            });
            assert.equal(result.fallbackCount, 1);
        } finally {
            globalThis.fetch = originalFetch;
        }
        assert.equal(fetchCalls, 0);
        assert.deepEqual(waits.filter(ms => ms > 0), []);
    });
}
