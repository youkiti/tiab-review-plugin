// Anthropic の送信形式・応答解釈・再試行境界を、実 API を呼ばずに検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenViaAnthropic, testAnthropicApiKey, toAnthropicSchema } from '../src/lib/providers/anthropic';
import { setSessionAnthropicApiKey, clearSessionAnthropicApiKey } from '../src/lib/storage';
import { screenWithProvider, convertCriteriaWithProvider, resolveProviderId } from '../src/lib/llm-provider';
import { AVAILABLE_MODELS, SCREENING_OUTPUT_SCHEMA, CRITERIA_CONVERSION_SCHEMA } from '../src/lib/gemini-api';
import { buildScreeningPrompt, buildCriteriaPrompt } from '../src/lib/providers/structured-prompts';
import { processBatch } from '../src/lib/llm-processor';

const API_KEY = 'test-anthropic-key';
const params = {
    title: '対象文献',
    abstract: '対象文献の抄録',
    screeningPrompt: '組み入れ基準',
    model: 'claude-haiku-5-5',
    outputLanguage: 'ja',
};
const output = { include_probability: 0.8, reasons: ['合致'], evidence: [] };

function response(extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({
        id: 'msg_test',
        model: 'claude-haiku-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: JSON.stringify(output) }],
        usage: {
            input_tokens: 572,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 918,
            output_tokens_details: { thinking_tokens: 743 },
        },
        ...extra,
    }));
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch;
    setSessionAnthropicApiKey(API_KEY);
    globalThis.fetch = mock;
    try {
        await run();
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionAnthropicApiKey();
    }
}

interface SchemaNode {
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, SchemaNode>;
    items?: SchemaNode;
}

function assertSchema(actual: SchemaNode, original: SchemaNode): void {
    if (original.type === 'object') {
        assert.equal(actual.additionalProperties, false);
        assert.deepEqual(actual.required, original.required);
    }
    for (const [key, child] of Object.entries(original.properties ?? {})) {
        assertSchema(actual.properties![key], child);
    }
    if (original.items) {
        assertSchema(actual.items!, original.items);
    }
}

test('スクリーニングの送信形式・既定値・usage・ディスパッチ', async () => {
    let calls = 0;
    await withFetch(async (url, init) => {
        calls++;
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-api-key'), API_KEY);
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(headers.get('content-type'), 'application/json');
        assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true');
        const body = JSON.parse(String(init?.body));
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
            assert.equal(key in body, false);
        }
        assert.equal(body.model, params.model);
        assert.equal(body.max_tokens, 20000);
        assert.equal(body.output_config.effort, 'low');
        assert.equal(body.output_config.format.type, 'json_schema');
        assertSchema(body.output_config.format.schema, SCREENING_OUTPUT_SCHEMA);
        assert.deepEqual(body.messages, [{
            role: 'user',
            content: buildScreeningPrompt(params.title, params.abstract, params.screeningPrompt, params.outputLanguage),
        }]);
        return response();
    }, async () => {
        const result = await screenWithProvider('anthropic', params);
        assert.deepEqual(result.output, output);
        assert.deepEqual(result.usageMetadata, {
            promptTokenCount: 572,
            candidatesTokenCount: 918,
            thoughtsTokenCount: 743,
            totalTokenCount: 1490,
            cachedInputTokens: 0,
        });
        assert.deepEqual(result.responseMetadata, { modelVersion: params.model, responseId: 'msg_test' });
    });
    assert.equal(calls, 1);
});

for (const [effort, limit, expectedEffort, expectedLimit] of [
    ['none', 100, 'low', 4100],
    ['high', 100000, 'high', 64000],
] as const) {
    test(`effort=${effort}・本文上限=${limit} の変換`, async () => {
        await withFetch(async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            assert.equal(body.output_config.effort, expectedEffort);
            assert.equal(body.max_tokens, expectedLimit);
            return response();
        }, async () => {
            await screenViaAnthropic({ ...params, reasoningEffort: effort, maxOutputTokens: limit });
        });
    });
}

test('キャッシュの入力を加算し、複数の text ブロックを連結する', async () => {
    const text = JSON.stringify(output);
    await withFetch(async () => response({
        model: '',
        content: [{ type: 'text', text: text.slice(0, 15) }, { type: 'text', text: text.slice(15) }],
        usage: { input_tokens: 572, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 918 },
    }), async () => {
        const result = await screenViaAnthropic(params);
        assert.deepEqual(result.output, output);
        assert.deepEqual(result.usageMetadata, {
            promptTokenCount: 692, candidatesTokenCount: 918, thoughtsTokenCount: 0, totalTokenCount: 1610, cachedInputTokens: 100,
        });
        assert.equal(result.responseMetadata.modelVersion, params.model);
    });
});

test('usage が欠けた応答はゼロで集計する', async () => {
    await withFetch(async () => response({ usage: undefined }), async () => {
        assert.deepEqual((await screenViaAnthropic(params)).usageMetadata, {
            promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, totalTokenCount: 0, cachedInputTokens: 0,
        });
    });
});

for (const reason of ['refusal', 'max_tokens']) {
    test(`${reason} は本文を読まず再試行不可、通信1回`, async () => {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return response({ stop_reason: reason, content: [] });
        }, async () => {
            await assert.rejects(screenViaAnthropic(params), (err: Error & { retryable?: boolean }) => {
                assert.equal(err.retryable, false);
                if (reason === 'refusal') {
                    assert.equal(err.message, 'Anthropic: モデルが応答を拒否しました (stop_reason=refusal)');
                } else {
                    assert.match(err.message, /max_tokens に達したため応答が打ち切られました/);
                    assert.match(err.message, /thinking_tokens=743, output_tokens=918/);
                }
                return true;
            });
        });
        assert.equal(calls, 1);
    });
}

for (const status of [400, 401, 403, 404, 429, 500, 529]) {
    test(`HTTP ${status} のエラー分類・キー秘匿・通信1回`, async () => {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return new Response(`エラー ${API_KEY}`, { status, headers: { 'retry-after': '7' } });
        }, async () => {
            await assert.rejects(screenViaAnthropic(params), (err: Error & {
                status?: number; retryable?: boolean; retryAfterMs?: number;
            }) => {
                assert.equal(err.status, status);
                assert.equal(err.retryAfterMs, 7000);
                assert.equal(err.retryable === false, [401, 403, 404].includes(status));
                assert.equal(err.message.includes(API_KEY), false);
                assert.match(err.message, /\[REDACTED\]/);
                if (status === 404) {
                    assert.match(err.message, /モデル claude-haiku-5-5 が見つかりません/);
                } else {
                    assert.ok(err.message.startsWith(`Anthropic API error ${status}: `));
                }
                return true;
            });
        });
        assert.equal(calls, 1);
    });
}

for (const header of ['', '0', '-1', 'Infinity', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    test(`秒数でない retry-after=${header} は付与しない`, async () => {
        await withFetch(async () => new Response('', { status: 429, headers: { 'retry-after': header } }), async () => {
            await assert.rejects(screenViaAnthropic(params), (err: Error & { retryAfterMs?: number }) => {
                assert.equal(err.retryAfterMs, undefined);
                return true;
            });
        });
    });
}

for (const [name, makeResponse, pattern] of [
    ['応答 JSON 不正', () => new Response('{'), /./],
    ['本文なし', () => response({ content: [] }), /Anthropic: 空のレスポンス/],
    ['本文 JSON 不正', () => response({ content: [{ type: 'text', text: '{' }] }), /Anthropic: JSON パース失敗。先頭200文字=/],
] as const) {
    test(`${name} は再試行可能、通信1回`, async () => {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return makeResponse();
        }, async () => {
            await assert.rejects(screenViaAnthropic(params), (err: Error & { retryable?: boolean }) => {
                assert.notEqual(err.retryable, false);
                assert.match(err.message, pattern);
                return true;
            });
        });
        assert.equal(calls, 1);
    });
}

test('タイムアウトは AbortSignal で通信1回を中止する', async () => {
    let calls = 0;
    await withFetch(async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('中止')), { once: true });
        });
    }, async () => {
        await assert.rejects(screenViaAnthropic(params, 5), /中止/);
    });
    assert.equal(calls, 1);
});

// プロバイダ内部で再試行しないので、再試行不可の印は一括判定側（processWithRetry）が見る。
// 見落とすと、打ち切り・拒否・認証エラーを同じ条件で3回送ることになる。
for (const [label, makeResponse] of [
    ['max_tokens の打ち切り', () => response({ stop_reason: 'max_tokens', content: [] })],
    ['refusal', () => response({ stop_reason: 'refusal', content: [] })],
    ['HTTP 401', () => new Response('', { status: 401 })],
] as const) {
    test(`一括判定は Anthropic の再試行不可エラー（${label}）を送り直さない`, async () => {
        let calls = 0;
        const waits: number[] = [];
        await withFetch(async () => {
            calls++;
            return makeResponse();
        }, async () => {
            const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
                batchSize: 1,
                model: params.model,
                screeningPrompt: params.screeningPrompt,
                outputLanguage: params.outputLanguage,
                rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
                sleepFn: async (ms) => {
                    waits.push(ms);
                },
                random: () => 0,
            });
            assert.equal(result.fallbackCount, 1);
        });
        assert.equal(calls, 1);
        assert.deepEqual(waits.filter(ms => ms > 0), []);
    });
}

test('一括判定は Anthropic の HTTP 400 を再試行する（4xx を恒久的な失敗と決めつけない）', async () => {
    let calls = 0;
    await withFetch(async () => {
        calls++;
        return new Response('', { status: 400 });
    }, async () => {
        const result = await processBatch([{ ref_id: 'ref-1', title: '対象文献' }], {
            batchSize: 1,
            model: params.model,
            screeningPrompt: params.screeningPrompt,
            outputLanguage: params.outputLanguage,
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            sleepFn: async () => {},
            random: () => 0,
        });
        assert.equal(result.fallbackCount, 1);
    });
    assert.equal(calls, 3);
});

test('基準変換は再試行して正規化し、medium effort と共通プロンプトを使う', async () => {
    let calls = 0;
    const retries: number[][] = [];
    await withFetch(async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.output_config.effort, 'medium');
        assert.equal(body.messages[0].content, buildCriteriaPrompt('基準', 'ja'));
        assertSchema(body.output_config.format.schema, CRITERIA_CONVERSION_SCHEMA);
        if (calls === 1) {
            return new Response('', { status: 529 });
        }
        return response({ content: [{ type: 'text', text: JSON.stringify({
            criteria: { template: 'peco', fields: { P: '成人', E: '曝露', C: null, O: 12, extra: false } },
            screening_prompt: '最適化済み',
        }) }] });
    }, async () => {
        // 画面からはモデル設定の reasoningEffort（一括判定向けの low）が渡ってくるが、基準の最適化は medium で送る。
        const result = await convertCriteriaWithProvider('anthropic', {
            protocolText: '基準', model: params.model, outputLanguage: 'ja', reasoningEffort: 'low',
        }, { retryDelayMs: 0, onRetry: (...args) => retries.push(args) });
        assert.deepEqual(result, {
            criteria: { template: 'peco', fields: { P: '成人', E: '曝露', C: '', O: '' } },
            screening_prompt: '最適化済み',
        });
    });
    assert.equal(calls, 2);
    assert.deepEqual(retries, [[1, 2, 0]]);
});

test('基準変換の認証エラーは再試行しない', async () => {
    let calls = 0;
    await withFetch(async () => {
        calls++;
        return new Response('', { status: 401 });
    }, async () => {
        await assert.rejects(convertCriteriaWithProvider('anthropic', {
            protocolText: '基準', model: params.model, outputLanguage: 'ja',
        }, { retryDelayMs: 0 }), /API error 401/);
    });
    assert.equal(calls, 1);
});

test('キー検証は models API とブラウザ用ヘッダーを使う', async () => {
    for (const status of [200, 401]) {
        await withFetch(async (url, init) => {
            assert.equal(url, 'https://api.anthropic.com/v1/models?limit=1');
            assert.equal(init?.method, 'GET');
            const headers = new Headers(init?.headers);
            assert.equal(headers.get('x-api-key'), API_KEY);
            assert.equal(headers.get('anthropic-version'), '2023-06-01');
            assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true');
            return new Response('', { status });
        }, async () => {
            assert.deepEqual(await testAnthropicApiKey(API_KEY), status === 200
                ? { isValid: true } : { isValid: false, reason: 'HTTP 401' });
        });
    }
});

test('キー検証は貼り付け時に混入した不可視文字を除去し、全角文字は通信せずに無効とする', async () => {
    let calls = 0;
    await withFetch(async (_url, init) => {
        calls++;
        assert.equal(new Headers(init?.headers).get('x-api-key'), API_KEY);
        return new Response('', { status: 200 });
    }, async () => {
        assert.deepEqual(await testAnthropicApiKey(`​${API_KEY}﻿ `), { isValid: true });
        const invalid = await testAnthropicApiKey(`${API_KEY}あ`);
        assert.equal(invalid.isValid, false);
        assert.match(invalid.reason ?? '', /ISO-8859-1/);
    });
    assert.equal(calls, 1);
});

test('キー検証の例外からキーを除去する', async () => {
    await withFetch(async () => {
        throw new Error(`通信失敗 ${API_KEY}`);
    }, async () => {
        assert.deepEqual(await testAnthropicApiKey(API_KEY), { isValid: false, reason: '通信失敗 [REDACTED]' });
    });
});

test('スキーマを深く複製し、元の定数と required を変更しない', () => {
    for (const schema of [SCREENING_OUTPUT_SCHEMA, CRITERIA_CONVERSION_SCHEMA]) {
        const snapshot = JSON.stringify(schema);
        const converted = toAnthropicSchema(schema);
        assertSchema(converted, schema);
        assert.notEqual(converted, schema);
        assert.notEqual(converted.properties, schema.properties);
        assert.equal(JSON.stringify(schema), snapshot);
    }
});

test('同梱 Anthropic モデルは2つだけで、未登録 Claude ID は従来のフォールバックを維持する', () => {
    assert.deepEqual(AVAILABLE_MODELS.filter(model => model.provider === 'anthropic').map(model => model.id), [
        'claude-haiku-5-5', 'claude-sonnet-5-5',
    ]);
    assert.equal(resolveProviderId('claude-haiku-5-5', AVAILABLE_MODELS), 'anthropic');
    assert.equal(resolveProviderId('claude-sonnet-5-5', AVAILABLE_MODELS), 'anthropic');
    assert.equal(resolveProviderId('claude-unknown', AVAILABLE_MODELS), 'gemini');
});
