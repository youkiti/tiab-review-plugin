// 実サーバーに接続せず、ローカルモデルの送信契約と失敗時の境界を検査する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLocalModelId, toLocalModelId, stripLocalModelPrefix, normalizeLocalLlmEndpoint, deriveLocalLlmModelsUrl } from '../src/lib/local-llm-model';
import { screenViaLocalLlm, convertCriteriaViaLocalLlm, fetchLocalLlmModels, testLocalLlmChat } from '../src/lib/providers/local-llm';
import { resolveProviderId, screenWithProvider, convertCriteriaWithProvider } from '../src/lib/llm-provider';
import { findModelConfig, AVAILABLE_MODELS, SCREENING_OUTPUT_SCHEMA } from '../src/lib/gemini-api';
import { getBatchProfile, type ManualTier } from '../src/lib/types';
import { buildModelGroups, filterModelGroupsByProvider } from '../src/lib/llm-model-options';
import { getLocalLlmEndpoint, getLocalLlmModels, saveLocalLlmEndpoint, saveLocalLlmModels } from '../src/lib/storage';
import { sentGenerationSettings, getModelGenerationSettings } from '../src/lib/model-generation-settings';
import { buildTiabPromptTemplate } from '../src/lib/llm-prompt-record';
import { buildScreeningPrompt } from '../src/lib/providers/structured-prompts';
import { processBatch } from '../src/lib/llm-processor';

const endpoint = 'http://localhost:11434/v1/chat/completions';
const params = { title: '対象文献', abstract: '対象文献の抄録', screeningPrompt: '基準', model: 'local:a/b', outputLanguage: 'ja' };
const output = { include_probability: 0.8, reasons: ['合致'], evidence: [] };

function response(content = JSON.stringify(output), extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({
        id: 'local-response',
        model: 'a/b-server-version',
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 3 } },
        ...extra,
    }));
}

async function withFetch(mock: typeof fetch, run: () => Promise<void>, url = endpoint): Promise<void> {
    const originalFetch = globalThis.fetch;
    const originalChrome = globalThis.chrome;
    const values: Record<string, unknown> = { local_llm_endpoint: url };
    globalThis.chrome = {
        storage: { local: {
            get: async () => ({ ...values }),
            set: async (items: Record<string, unknown>) => { Object.assign(values, items); },
        } },
    } as unknown as typeof chrome;
    globalThis.fetch = mock;
    try {
        await run();
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.chrome = originalChrome;
    }
}

test('ローカル ID の接頭辞を一か所で付与・識別・除去する', () => {
    assert.equal(toLocalModelId('a/b'), 'local:a/b');
    assert.equal(toLocalModelId('local:a/b'), 'local:a/b');
    assert.equal(isLocalModelId('local:a/b'), true);
    assert.equal(isLocalModelId('a/b'), false);
    assert.equal(stripLocalModelPrefix('local:a/b'), 'a/b');
    assert.equal(stripLocalModelPrefix('a/b'), 'a/b');
    assert.equal(resolveProviderId('local:a/b', [{ id: 'local:a/b', provider: 'openrouter' }]), 'local_llm');
    assert.deepEqual(findModelConfig('local:model'), { model: 'local:model', temperature: 0 });
});

test('URL はループバックだけを許可し、認証情報とフラグメントを拒否する', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const url = `http://${host}:1234/v1/chat/completions`;
        assert.equal(normalizeLocalLlmEndpoint(` ${url} `), url);
        assert.equal(normalizeLocalLlmEndpoint(url.replace('http:', 'https:')), url.replace('http:', 'https:'));
    }
    for (const url of ['https://example.org', 'http://example.org', 'http://localhost.example.org',
        'http://user:secret@localhost', 'http://localhost/#fragment', 'file://localhost/test', '不正']) {
        assert.throws(() => normalizeLocalLlmEndpoint(url));
    }
});

test('モデル一覧 URL は末尾だけを置換してクエリを維持する', () => {
    assert.equal(deriveLocalLlmModelsUrl(endpoint + '?a=1'), 'http://localhost:11434/v1/models?a=1');
    assert.throws(() => deriveLocalLlmModelsUrl('http://localhost:11434/v1'));
});

test('モデル一覧は埋め込み・空・非文字列・重複を除き、認証ヘッダーなしで取得する', async () => {
    await withFetch(async (url, init) => {
        assert.equal(url, 'http://localhost:11434/v1/models');
        assert.equal(init?.method, 'GET');
        assert.equal(new Headers(init?.headers).has('Authorization'), false);
        assert.equal(init?.redirect, 'error');
        return new Response(JSON.stringify({ data: [{ id: 'a/b' }, { id: 'EMBED-model' }, { id: 'a/b' }, { id: 1 }, { id: '' }] }));
    }, async () => {
        assert.deepEqual(await fetchLocalLlmModels(endpoint), ['a/b']);
    });
});

test('URL とモデル一覧はキーなしで端末に保存する', async () => {
    await withFetch(async () => { throw new Error('通信不要'); }, async () => {
        await saveLocalLlmEndpoint(' ' + endpoint + ' ');
        await saveLocalLlmModels(['a/b']);
        assert.equal(await getLocalLlmEndpoint(), endpoint);
        assert.deepEqual(await getLocalLlmModels(), ['a/b']);
    });
});

test('一括判定は1回送信し、キー・トークン上限・推論設定を送らない', async () => {
    let calls = 0;
    await withFetch(async (url, init) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(new Headers(init?.headers).has('Authorization'), false);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'a/b');
        assert.equal(body.temperature, 0);
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
        assert.equal(body.messages[0].content, buildScreeningPrompt(params.title, params.abstract, params.screeningPrompt, 'ja'));
        for (const key of ['max_tokens', 'max_output_tokens', 'reasoning_effort', 'top_p']) {
            assert.equal(key in body, false);
        }
        return response();
    }, async () => {
        const result = await screenWithProvider('local_llm', params);
        assert.deepEqual(result.output, output);
        assert.deepEqual(result.usageMetadata, { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30, thoughtsTokenCount: 3 });
        assert.equal(result.responseMetadata.modelVersion, 'a/b-server-version');
        assert.equal(calls, 1);
    });
});

test('構造化形式は400/422の形式非対応だけで段階的に緩め、接続先ごとに記憶する', async () => {
    const url = endpoint + '?cascade';
    let calls = 0;
    await withFetch(async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (calls === 1) {
            assert.equal(body.response_format.json_schema.strict, true);
            return new Response('strict schema unsupported', { status: 400 });
        }
        if (calls === 2) {
            assert.equal('strict' in body.response_format.json_schema, false);
            return new Response('response_format unsupported', { status: 422 });
        }
        assert.equal(body.response_format.type, 'json_object');
        assert.ok(body.messages[0].content.includes(JSON.stringify(SCREENING_OUTPUT_SCHEMA)));
        return response();
    }, async () => {
        await screenViaLocalLlm(params);
        assert.equal(calls, 3);
        await screenViaLocalLlm(params);
        assert.equal(calls, 4);
    }, url);
    await withFetch(async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).response_format.json_schema.strict, true);
        return response();
    }, async () => { await screenViaLocalLlm(params); }, endpoint + '?other');
});

test('400のモデルエラーと500のschemaエラーは形式を切り替えない', async () => {
    for (const [status, message] of [[400, 'bad model'], [500, 'schema failure']] as const) {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return new Response(message, { status });
        }, async () => {
            await assert.rejects(screenViaLocalLlm(params), { status });
            assert.equal(calls, 1);
        }, endpoint + '?error=' + status);
    }
});

test('思考タグと Markdown を除去し、版がなければ要求モデル ID を使う', async () => {
    await withFetch(async () => response('<think>思考\n内容</think>\n```json\n' + JSON.stringify(output) + '\n```', { model: undefined }), async () => {
        const result = await screenViaLocalLlm(params);
        assert.deepEqual(result.output, output);
        assert.equal(result.responseMetadata.modelVersion, 'a/b');
    });
});

test('出力上限と空の応答を検出する', async () => {
    await withFetch(async () => response('', { choices: [{ finish_reason: 'length', message: { content: '' } }] }), async () => {
        await assert.rejects(screenViaLocalLlm(params), { code: 'max_tokens_truncated', retryable: false });
    });
    await withFetch(async () => response(''), async () => {
        await assert.rejects(screenViaLocalLlm(params), /空の応答/);
    });
});

test('接続不能は URL とサーバー起動の案内を返す', async () => {
    await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
        await assert.rejects(screenViaLocalLlm(params), error => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes(endpoint));
            assert.match(error.message, /サーバーを起動/);
            return true;
        });
    });
});

test('403はOllamaの許可設定、404はモデルとURLの案内を返す', async () => {
    for (const status of [400, 401, 403, 404]) {
        await withFetch(async () => new Response('error', { status }), async () => {
            await assert.rejects(screenViaLocalLlm(params), error => {
                assert.equal((error as { retryable?: boolean }).retryable, false);
                if (status === 403) {
                    assert.match(String(error), /OLLAMA_ORIGINS.*chrome-extension:\/\/\*/);
                }
                if (status === 404) {
                    assert.match(String(error), /モデルまたは URL/);
                }
                return true;
            });
        });
    }
});

test('接続テストは JSON を要求し、ok=true を確認する', async () => {
    await withFetch(async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).messages[0].content, 'Return {"ok":true}.');
        return response('{"ok":true}');
    }, async () => { await testLocalLlmChat(endpoint, 'local:a/b'); });
});

test('一括判定の再試行処理はローカルの恒久的エラーを送り直さない', async () => {
    for (const status of [400, 401, 403, 404]) {
        let calls = 0;
        await withFetch(async () => {
            calls++;
            return new Response('error', { status });
        }, async () => {
            const result = await processBatch([{ ref_id: 'local-ref', title: '対象文献' }], {
                batchSize: 1,
                model: params.model,
                screeningPrompt: params.screeningPrompt,
                outputLanguage: params.outputLanguage,
                rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
                sleepFn: async () => {},
                random: () => 0,
            });
            assert.equal(result.fallbackCount, 1);
            assert.equal(calls, 1);
        });
    }
});

test('基準最適化は正規化し、再試行コールバックを通知する', async () => {
    let calls = 0;
    const retries: number[] = [];
    await withFetch(async () => {
        calls++;
        if (calls === 1) {
            return new Response('temporary', { status: 503 });
        }
        return response(JSON.stringify({ criteria: { template: 'pico', fields: { P: '集団', I: null } }, screening_prompt: '基準' }));
    }, async () => {
        const result = await convertCriteriaWithProvider('local_llm', { ...params, protocolText: 'プロトコル' }, {
            retryDelayMs: 0,
            onRetry: attempt => { retries.push(attempt); },
        });
        assert.deepEqual(result.criteria.fields, { P: '集団', I: '', C: '', O: '' });
        assert.equal(result.screening_prompt, '基準');
        assert.deepEqual(retries, [1]);
        assert.equal(calls, 2);
    });
});

test('基準最適化は再試行不可の応答を送り直さない', async () => {
    let calls = 0;
    await withFetch(async () => {
        calls++;
        return new Response('forbidden', { status: 403 });
    }, async () => {
        await assert.rejects(convertCriteriaViaLocalLlm({ ...params, protocolText: '基準' }, { retryDelayMs: 0 }));
        assert.equal(calls, 1);
    });
});

test('形式に合わない判定結果を成功として返さない', async () => {
    const invalid = [
        { reasons: [], evidence: [] },
        { include_probability: '0.8', reasons: [], evidence: [] },
        { include_probability: 1.2, reasons: [], evidence: [] },
        { include_probability: -0.1, reasons: [], evidence: [] },
        { include_probability: 0.8, evidence: [] },
        { include_probability: 0.8, reasons: [] },
        null,
    ];
    for (const body of invalid) {
        await withFetch(async () => response(JSON.stringify(body)), async () => {
            await assert.rejects(screenViaLocalLlm(params), /ローカル LLM:/);
        });
    }
    await withFetch(async () => response(JSON.stringify({ include_probability: 0, reasons: [], evidence: [] })), async () => {
        assert.equal((await screenViaLocalLlm(params)).output.include_probability, 0);
    });
});

test('タイムアウトで通信を中止する', async () => {
    await withFetch(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }), async () => {
        await assert.rejects(screenViaLocalLlm(params, 5), /以内に返りませんでした/);
    });
});

test('ローカル実行は全tierで並列1・待機0・5件ごと保存', () => {
    for (const tier of ['free', 'tier1', 'tier2', 'tier3'] as ManualTier[]) {
        assert.deepEqual(getBatchProfile(tier, 'local:a/b'), { rate: { concurrency: 1, delayBetweenRequests: 0 }, saveBatchSize: 5 });
    }
});

test('ローカルモデルのグループは翻訳キーと接頭辞付き ID を持つ', () => {
    const groups = buildModelGroups(AVAILABLE_MODELS, [], [], ['a/b']);
    assert.deepEqual(filterModelGroupsByProvider(groups, 'local_llm'), [{
        label: '', labelKey: 'llmExt_localName',
        models: [{ id: 'local:a/b', name: 'a/b', provider: 'local_llm', config: { temperature: 0 } }],
    }]);
});

test('ローカルモデルの履歴・論文用設定にsamplingやeffortを混ぜない', () => {
    assert.deepEqual(getModelGenerationSettings('local:a/b'), { provider: 'local_llm', temperature: 0 });
    const settings = sentGenerationSettings('local:a/b', { temperature: 1, topP: 0.9, reasoningEffort: 'high', maxOutputTokens: 10 });
    assert.ok(Object.values(settings).every(value => value === undefined));
    assert.equal(buildTiabPromptTemplate('local:a/b', '基準', 'ja'), buildScreeningPrompt('{{TITLE}}', '{{ABSTRACT}}', '基準', 'ja'));
});

test('manifestはループバック権限を任意として宣言する', () => {
    const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
    for (const pattern of ['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*']) {
        assert.ok(manifest.optional_host_permissions.includes(pattern));
        assert.equal(manifest.host_permissions.includes(pattern), false);
    }
    assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
});
