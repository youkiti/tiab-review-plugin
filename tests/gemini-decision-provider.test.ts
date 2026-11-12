// Gemini Decisions API の要求・履歴・失敗時の契約を外部通信なしで検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiDecisionScreeningRequest, parseGeminiDecisionScreeningResponse, screenViaGeminiDecision } from '../src/lib/providers/gemini-decision';
import { screenWithProvider, convertCriteriaWithProvider, resolveProviderId } from '../src/lib/llm-provider';
import type { LlmScreenParams } from '../src/lib/llm-provider';
import { setSessionApiKey, clearSessionApiKey } from '../src/lib/storage';
import { AVAILABLE_MODELS } from '../src/lib/gemini-api';
import { filterFulltextGeminiModels, isGeminiDecisionModel, newRunIncludeThreshold } from '../src/lib/gemini-decision-model';
import { getBatchProfile } from '../src/lib/types';
import { resolveModelPricing, estimateBatchCost, estimateOutputTokens } from '../src/lib/llm-pricing';
import { sentGenerationSettings, getModelGenerationSettings } from '../src/lib/model-generation-settings';
import { buildTiabPromptTemplate } from '../src/lib/llm-prompt-record';

const params: LlmScreenParams = {
    title: '対象文献', abstract: '抄録', screeningPrompt: '判定基準', model: 'gemini-decision-1', outputLanguage: 'ja',
    criteria: { template: 'pico', fields: { P: ' 成人 ', I: '介入', C: ' ', O: '死亡' } },
};
const payload = {
    answers: {
        include: { noul: 0.965, confidence: 0.1, type: 'noul' },
        criterion_0: { noul: 0.8 }, criterion_1: { noul: 0.9 }, criterion_2: { noul: 0.95 },
    },
    usage: { total_input_tokens: 589, total_output_tokens: 0, total_tokens: 589 },
};

async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    setSessionApiKey('test-gemini-decision-key');
    try {
        await run();
    } finally {
        globalThis.fetch = original;
        clearSessionApiKey();
    }
}

test('総合・要素別の問いを文字列で送り、空欄を飛ばして連番にする', () => {
    const { body, criterionKeys } = buildGeminiDecisionScreeningRequest({ ...params, abstract: '' });
    assert.equal(body.input, 'Title: 対象文献\n\nAbstract: (no abstract)');
    assert.equal(body.model, params.model);
    assert.deepEqual(criterionKeys, ['P', 'I', 'O']);
    assert.deepEqual(body.questions, {
        include: {
            type: 'noul',
            instructions: '判定基準\n\nShould this record be included at the title/abstract screening stage?',
        },
        ...Object.fromEntries([['P', '成人'], ['I', '介入'], ['O', '死亡']].map(([key, description], index) => [
            `criterion_${index}`, {
                type: 'noul',
                instructions: `${key}: ${description}\n\n`
                    + 'Does this record meet this criterion, or is it impossible to rule it out from the title and abstract alone?',
            },
        ])),
    });
    for (const question of Object.values(body.questions)) {
        assert.equal(typeof question.instructions, 'string');
    }
    const recorded = JSON.parse(buildTiabPromptTemplate(params.model, params.screeningPrompt, 'ja', params.criteria));
    assert.deepEqual(recorded, buildGeminiDecisionScreeningRequest({ ...params, title: '{{TITLE}}', abstract: '{{ABSTRACT}}' }).body);
});

test('基準なし・空の基準・文字列以外の値では総合だけを送る', () => {
    for (const criteria of [undefined, null, { template: 'pico' as const, fields: { P: ' ', I: null as unknown as string } }]) {
        const request = buildGeminiDecisionScreeningRequest({ ...params, criteria });
        assert.deepEqual(request.criterionKeys, []);
        assert.deepEqual(Object.keys(request.body.questions), ['include']);
    }
});

test('noul を採用し、理由を1文字列、入力トークンと要求モデルを履歴に残す', () => {
    const result = parseGeminiDecisionScreeningResponse(payload, params, ['P', 'I', 'O']);
    assert.deepEqual(result, {
        output: {
            include_probability: 0.965, reasons: ['基準の要素ごとの合致確率: P 0.80 / I 0.90 / O 0.95'], evidence: [],
        },
        usageMetadata: { promptTokenCount: 589, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 589 },
        responseMetadata: { modelVersion: params.model },
    });
    const english = parseGeminiDecisionScreeningResponse({ answers: {
        include: { noul: 0.5 }, criterion_0: { noul: 0.1 }, criterion_2: { noul: Infinity },
    } }, { ...params, outputLanguage: 'en' }, ['P', 'I', 'O']);
    assert.deepEqual(english.output.reasons, ['Per-criterion match probability: P 0.10']);
    assert.equal(english.usageMetadata.promptTokenCount, 0);
    assert.deepEqual(parseGeminiDecisionScreeningResponse(payload, params, []).output.reasons, []);
});

test('壊れた総合確率は再試行可能な例外になる', () => {
    for (const noul of [undefined, null, '0.5', NaN, Infinity]) {
        assert.throws(() => parseGeminiDecisionScreeningResponse({ answers: { include: { noul } } }, params, []),
            (error: Error & { retryable?: boolean }) => error.retryable !== false);
    }
});

test('Gemini 内のモデルとして Decisions エンドポイントに振り分け、キーはヘッダだけに置く', async () => {
    assert.equal(resolveProviderId(params.model, AVAILABLE_MODELS), 'gemini');
    let calls = 0;
    await withFetch(async (url, init) => {
        calls++;
        assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(init?.headers, { 'x-goog-api-key': 'test-gemini-decision-key', 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(String(init?.body)), buildGeminiDecisionScreeningRequest(params).body);
        return Response.json(payload);
    }, async () => {
        assert.equal((await screenWithProvider('gemini', params)).output.include_probability, 0.965);
    });
    assert.equal(calls, 1);
});

test('429・5xx だけ再試行対象で、ほかの 4xx は恒久エラー。キーは伏せる', async () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
        await withFetch(async () => Response.json({ error: { message: 'test-gemini-decision-key retry in 45s' } }, { status }), async () => {
            await assert.rejects(screenViaGeminiDecision(params), (error: Error & {
                status?: number; retryable?: boolean; retryAfterMs?: number;
            }) => {
                assert.equal(error.status, status);
                assert.equal(error.retryable === false, status !== 429 && status < 500);
                assert.equal(error.message.includes('test-gemini-decision-key'), false);
                assert.ok(error.message.includes('[REDACTED]'));
                if (status === 429) {
                    assert.equal(error.retryAfterMs, 45000);
                }
                return true;
            });
        });
    }
});

test('キー未設定と基準最適化を再試行せずに断る', async () => {
    const chromeOriginal = globalThis.chrome;
    globalThis.chrome = { storage: { local: { get: async () => ({}) } } } as unknown as typeof chrome;
    clearSessionApiKey();
    try {
        await assert.rejects(screenViaGeminiDecision(params), (error: Error & { retryable?: boolean }) => error.retryable === false);
        await assert.rejects(convertCriteriaWithProvider('gemini', { ...params, protocolText: '基準' }),
            (error: Error & { retryable?: boolean }) => error.retryable === false);
    } finally {
        globalThis.chrome = chromeOriginal;
    }
});

test('60秒の既定に依存せずタイムアウトを模擬し、通信を中止できる', async () => {
    await withFetch(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('中止')));
    }), async () => {
        await assert.rejects(screenViaGeminiDecision(params, 5), /中止/);
    });
});

test('新規 Run は専用モデルだけ0.15、他モデルは設定値か0.3を使う', () => {
    assert.ok(isGeminiDecisionModel(params.model));
    for (const configured of [undefined, 0, 0.3, 0.8]) {
        assert.equal(newRunIncludeThreshold(params.model, configured), 0.15);
    }
    assert.equal(newRunIncludeThreshold('gemini-3.1-flash-lite', 0.7), 0.7);
    assert.equal(newRunIncludeThreshold('jev-1.14.0', undefined), 0.3);
    assert.equal(newRunIncludeThreshold('other', 0), 0);
});

test('入力だけの単価・見積もりを使い、生成パラメータを記録しない', () => {
    const pricing = resolveModelPricing(params.model, []);
    assert.deepEqual(pricing, { inputPerMillion: 0.1, outputPerMillion: 0 });
    assert.equal(estimateOutputTokens(params.model), 0);
    assert.equal(estimateBatchCost([{ title: '' }], '', params.model, pricing), 0.00004);
    assert.deepEqual(getModelGenerationSettings(params.model), { provider: 'gemini' });
    const sent = sentGenerationSettings(params.model, {
        temperature: 0, topP: 0.9, thinkingLevel: 'LOW', maxOutputTokens: 1000, reasoningEffort: 'high',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), {});
});

test('フルテキストの候補と既定の候補から除外し、既存のGeminiは残す', () => {
    const models = filterFulltextGeminiModels(AVAILABLE_MODELS);
    assert.ok(models.length > 0);
    assert.ok(models.every(model => model.provider === 'gemini' && model.id !== params.model));
    assert.equal(models[0].id, 'gemini-3.1-flash-lite');
    assert.deepEqual(filterFulltextGeminiModels([
        AVAILABLE_MODELS.find(model => model.id === params.model)!, ...AVAILABLE_MODELS,
    ]), models);
});

test('tier別の推奨並列数・待機・保存件数を使う', () => {
    for (const [tier, concurrency, delay, save] of [
        ['free', 1, 1500, 5], ['tier1', 4, 350, 4], ['tier2', 16, 300, 16], ['tier3', 40, 300, 40],
    ] as const) {
        assert.deepEqual(getBatchProfile(tier, params.model), {
            rate: { concurrency, delayBetweenRequests: delay }, saveBatchSize: save,
        });
    }
});
