import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS } from '../src/lib/gemini-api';
import { resolveProviderId, screenWithProvider, convertCriteriaWithProvider } from '../src/lib/llm-provider';
import type { LlmScreenParams } from '../src/lib/llm-provider';
import { buildTypeSafeScreeningRequest, parseTypeSafeScreeningResponse, screenViaTypeSafe, testTypeSafeApiKey } from '../src/lib/providers/typesafe';
import { setSessionTypeSafeApiKey, clearSessionTypeSafeApiKey } from '../src/lib/storage';
import { processBatch, parseLlmDecisionNote } from '../src/lib/llm-processor';

const params: LlmScreenParams = {
    title: '対象文献', abstract: '抄録', screeningPrompt: '判定基準', model: 'jev-1.13.0', outputLanguage: 'ja',
    criteria: { template: 'pico', fields: { P: '成人', I: '介入A', C: '', O: '死亡' } },
};
const payload = {
    model: 'jev-response-version',
    answers: {
        include: { type: 'noul', noul: 0.98 },
        criterion_0: { type: 'noul', noul: 0.96 },
        criterion_1: { type: 'noul', noul: 0.945 },
        criterion_2: { type: 'noul', noul: 0.8 },
    },
    usage: { input_tokens: 1891, output_tokens: 88 },
};

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    setSessionTypeSafeApiKey('test-typesafe-key');
    try { await run(); } finally {
        globalThis.fetch = original;
        clearSessionTypeSafeApiKey();
    }
}

test('固定版 Jev の所属は実際のモデル一覧から TypeSafe と解決される', () => {
    assert.equal(resolveProviderId(params.model, AVAILABLE_MODELS), 'typesafe');
});

test('TypeSafe の送信先・認証・質問と応答の保存形式が一致する', async () => {
    let calls = 0;
    await withFetch(async (url, init) => {
        calls++;
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(init?.headers, { Authorization: 'Bearer test-typesafe-key', 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(String(init?.body)), {
            model: params.model, state: { title: params.title, abstract: params.abstract },
            questions: {
                include: { type: 'noul', instructions: { screening_prompt: params.screeningPrompt, question: 'Based on `screening_prompt`, should this record be included at the title/abstract screening stage?' } },
                ...Object.fromEntries([['P', '成人'], ['I', '介入A'], ['O', '死亡']].map(([key, description], index) => [
                    `criterion_${index}`, { type: 'noul', instructions: { criterion: { key, description }, question: 'Does this record meet `criterion`, or is it impossible to rule it out from the title and abstract alone?' } },
                ])),
            },
        });
        return Response.json(payload);
    }, async () => {
        const result = await screenWithProvider('typesafe', params);
        assert.deepEqual(result, {
            output: { include_probability: 0.98, reasons: ['基準の要素ごとの合致確率: P 0.96 / I 0.94 / O 0.80'], evidence: [] },
            usageMetadata: { promptTokenCount: 1891, candidatesTokenCount: 88, thoughtsTokenCount: 0, totalTokenCount: 1979 },
            responseMetadata: { modelVersion: payload.model },
        });
        assert.equal(calls, 1);
    });
});

test('英語の接頭辞と欠損した要素別確率の除外', () => {
    const result = parseTypeSafeScreeningResponse({ answers: {
        include: { noul: 0.5 }, criterion_0: { noul: 0.1 }, criterion_2: { noul: 0.95 }, criterion_3: { noul: '0.8' }, criterion_4: { noul: Infinity },
    } }, { ...params, outputLanguage: 'en' }, ['P', 'I', 'C', 'O', 'S']);
    assert.deepEqual(result.output.reasons, ['Per-criterion match probability: P 0.10 / C 0.95']);
    assert.deepEqual(result.usageMetadata, { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 });
    assert.deepEqual(result.responseMetadata, { modelVersion: params.model });
});

test('基準なし・空の基準では総合質問だけを送り、理由は空になる', () => {
    for (const criteria of [undefined, null, { template: 'pico' as const, fields: { P: '  ' } }]) {
        const request = buildTypeSafeScreeningRequest({ ...params, criteria, abstract: '' });
        assert.deepEqual(Object.keys(request.body.questions), ['include']);
        assert.equal(request.body.state.abstract, '(no abstract)');
        assert.deepEqual(request.criterionKeys, []);
        assert.deepEqual(parseTypeSafeScreeningResponse(payload, params, []).output.reasons, []);
    }
});

test('基準値を trim し文字列以外は質問から除外する', () => {
    const request = buildTypeSafeScreeningRequest({ ...params, criteria: {
        template: 'custom', fields: { 対象: ' 成人 ', 空欄: ' ', 不正: null as unknown as string, 介入: '薬剤' },
    } });
    assert.deepEqual(request.criterionKeys, ['対象', '介入']);
    assert.deepEqual(request.body.questions.criterion_0.instructions.criterion, { key: '対象', description: '成人' });
});

test('総合確率の欠損・型違い・非有限値はリトライ可能なエラーになる', async () => {
    for (const noul of [undefined, null, '0.5', NaN, Infinity]) {
        assert.throws(() => parseTypeSafeScreeningResponse({ answers: { include: { noul } } }, params, []),
            (error: Error & { retryable?: boolean }) => error.retryable !== false);
    }
    await withFetch(async () => Response.json({ answers: {} }), async () => {
        await assert.rejects(screenViaTypeSafe(params), (error: Error & { retryable?: boolean }) => error.retryable !== false);
    });
});

test('総合確率だけを 0〜1 にクランプする', () => {
    for (const [noul, expected] of [[1.5, 1], [-0.2, 0]]) {
        assert.equal(parseTypeSafeScreeningResponse({ answers: { include: { noul } } }, params, []).output.include_probability, expected);
    }
});

test('使用量が数値以外・非有限値の場合は 0 として扱う', () => {
    for (const usage of [
        { input_tokens: '12', output_tokens: null },
        { input_tokens: NaN, output_tokens: Infinity },
    ]) {
        const result = parseTypeSafeScreeningResponse({ ...payload, usage }, params, []);
        assert.deepEqual(result.usageMetadata, { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 });
    }
});

for (const { status, message, nonRetryable } of [
    { status: 429, message: 'Too Many Requests', nonRetryable: false },
    { status: 529, message: 'Overloaded', nonRetryable: false },
    { status: 401, message: 'Unauthorized', nonRetryable: true },
    { status: 403, message: 'Forbidden', nonRetryable: true },
    { status: 400, message: `Unknown model: ${params.model}`, nonRetryable: true },
    { status: 400, message: 'Bad Request', nonRetryable: false },
    { status: 422, message: 'Unprocessable Entity', nonRetryable: false },
]) {
    test(`HTTP ${status} (${message}) を分類し、プロバイダ内部では再試行しない`, async () => {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return Response.json({ detail: { message } }, { status });
        }, async () => {
            await assert.rejects(screenViaTypeSafe(params), (error: Error & { retryable?: boolean }) => {
                assert.ok(error.message.includes(`API error ${status}`));
                assert.equal(error.retryable === false, nonRetryable);
                if (status === 400 && nonRetryable) assert.ok(error.message.includes(`モデル ${params.model} が見つかりません`));
                return true;
            });
            assert.equal(calls, 1);
        });
    });
}

test('壊れた JSON とタイムアウトはリトライ可能なエラーになる', async () => {
    await withFetch(async () => new Response('invalid json'), async () => {
        await assert.rejects(screenViaTypeSafe(params), (error: Error & { retryable?: boolean }) => error.retryable !== false);
    });
    await withFetch(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('タイムアウト')), { once: true });
    }), async () => {
        await assert.rejects(screenViaTypeSafe(params, 1), /タイムアウト/);
    });
});

test('基準の最適化は fetch を呼ばずに拒否する', async () => {
    await withFetch(async () => { assert.fail('通信してはいけない'); }, async () => {
        await assert.rejects(convertCriteriaWithProvider('typesafe', { model: params.model, protocolText: '基準', outputLanguage: 'ja' }),
            (error: Error & { retryable?: boolean }) => error.retryable === false && error.message.includes('基準の最適化に対応していません'));
    });
});

test('キー検証はモデル一覧の GET の成功可否を返す', async () => {
    for (const status of [200, 401]) {
        await withFetch(async (url, init) => {
            assert.equal(url, 'https://api.typesafe.ai/v1/models');
            assert.equal(init?.method, 'GET');
            assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-typesafe-key');
            return Response.json({}, { status });
        }, async () => { assert.equal((await testTypeSafeApiKey('test-typesafe-key')).isValid, status === 200); });
    }
});

test('キーの不可視文字を除去し、範囲外文字は通信前に拒否する', async () => {
    await withFetch(async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-typesafe-key');
        return Response.json(payload);
    }, async () => {
        setSessionTypeSafeApiKey(' test-\u200Btypesafe-key\uFEFF ');
        await screenViaTypeSafe(params);
        setSessionTypeSafeApiKey('キー');
        await assert.rejects(screenViaTypeSafe(params), /TypeSafe APIキーに ISO-8859-1/);
    });
});

test('バッチから同じ criteria を渡し、確率・要素別理由・モデル版を note に保存する', async () => {
    let calls = 0;
    const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
        batchSize: 1, ...params,
        rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
        sleepFn: async () => {}, random: () => 0,
        screenFn: async (provider, received) => {
            calls++;
            assert.equal(provider, 'typesafe');
            assert.equal(received.criteria, params.criteria);
            return parseTypeSafeScreeningResponse(payload, received, ['P', 'I', 'O']);
        },
    });
    assert.equal(calls, 1);
    assert.equal(result.successCount, 1);
    const note = parseLlmDecisionNote(result.decisions[0].note ?? '');
    assert.equal(note?.include_probability, 0.98);
    assert.equal(note?.model_version, payload.model);
    assert.deepEqual(note?.evidence, []);
    assert.equal(note?.reasons.length, 1);
});

test('TypeSafe の再試行不可エラーではバッチのバックオフを行わない', async () => {
    let calls = 0;
    const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
        batchSize: 1, ...params,
        rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
        screenFn: async () => { calls++; throw Object.assign(new Error('TypeSafe API error 401'), { retryable: false }); },
        sleepFn: async (ms) => { assert.equal(ms, 0); }, random: () => 0,
    });
    assert.equal(calls, 1);
    assert.equal(result.fallbackCount, 1);
});

for (const status of [429, 529]) {
    test(`HTTP ${status} はバッチ側で待機・再試行して成功する`, async () => {
        let calls = 0;
        let now = 0;
        let rateLimitHits = 0;
        const waits: number[] = [];
        await withFetch(async () => ++calls === 1
            ? new Response('一時的なエラー', { status }) : Response.json(payload), async () => {
            const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
                batchSize: 1, ...params,
                rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
                screenFn: screenWithProvider,
                now: () => now, random: () => 0,
                sleepFn: async (ms) => { waits.push(ms); now += ms; },
                onProgress: (progress) => { rateLimitHits = progress.rateLimitHits ?? 0; },
            });
            assert.equal(calls, 2);
            assert.equal(result.successCount, 1);
            assert.equal(result.fallbackCount, 0);
            assert.ok(waits.some(ms => ms > 0));
            assert.equal(rateLimitHits, status === 429 ? 1 : 0);
        });
    });
}
