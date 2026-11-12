// 全文 Decisions の要求と閾値、恒久的な失敗の打ち切りを偽の通信で検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    buildGeminiDecisionFulltextRequest, buildGeminiDecisionFulltextPromptRecord,
    parseGeminiDecisionFulltextResponse, judgeFulltextViaGeminiDecision, GeminiDecisionInputTooLongError,
    GEMINI_DECISION_FULLTEXT_INCLUDE_THRESHOLD as threshold,
} from '../src/lib/gemini-decision-fulltext';
import { DEFAULT_EXCLUDE_REASON_ITEMS } from '../src/lib/exclude-reasons';
import { setSessionApiKey, clearSessionApiKey } from '../src/lib/storage';
import { PdfTooLargeError, LlmCallError, classifyFulltextAiFailure } from '../src/lib/fulltext-ai-failures';

const config = JSON.parse(readFileSync('experiments/gemini-decision-1/fulltext/config.json', 'utf8'));
const params = {
    model: 'gemini-decision-1', title: '文献', screeningPrompt: '基準', outputLanguage: 'ja',
    reasonItems: DEFAULT_EXCLUDE_REASON_ITEMS, bytes: new Uint8Array([1, 2, 3]),
};
const payload = {
    answers: { include: { noul: 0.2 }, exclude_reason: {
        choice: 'population', probabilities: { population: 0.8, other: 0.2, bad: 'invalid', infinite: Infinity },
    } },
    usage: { total_input_tokens: 511 },
};

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    setSessionApiKey('test-gemini-key');
    try {
        await run();
    } finally {
        globalThis.fetch = original;
        clearSessionApiKey();
    }
}

test('実験と要求本文、問い、既定の理由と JSON のキー順が一致する', () => {
    const expected = {
        model: config.model,
        input: [{ type: 'text', text: `Title: ${params.title}\n` },
            { type: 'document', data: 'AQID', mime_type: 'application/pdf' }],
        questions: {
            include: { type: 'noul', instructions: `${params.screeningPrompt}\n\n${config.includeQuestion}` },
            exclude_reason: { type: 'choice', instructions: `${params.screeningPrompt}\n\n${config.reasonQuestion}`,
                criteria: config.reasonCriteria },
        },
    };
    const body = buildGeminiDecisionFulltextRequest(params, 'AQID');
    assert.deepEqual(body, expected);
    assert.equal(JSON.stringify(body), JSON.stringify(expected));
    assert.equal(buildGeminiDecisionFulltextPromptRecord(params.screeningPrompt, params.reasonItems),
        JSON.stringify(buildGeminiDecisionFulltextRequest({ ...params, title: '{{TITLE}}' }, '{{PDF_BASE64}}')));
});

test('有効なキーが2件未満なら除外理由を送らず、英語の前後空白を除く', () => {
    for (const reasonItems of [[], params.reasonItems.slice(0, 1), [params.reasonItems[0],
        { key: '', label: '空', labelEn: '' }, { key: ' spaced ', label: '空白', labelEn: '' },
        { key: 'x'.repeat(129), label: '長い', labelEn: '' }]]) {
        assert.deepEqual(Object.keys(buildGeminiDecisionFulltextRequest({ ...params, reasonItems }, '').questions), ['include']);
    }
    const reasonItems = [{ key: 'x'.repeat(128), label: '日本語', labelEn: ' ' },
        { key: 'other', label: 'その他', labelEn: ' Other ' }];
    assert.deepEqual(buildGeminiDecisionFulltextRequest({ ...params, reasonItems }, '').questions.exclude_reason.criteria,
        { ['x'.repeat(128)]: '日本語', other: 'Other' });
});

test('閾値ちょうどは組入、直下は除外、確率の範囲と理由・使用量を整える', () => {
    for (const [noul, decision, probability] of [[threshold, 'include', threshold],
        [threshold - Number.EPSILON, 'exclude', threshold - Number.EPSILON], [2, 'include', 1], [-1, 'exclude', 0]] as const) {
        const result = parseGeminiDecisionFulltextResponse({ ...payload, answers: { ...payload.answers, include: { noul } } }, params);
        assert.equal(result.output.decision, decision);
        assert.equal(result.output.include_probability, probability);
        assert.equal('exclude_reason_category' in result.output, decision === 'exclude');
        assert.equal(result.output.reason, `組入の確率 ${probability.toFixed(2)}（閾値 0.2305）`);
        assert.deepEqual(result.output.evidence, []);
        assert.deepEqual(result.reasonProbabilities, { population: 0.8, other: 0.2 });
        assert.deepEqual(result.usageMetadata, { promptTokenCount: 511, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 511 });
        assert.deepEqual(result.responseMetadata, { modelVersion: params.model });
    }
    assert.equal(parseGeminiDecisionFulltextResponse(payload, { ...params, outputLanguage: 'en' }).output.reason,
        'Inclusion probability 0.20 (threshold 0.2305)');
    for (const noul of [undefined, '0.3', Infinity, NaN]) {
        assert.throws(() => parseGeminiDecisionFulltextResponse({ answers: { include: { noul } } }, params));
    }
});

test('送信先・ヘッダと PDF の base64 が一致し、大きな配列も変換できる', async () => {
    const bytes = new Uint8Array(100000).fill(123);
    await withFetch(async (url, init) => {
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(init?.headers, { 'x-goog-api-key': 'test-gemini-key', 'Content-Type': 'application/json' });
        assert.equal(init?.body, JSON.stringify(buildGeminiDecisionFulltextRequest(params, Buffer.from(bytes).toString('base64'))));
        assert.ok(init?.signal);
        return Response.json(payload);
    }, async () => {
        await judgeFulltextViaGeminiDecision({ ...params, bytes });
    });
});

test('入力上限超過と誤ったキーの400は1回で止め、キーを伏せる', async () => {
    for (const tooLong of [true, false]) {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return Response.json({ error: { code: 'invalid_request', message: tooLong
                ? 'The input token count exceeds the maximum number of tokens allowed 262144. test-gemini-key'
                : 'API key not valid test-gemini-key' } }, { status: 400 });
        }, async () => {
            await assert.rejects(judgeFulltextViaGeminiDecision(params, { sleep: async () => assert.fail('再試行不可') }), err => {
                assert.ok(err instanceof Error);
                assert.equal(err.message.includes('test-gemini-key'), false);
                assert.match(err.message, /\[REDACTED\]/);
                if (tooLong) {
                    assert.ok(err instanceof GeminiDecisionInputTooLongError);
                    // 画面側（ai-gemini-decision.ts）が LlmCallError に包むので、その形で 'llm' になることを見る。
                    assert.equal(classifyFulltextAiFailure(new LlmCallError(err, '上限超え')), 'llm');
                }
                return true;
            });
            assert.equal(calls, 1);
        });
    }
});

test('429 と503を再試行し、RetryInfo の待ちを最大60秒に抑える', async () => {
    let calls = 0;
    const waits: number[] = [];
    await withFetch(async () => {
        calls++;
        if (calls === 1) {
            return Response.json({ error: { message: 'busy', details: [
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' },
            ] } }, { status: 429 });
        }
        return calls === 2 ? new Response('busy', { status: 503 }) : Response.json(payload);
    }, async () => {
        await judgeFulltextViaGeminiDecision(params, { sleep: async ms => { waits.push(ms); } });
        assert.equal(calls, 3);
        assert.deepEqual(waits, [60000, 4000]);
    });
});

test('通信例外とタイムアウトを再試行し、既定の3回で止める', async () => {
    let calls = 0;
    const waits: number[] = [];
    await withFetch(async () => {
        calls++;
        throw new Error('network test-gemini-key');
    }, async () => {
        await assert.rejects(judgeFulltextViaGeminiDecision(params, { sleep: async ms => { waits.push(ms); } }), /network \[REDACTED\]/);
        assert.equal(calls, 3);
        assert.deepEqual(waits, [2000, 4000]);
    });
    calls = 0;
    await withFetch(async (_url, init) => {
        if (++calls > 1) {
            return Response.json(payload);
        }
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
    }, async () => {
        await judgeFulltextViaGeminiDecision(params, { timeoutMs: 5, sleep: async () => {} });
        assert.equal(calls, 2);
    });
});

test('50 MB を超えた PDF は fetch を呼ばず PDF の失敗に分類する', async () => {
    assert.equal(config.maxPdfBytes, 50_000_000);
    await withFetch(async () => assert.fail('送信不可'), async () => {
        await assert.rejects(judgeFulltextViaGeminiDecision({ ...params, bytes: new Uint8Array(config.maxPdfBytes + 1) }), err => {
            assert.ok(err instanceof PdfTooLargeError);
            assert.equal(classifyFulltextAiFailure(err), 'pdf');
            return true;
        });
    });
});
