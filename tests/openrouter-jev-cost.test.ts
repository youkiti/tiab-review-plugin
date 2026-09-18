import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS } from '../src/lib/gemini-api';
import { isOpenRouterJevModel, resolveProviderId, screenWithProvider, convertCriteriaWithProvider } from '../src/lib/llm-provider';
import type { LlmScreenParams } from '../src/lib/llm-provider';
import { buildTypeSafeScreeningRequest, parseTypeSafeScreeningResponse } from '../src/lib/providers/typesafe';
import { setSessionOpenRouterApiKey, clearSessionOpenRouterApiKey } from '../src/lib/storage';
import { processBatch, parseLlmDecisionNote, formatBatchCostUsd } from '../src/lib/llm-processor';

const params: LlmScreenParams = {
    title: '対象文献', abstract: '抄録', screeningPrompt: '判定基準', model: 'typesafe/jev-1.13', outputLanguage: 'ja',
    criteria: { template: 'pico', fields: { P: '成人' } },
};
// 実測応答を固定フィクスチャとして使い、外部 API には通信しない。
const payload = {"model":"typesafe/jev-1.13-20260917","answers":{"include":{"type":"noul","noul":0.97},"criterion_0":{"type":"noul","noul":0.96}},"usage":{"input_tokens":437,"output_tokens":40,"cost":0.000018354},"id":"gen-dec-1789717440-DhWcMi0fCk4Iv5f1vJVz","provider":"TypeSafe"};

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    setSessionOpenRouterApiKey('test-openrouter-key');
    try { await run(); } finally {
        globalThis.fetch = original;
        clearSessionOpenRouterApiKey();
    }
}

test('OpenRouter の固定版・カスタム Jev を判別し、モデル一覧の所属と順序を維持する', () => {
    for (const model of ['typesafe/jev-1.13', '~typesafe/jev-latest']) assert.equal(isOpenRouterJevModel(model), true);
    for (const model of ['qwen/qwen3-235b-a22b-2507', 'jev-1.13.0']) assert.equal(isOpenRouterJevModel(model), false);
    assert.equal(resolveProviderId(params.model, AVAILABLE_MODELS), 'openrouter');
    const directIndex = AVAILABLE_MODELS.findIndex(m => m.id === 'jev-1.13.0');
    assert.equal(AVAILABLE_MODELS[directIndex + 1].id, params.model);
});

for (const model of ['typesafe/jev-1.13', '~typesafe/jev-latest']) {
    test(`${model} は Decisions へ直 API と同じ質問形式で送る`, async () => {
        let calls = 0;
        await withFetch(async (url, init) => {
            calls++;
            assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
            assert.equal(init?.method, 'POST');
            assert.deepEqual(init?.headers, { Authorization: 'Bearer test-openrouter-key', 'Content-Type': 'application/json' });
            const body = JSON.parse(String(init?.body));
            const direct = buildTypeSafeScreeningRequest({ ...params, model: 'jev-1.13.0' }).body;
            assert.deepEqual(body, { ...direct, model });
            return Response.json(payload);
        }, async () => {
            const result = await screenWithProvider('openrouter', { ...params, model });
            assert.equal(result.output.include_probability, 0.97);
            assert.equal(result.usageMetadata.costUsd, 0.000018354);
            assert.equal(result.responseMetadata.responseId, payload.id);
            assert.equal(result.responseMetadata.modelVersion, payload.model);
            assert.equal(calls, 1);
        });
    });
}

test('Decisions のコストは有限の非負数だけを保存し、未対応応答ではキーを付けない', () => {
    for (const cost of [undefined, null, '0.1', -1, NaN, Infinity]) {
        const result = parseTypeSafeScreeningResponse({ ...payload, usage: { ...payload.usage, cost } }, params, ['P']);
        assert.equal(Object.prototype.hasOwnProperty.call(result.usageMetadata, 'costUsd'), false);
    }
    for (const cost of [0, 0.000018354]) {
        const result = parseTypeSafeScreeningResponse({ ...payload, usage: { ...payload.usage, cost } }, params, ['P']);
        assert.equal(result.usageMetadata.costUsd, cost);
    }
    const direct = parseTypeSafeScreeningResponse({ answers: payload.answers, usage: { input_tokens: 437, output_tokens: 40 } }, params, ['P']);
    assert.equal(Object.prototype.hasOwnProperty.call(direct.usageMetadata, 'costUsd'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(direct.responseMetadata, 'responseId'), false);
});

for (const [status, message, nonRetryable] of [
    [400, 'Model typesafe/jev-1.12 does not exist', true],
    [401, 'Missing Authentication header', true],
    [402, 'Insufficient credits', true],
    [403, 'Forbidden', true],
    [400, 'Bad Request', false],
    [429, 'Too Many Requests', false],
    [500, 'Internal Server Error', false],
] as const) {
    test(`Decisions HTTP ${status} (${message}) の再試行可否とキー秘匿`, async () => {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return Response.json({ error: { message: `${message} test-openrouter-key`, code: status } }, { status });
        }, async () => {
            await assert.rejects(screenWithProvider('openrouter', params), (error: Error & { retryable?: boolean }) => {
                assert.ok(error.message.startsWith(`OpenRouter Decisions API error ${status}:`));
                assert.equal(error.retryable === false, nonRetryable);
                assert.ok(error.message.includes('[REDACTED]'));
                assert.ok(!error.message.includes('test-openrouter-key'));
                if (status === 400 && nonRetryable) assert.ok(error.message.includes('提供終了の可能性があります。拡張機能の更新が必要です'));
                return true;
            });
            assert.equal(calls, 1);
        });
    });
}

test('OpenRouter Jev の基準最適化は通信前に拒否する', async () => {
    await withFetch(async () => { assert.fail('通信してはいけない'); }, async () => {
        for (const model of [params.model, '~typesafe/jev-latest']) {
            await assert.rejects(convertCriteriaWithProvider('openrouter', { model, protocolText: '基準', outputLanguage: 'ja' }),
                (error: Error & { retryable?: boolean }) => error.retryable === false && error.message.includes('基準の最適化に対応していません'));
        }
    });
});

test('OpenRouter Jev の再試行不可エラーは即フォールバックし、チャットモデルの再試行は維持する', async () => {
    for (const model of [params.model, '~typesafe/jev-latest', 'qwen/qwen3-235b-a22b-2507']) {
        let calls = 0;
        const waits: number[] = [];
        const result = await processBatch([{ ref_id: 'ref-1', title: params.title }], {
            batchSize: 1, ...params, model,
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            screenFn: async () => { calls++; throw Object.assign(new Error('API error 401'), { retryable: false }); },
            sleepFn: async ms => { waits.push(ms); }, random: () => 0,
        });
        assert.equal(calls, isOpenRouterJevModel(model) ? 1 : 3);
        assert.equal(waits.length, isOpenRouterJevModel(model) ? 0 : 2);
        assert.equal(result.fallbackCount, 1);
        assert.equal(result.totalCostUsd, undefined);
    }
});

test('成功判定のコストを合計して note に保存し、コスト無し・フォールバックは加算しない', async () => {
    const costs = [0.001, undefined, 0.002, 'fallback'] as const;
    const result = await processBatch(costs.map((_, i) => ({ ref_id: String(i), title: String(i) })), {
        batchSize: 2, ...params,
        rateLimitConfig: { concurrency: 2, delayBetweenRequests: 0 },
        screenFn: async (_provider, received) => {
            const cost = costs[Number(received.title)];
            if (cost === 'fallback') throw Object.assign(new Error('API error 402'), { retryable: false });
            return parseTypeSafeScreeningResponse({ ...payload, usage: { ...payload.usage, cost } }, received, ['P']);
        },
        sleepFn: async () => {}, random: () => 0,
    });
    assert.equal(result.totalCostUsd, 0.003);
    assert.equal(result.successCount, 3);
    assert.equal(result.fallbackCount, 1);
    const note = parseLlmDecisionNote(result.decisions.find(d => d.ref_id === '0')?.note ?? '');
    assert.equal(note?.usageMetadata?.costUsd, 0.001);
    assert.equal(note?.response_id, payload.id);
});

test('コストを持つ成功がなければ合計は undefined、無料の成功なら 0', async () => {
    for (const cost of [undefined, 0]) {
        const result = await processBatch([{ ref_id: 'ref-1', title: params.title }], {
            batchSize: 1, ...params,
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            screenFn: async () => parseTypeSafeScreeningResponse({ ...payload, usage: { ...payload.usage, cost } }, params, ['P']),
            sleepFn: async () => {},
        });
        assert.equal(result.totalCostUsd, cost);
    }
});

test('推定金額は 1 USD 以上なら小数2桁、未満なら有効数字2桁で整形する', () => {
    for (const [cost, expected] of [[0.001537, '0.0015'], [0.0605, '0.061'], [1, '1.00'], [12.345, '12.35'], [0, '0.0']] as const) {
        assert.equal(formatBatchCostUsd(cost), expected);
    }
});

test('OpenRouter チャットの usage.cost も有限の非負数だけを保存する', async () => {
    for (const cost of [0.03, 0, undefined, null, -1, '0.03', NaN, Infinity]) {
        await withFetch(async url => {
            assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
            return Response.json({
                choices: [{ message: { content: JSON.stringify({ include_probability: 0.5, reasons: [], evidence: [] }) } }],
                usage: { prompt_tokens: 123, completion_tokens: 45, cost },
            });
        }, async () => {
            const result = await screenWithProvider('openrouter', { ...params, model: 'qwen/qwen3-235b-a22b-2507' });
            const valid = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
            assert.equal(Object.prototype.hasOwnProperty.call(result.usageMetadata, 'costUsd'), valid);
            if (valid) assert.equal(result.usageMetadata.costUsd, cost);
        });
    }
});
