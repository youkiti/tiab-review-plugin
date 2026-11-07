// 四社の自由問い合わせをモックし、送信形式・失敗種別・中止境界を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { askWithProvider } from '../src/lib/llm-provider';
import { classifyConsultError, consultHelp } from '../src/lib/help-consult/consult';
import { CONSULT_MODELS } from '../src/lib/help-consult/model';
import type { ConsultProviderId } from '../src/lib/help-consult/model';
import type { HelpSection } from '../src/lib/help-consult/types';
import { anthropicMaxOutputTokens } from '../src/lib/model-generation-settings';
import {
    setSessionApiKey, clearSessionApiKey, setSessionOpenAiApiKey, clearSessionOpenAiApiKey,
    setSessionAnthropicApiKey, clearSessionAnthropicApiKey, setSessionOpenRouterApiKey, clearSessionOpenRouterApiKey,
} from '../src/lib/storage';

const providers = ['gemini', 'openai', 'anthropic', 'openrouter'] as const;
const schema = { type: 'object', properties: { sectionIds: { type: 'array', items: { type: 'string' } } }, required: ['sectionIds'] };
const key = 'test-consult-key';
const setters = [setSessionApiKey, setSessionOpenAiApiKey, setSessionAnthropicApiKey, setSessionOpenRouterApiKey];
const clearers = [clearSessionApiKey, clearSessionOpenAiApiKey, clearSessionAnthropicApiKey, clearSessionOpenRouterApiKey];

async function withFetch(mock: typeof fetch, run: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    setters.forEach(set => set(key));
    globalThis.fetch = mock;
    try {
        await run();
    } finally {
        globalThis.fetch = original;
        clearers.forEach(clear => clear());
    }
}

function response(provider: ConsultProviderId, text: string): Response {
    const data = {
        gemini: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '思考は返さない', thought: true }, { text }] } }] },
        openai: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] },
        anthropic: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
        openrouter: { choices: [{ message: { content: text } }] },
    };
    return new Response(JSON.stringify(data[provider]));
}

for (const provider of providers) {
    test(`${provider}: URL・ヘッダーとスキーマ有無の送信形式`, async () => {
        for (const structured of [false, true]) {
            let calls = 0;
            await withFetch(async (url, init) => {
                calls++;
                const body = JSON.parse(String(init?.body));
                const headers = new Headers(init?.headers);
                assert.equal(headers.get('content-type'), 'application/json');
                if (provider === 'gemini') {
                    assert.equal(String(url), `https://generativelanguage.googleapis.com/v1beta/models/${CONSULT_MODELS[provider]}`
                        + `:generateContent?key=${key}`);
                    assert.deepEqual(body.contents, [{ parts: [{ text: '質問' }] }]);
                    assert.deepEqual(body.systemInstruction, { parts: [{ text: '指示' }] });
                    assert.equal(body.generationConfig.maxOutputTokens, 2048);
                    assert.equal('thinkingConfig' in body.generationConfig, false);
                    assert.equal('responseMimeType' in body.generationConfig, structured);
                    assert.equal('responseSchema' in body.generationConfig, structured);
                    if (structured) {
                        assert.deepEqual(body.generationConfig.responseSchema, schema);
                    }
                } else {
                    assert.equal(body.model, CONSULT_MODELS[provider]);
                    if (provider === 'anthropic') {
                        assert.equal(url, 'https://api.anthropic.com/v1/messages');
                        assert.equal(headers.get('x-api-key'), key);
                        assert.equal(headers.get('anthropic-version'), '2023-06-01');
                        assert.equal(headers.get('anthropic-dangerous-direct-browser-access'), 'true');
                        assert.equal(body.system, '指示');
                        assert.equal(body.max_tokens, anthropicMaxOutputTokens(2048));
                        assert.equal(body.output_config.effort, 'low');
                        assert.equal('format' in body.output_config, structured);
                        if (structured) {
                            assert.equal(body.output_config.format.schema.additionalProperties, false);
                        }
                    } else if (provider === 'openai') {
                        assert.equal(url, 'https://api.openai.com/v1/responses');
                        assert.equal(headers.get('authorization'), `Bearer ${key}`);
                        assert.equal(body.instructions, '指示');
                        assert.deepEqual(body.input, [{ role: 'user', content: '質問' }]);
                        assert.equal(body.store, false);
                        assert.equal(body.max_output_tokens, 2048);
                        assert.equal('text' in body, structured);
                        if (structured) {
                            assert.equal(body.text.format.strict, true);
                            assert.equal(body.text.format.schema.additionalProperties, false);
                        }
                        assert.equal('temperature' in body, false);
                        assert.equal('top_p' in body, false);
                    } else {
                        assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
                        assert.equal(headers.get('authorization'), `Bearer ${key}`);
                        assert.equal(headers.get('http-referer'), 'https://github.com/youkiti/tiab-review-plugin');
                        assert.equal(headers.get('x-title'), 'tiab-review-plugin');
                        assert.equal('response_format' in body, false);
                        assert.equal(body.messages[0].role, 'system');
                        assert.equal(body.messages[0].content, '指示');
                        assert.equal(body.messages[1].content.includes(JSON.stringify(schema)), structured);
                        assert.equal(body.max_tokens, 2048);
                        assert.equal('reasoning' in body, false);
                    }
                }
                return response(provider, structured ? '{"sectionIds":["a"]}' : '回答');
            }, async () => {
                const result = await askWithProvider(provider, {
                    model: CONSULT_MODELS[provider], prompt: '質問', systemPrompt: '指示', maxOutputTokens: 2048,
                    ...(structured ? { jsonSchema: schema } : {}),
                });
                assert.deepEqual(result, structured ? { sectionIds: ['a'] } : '回答');
            });
            assert.equal(calls, 1);
        }
    });

    test(`${provider}: HTTP エラーを分類し、自動再試行しない`, async () => {
        for (const [status, expected] of [[429, 'rate_limited'], [401, 'auth'], [403, 'auth']] as const) {
            let calls = 0;
            await withFetch(async () => {
                calls++;
                return new Response('{}', { status });
            }, async () => {
                await assert.rejects(askWithProvider(provider, {
                    model: CONSULT_MODELS[provider], prompt: '質問', maxOutputTokens: 100,
                }), error => classifyConsultError(error) === expected);
            });
            assert.equal(calls, 1);
        }
    });

    test(`${provider}: 外部中止とタイムアウトを区別し、通信の signal も中止する`, async () => {
        for (const kind of ['aborted', 'timeout'] as const) {
            const external = new AbortController();
            let fetchSignal: AbortSignal | undefined;
            await withFetch(async (_, init) => {
                fetchSignal = init?.signal ?? undefined;
                return new Promise<Response>((_, reject) => {
                    fetchSignal!.addEventListener('abort', () => reject(new DOMException('中止', 'AbortError')), { once: true });
                    if (kind === 'aborted') {
                        external.abort();
                    }
                });
            }, async () => {
                await assert.rejects(askWithProvider(provider, {
                    model: CONSULT_MODELS[provider], prompt: '質問', maxOutputTokens: 100,
                    signal: external.signal, timeoutMs: kind === 'timeout' ? 10 : 1000,
                }), error => classifyConsultError(error, external.signal) === kind);
                assert.equal(fetchSignal?.aborted, true);
            });
        }
    });

    test(`${provider}: 中止済みなら送信せず、不正な JSON や空本文は失敗する`, async () => {
        const external = new AbortController();
        external.abort();
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return response(provider, '不正な JSON');
        }, async () => {
            const params = { model: CONSULT_MODELS[provider], prompt: '質問', maxOutputTokens: 100 };
            await assert.rejects(askWithProvider(provider, { ...params, signal: external.signal }),
                error => classifyConsultError(error) === 'aborted');
            assert.equal(calls, 0);
            await assert.rejects(askWithProvider(provider, { ...params, jsonSchema: schema }),
                error => classifyConsultError(error) === 'invalid_response');
        });
        await withFetch(async () => response(provider, ''), async () => {
            await assert.rejects(askWithProvider(provider, { model: CONSULT_MODELS[provider], prompt: '質問', maxOutputTokens: 100 }),
                error => classifyConsultError(error) === 'invalid_response');
        });
    });
}

test('Gemini はモデル設定の思考レベルを小文字で送り、思考本文は要求しない', async () => {
    await withFetch(async (_, init) => {
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
        return response('gemini', '回答');
    }, async () => {
        assert.equal(await askWithProvider('gemini', {
            model: 'gemini-3-flash-preview', prompt: '質問', maxOutputTokens: 100,
        }), '回答');
    });
});

test('OpenRouter は推論の強さが指定されたときだけその値を送る', async () => {
    for (const reasoningEffort of ['none', 'low', 'medium', 'high'] as const) {
        await withFetch(async (_, init) => {
            const body = JSON.parse(String(init?.body));
            assert.deepEqual(body.reasoning, { effort: reasoningEffort });
            return response('openrouter', '回答');
        }, async () => {
            assert.equal(await askWithProvider('openrouter', {
                model: CONSULT_MODELS.openrouter, prompt: '質問', maxOutputTokens: 100, reasoningEffort,
            }), '回答');
        });
    }
});

const sections: HelpSection[] = ['a', 'b'].map(id => ({
    id, title: id, body: `本文${id}`, when: [], level: 3, sectionId: 'group', sectionTitle: '章',
}));

test('OpenRouter は JSON 指定の有無にかかわらず打ち切られた本文を拒否し、正常終了なら返す', async () => {
    for (const finishReason of ['length', 'content_filter', 'stop']) {
        for (const structured of [false, true]) {
            const text = structured ? '{"sectionIds":["a"]}' : '回答';
            await withFetch(async () => new Response(JSON.stringify({
                choices: [{ finish_reason: finishReason, message: { content: text } }],
            })), async () => {
                const result = askWithProvider('openrouter', {
                    model: CONSULT_MODELS.openrouter, prompt: '質問', maxOutputTokens: 100,
                    ...(structured ? { jsonSchema: schema } : {}),
                });
                if (finishReason === 'stop') {
                    assert.deepEqual(await result, structured ? { sectionIds: ['a'] } : '回答');
                } else {
                    await assert.rejects(result, error => classifyConsultError(error) === 'invalid_response');
                }
            });
        }
    }
});

test('OpenRouter の相談は小節選択・回答生成の打ち切りを失敗として返し、正常終了なら成功する', async () => {
    for (const finishReason of ['length', 'content_filter', 'stop']) {
        for (const targetCall of [1, 2]) {
            let calls = 0;
            await withFetch(async () => {
                calls++;
                return new Response(JSON.stringify({ choices: [{
                    finish_reason: calls === targetCall ? finishReason : 'stop',
                    message: { content: calls === 1 ? '{"sectionIds":["a"]}' : '回答' },
                }] }));
            }, async () => {
                assert.deepEqual(await consultHelp({ question: '質問', lang: 'ja', sections, providerId: 'openrouter' }),
                    finishReason === 'stop'
                        ? { status: 'success', sectionIds: ['a'], answer: '回答' }
                        : { status: 'failure', kind: 'invalid_response' });
            });
            assert.equal(calls, finishReason === 'stop' ? 2 : targetCall);
        }
    }
});

test('相談は選択ゼロで止まり、未知 ID を落として選ばれた本文だけで回答する', async () => {
    for (const ids of [[], ['unknown'], ['unknown', 'a', 'a']]) {
        let calls = 0;
        await withFetch(async (_, init) => {
            calls++;
            if (calls === 1) {
                assert.doesNotMatch(String(init?.body), /本文a/);
                return response('openai', JSON.stringify({ sectionIds: ids }));
            }
            assert.match(String(init?.body), /本文a/);
            assert.doesNotMatch(String(init?.body), /本文b/);
            return response('openai', '回答');
        }, async () => {
            const result = await consultHelp({ question: '質問', lang: 'ja', sections, providerId: 'openai' });
            assert.deepEqual(result, ids.includes('a')
                ? { status: 'success', sectionIds: ['a'], answer: '回答' } : { status: 'no_match' });
        });
        assert.equal(calls, ids.includes('a') ? 2 : 1);
    }
});

test('該当なしと失敗を区別する', async () => {
    const params = { question: '質問', lang: 'ja' as const, sections };
    assert.deepEqual(await consultHelp({ ...params, providerId: null }), { status: 'failure', kind: 'no_key' });
    for (const providerId of ['typesafe', 'local_llm'] as const) {
        assert.deepEqual(await consultHelp({ ...params, providerId }), { status: 'failure', kind: 'unsupported_provider' });
        await assert.rejects(askWithProvider(providerId, { model: '', prompt: '', maxOutputTokens: 1 }),
            error => classifyConsultError(error) === 'unsupported_provider');
    }
    await withFetch(async () => response('openai', '{}'), async () => {
        assert.deepEqual(await consultHelp({ ...params, providerId: 'openai' }), { status: 'failure', kind: 'invalid_response' });
    });
    await withFetch(async () => { throw new TypeError('fetch failed'); }, async () => {
        assert.deepEqual(await consultHelp({ ...params, providerId: 'gemini' }), { status: 'failure', kind: 'network' });
    });
    assert.equal(classifyConsultError(new Error('その他')), 'unknown');
    assert.equal(classifyConsultError(Object.assign(new Error('キーなし'), { code: 'api_key_missing' })), 'no_key');
    assert.equal(classifyConsultError(new Error('OPENAI_API_KEY が設定されていません')), 'no_key');
});
