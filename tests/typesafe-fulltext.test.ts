// 偽の通信で全文要求、二値判定、再試行と機密情報の保護を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTypeSafeFulltextRequest,
    buildTypeSafeFulltextPromptRecord,
    parseTypeSafeFulltextResponse,
    judgeFulltextViaTypeSafe,
    TypeSafeInputTooLongError,
} from '../src/lib/typesafe-fulltext';
import { setSessionTypeSafeApiKey, clearSessionTypeSafeApiKey } from '../src/lib/storage';
import { classifyFulltextAiFailure } from '../src/lib/fulltext-ai-failures';

const params = {
    model: 'jev-1.14.0', title: '文献', fullText: '本文', screeningPrompt: '基準', outputLanguage: 'ja',
    reasonItems: [
        { key: 'other', label: '対象外', labelEn: 'Ineligible population' },
        { key: 'fallback', label: 'その他', labelEn: '' },
    ],
};
const payload = {
    model: 'response-model', id: 'response-id',
    answers: { include: { noul: 0.29 }, exclude_reason: {
        choice: 'other', probabilities: { other: 0.8, fallback: 0.2, invalid: 'bad', infinite: Infinity },
    } },
    usage: { input_tokens: 511, output_tokens: 57, cost: 0.01 },
};

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    setSessionTypeSafeApiKey('test-typesafe-key');
    try {
        await run();
    } finally {
        globalThis.fetch = original;
        clearSessionTypeSafeApiKey();
    }
}

test('要求の送信先・認証・全文と、理由の優先順・末尾フォールバックを送る', async () => {
    await withFetch(async (url, init) => {
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(init?.headers, { Authorization: 'Bearer test-typesafe-key', 'Content-Type': 'application/json' });
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, params.model);
        assert.deepEqual(body.state, { title: '文献', full_text: '本文' });
        assert.equal(body.questions.include.type, 'noul');
        assert.equal(body.questions.include.instructions.screening_prompt, '基準');
        assert.equal(body.questions.include.instructions.question,
            'Based on `screening_prompt`, should this record be included at the full-text screening stage?');
        const reason = body.questions.exclude_reason;
        assert.equal(reason.type, 'choice');
        assert.deepEqual(reason.criteria, { other: 'Ineligible population', fallback: 'その他' });
        assert.match(reason.instructions.question, /priority order/);
        assert.match(reason.instructions.question, /choose the one listed first/);
        assert.match(reason.instructions.question, /choose "fallback"/);
        assert.match(reason.instructions.question, /1\. other \(Ineligible population\)\n2\. fallback \(その他\)/);
        assert.equal(reason.instructions.screening_prompt, '基準');
        assert.equal('choices' in reason, false);
        assert.ok(init?.signal);
        const record = buildTypeSafeFulltextPromptRecord(params.screeningPrompt, params.reasonItems);
        assert.equal(record, [params.screeningPrompt, body.questions.include.instructions.question, reason.instructions.question].join('\n\n'));
        return Response.json(payload);
    }, async () => {
        assert.equal((await judgeFulltextViaTypeSafe(params)).output.decision, 'exclude');
    });
});

test('理由が不足する場合と不正なキーを除いた場合は choice を送らない', () => {
    for (const reasonItems of [[], params.reasonItems.slice(0, 1), [params.reasonItems[0],
        { key: ' spaced ', label: '空白', labelEn: '' },
        { key: 'x'.repeat(129), label: '長い', labelEn: '' },
        { key: '', label: '空', labelEn: '' }]]) {
        const body = buildTypeSafeFulltextRequest({ ...params, title: '', reasonItems });
        assert.deepEqual(Object.keys(body.questions), ['include']);
        assert.equal(body.state.title, '(no title)');
    }
    const valid = { key: 'x'.repeat(128), label: '有効', labelEn: '' };
    const body = buildTypeSafeFulltextRequest({ ...params, reasonItems: [...params.reasonItems, valid] });
    assert.equal(body.questions.exclude_reason.criteria?.[valid.key], '有効');
});

test('閾値ちょうどは組入、閾値未満は除外し、機械的な理由と確率だけを返す', () => {
    for (const [noul, decision, probability] of [[0.3, 'include', 0.3], [0.29, 'exclude', 0.29], [2, 'include', 1], [-1, 'exclude', 0]] as const) {
        const result = parseTypeSafeFulltextResponse({ ...payload, answers: {
            ...payload.answers, include: { noul },
        } }, params);
        assert.equal(result.output.decision, decision);
        assert.equal(result.output.include_probability, probability);
        assert.equal('exclude_reason_category' in result.output, decision === 'exclude');
        assert.equal(result.output.reason, `組入の確率 ${probability.toFixed(2)}（閾値 0.3）`);
        assert.deepEqual(result.output.evidence, []);
        assert.deepEqual(result.reasonProbabilities, { other: 0.8, fallback: 0.2 });
        assert.deepEqual(result.usageMetadata, {
            promptTokenCount: 511, candidatesTokenCount: 57, thoughtsTokenCount: 0, totalTokenCount: 568, costUsd: 0.01,
        });
        assert.deepEqual(result.responseMetadata, { modelVersion: 'response-model', responseId: 'response-id' });
    }
});

test('欠損した使用量とモデル名を補い、英語の理由と生の除外区分を保持する', () => {
    const result = parseTypeSafeFulltextResponse({ answers: {
        include: { noul: 0.12 }, exclude_reason: { choice: 'unknown' },
    } }, { ...params, outputLanguage: 'en' });
    assert.equal(result.output.reason, 'Inclusion probability 0.12 (threshold 0.3)');
    assert.equal(result.output.exclude_reason_category, 'unknown');
    assert.deepEqual(result.responseMetadata, { modelVersion: params.model });
    assert.deepEqual(result.usageMetadata, { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0 });
    assert.equal(result.reasonProbabilities, undefined);
    for (const noul of [undefined, '0.3', Infinity, NaN]) {
        assert.throws(() => parseTypeSafeFulltextResponse({ answers: { include: { noul } } }, params));
    }
});

test('入力上限超過と恒久的エラーは一度で止まり、キーを伏せる', async () => {
    for (const [status, message] of [[400, 'max_tokens_exceeded'], [401, 'auth'], [402, 'billing'],
        [403, 'forbidden'], [400, 'Unknown model']] as const) {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return new Response(`${message} test-typesafe-key`, { status });
        }, async () => {
            await assert.rejects(judgeFulltextViaTypeSafe(params, { sleep: async () => assert.fail('再試行不可') }), err => {
                assert.ok(err instanceof Error);
                assert.equal(err.message.includes('test-typesafe-key'), false);
                assert.match(err.message, /\[REDACTED\]/);
                if (message === 'max_tokens_exceeded') {
                    assert.ok(err instanceof TypeSafeInputTooLongError);
                    assert.equal(classifyFulltextAiFailure(err), 'llm');
                } else {
                    assert.equal((err as Error & { retryable?: boolean }).retryable, false);
                }
                return true;
            });
            assert.equal(calls, 1);
        });
    }
});

test('500 の後は 2000 ミリ秒待機して成功する', async () => {
    let calls = 0;
    const waits: number[] = [];
    await withFetch(async () => ++calls === 1 ? new Response('temporary', { status: 500 }) : Response.json(payload), async () => {
        const result = await judgeFulltextViaTypeSafe(params, { sleep: async ms => { waits.push(ms); } });
        assert.equal(result.output.decision, 'exclude');
        assert.equal(calls, 2);
        assert.deepEqual(waits, [2000]);
    });
});

test('503 が続けば最後の失敗を返す', async () => {
    let calls = 0;
    const waits: number[] = [];
    await withFetch(async () => new Response(`temporary-${++calls}`, { status: 503 }), async () => {
        await assert.rejects(judgeFulltextViaTypeSafe(params, { sleep: async ms => { waits.push(ms); } }), /temporary-3/);
        assert.equal(calls, 3);
        assert.deepEqual(waits, [2000, 4000]);
    });
});

test('一時的な400・429・ネットワーク例外・不正 JSON・不正確率は再試行できる', async () => {
    const failures: Array<() => Promise<Response>> = [
        async () => new Response('busy', { status: 400 }),
        async () => new Response('busy', { status: 429 }),
        async () => { throw new Error('network test-typesafe-key'); },
        async () => new Response('{'),
        async () => Response.json({ answers: { include: { noul: 'invalid' } } }),
    ];
    for (const failure of failures) {
        let calls = 0;
        await withFetch(async () => ++calls === 1 ? failure() : Response.json(payload), async () => {
            await judgeFulltextViaTypeSafe(params, { sleep: async () => {} });
            assert.equal(calls, 2);
        });
    }
});

test('タイムアウトの要求を中止して再試行する', async () => {
    let calls = 0;
    await withFetch(async (_url, init) => {
        calls++;
        if (calls > 1) {
            return Response.json(payload);
        }
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
        });
    }, async () => {
        await judgeFulltextViaTypeSafe(params, { timeoutMs: 1, sleep: async () => {} });
        assert.equal(calls, 2);
    });
});

test('ネットワーク例外に含まれるキーも伝播前に伏せる', async () => {
    await withFetch(async () => { throw new Error('network test-typesafe-key'); }, async () => {
        await assert.rejects(judgeFulltextViaTypeSafe(params, { maxAttempts: 1 }), err => {
            assert.ok(err instanceof Error);
            assert.equal(err.message, 'network [REDACTED]');
            return true;
        });
    });
});
