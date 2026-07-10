import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderId, convertCriteriaWithProvider } from '../src/lib/llm-provider';
import { setSessionOpenRouterApiKey, clearSessionOpenRouterApiKey, setSessionOpenAiApiKey, clearSessionOpenAiApiKey } from '../src/lib/storage';
import { screenViaOpenAi, _toStrictSchemaForTest } from '../src/lib/providers/openai';

const models = [
    { id: 'gemini-3.1-flash-lite', provider: 'gemini' as const },
    { id: 'gemini-3-flash-preview', provider: 'gemini' as const },
    { id: 'qwen/qwen3-235b-a22b-2507', provider: 'openrouter' as const },
    { id: 'deepseek/deepseek-v4-flash', provider: 'openrouter' as const },
    { id: 'gpt-5.6-terra', provider: 'openai' as const },
    { id: 'gpt-5.6-luna', provider: 'openai' as const },
];

test('resolveProviderId picks gemini for Gemini IDs', () => {
    assert.equal(resolveProviderId('gemini-3.1-flash-lite', models), 'gemini');
    assert.equal(resolveProviderId('gemini-3-flash-preview', models), 'gemini');
});

test('resolveProviderId picks openrouter for OpenRouter IDs', () => {
    assert.equal(resolveProviderId('qwen/qwen3-235b-a22b-2507', models), 'openrouter');
    assert.equal(resolveProviderId('deepseek/deepseek-v4-flash', models), 'openrouter');
});

test('resolveProviderId falls back to openrouter for unknown slash-prefixed IDs', () => {
    // 未登録だがスラッシュを含む → openrouter 形式とみなす
    assert.equal(resolveProviderId('moonshotai/kimi-k2', models), 'openrouter');
});

test('resolveProviderId falls back to gemini for unknown plain IDs', () => {
    // 未登録でスラッシュも無い → gemini にフォールバック（既存 Gemini モデルが移行で残るケース想定）
    assert.equal(resolveProviderId('gemini-2.5-flash', models), 'gemini');
});

test('resolveProviderId picks openai for GPT IDs', () => {
    assert.equal(resolveProviderId('gpt-5.6-terra', models), 'openai');
    assert.equal(resolveProviderId('gpt-5.6-luna', models), 'openai');
});

// ===== convertCriteriaWithProvider (OpenRouter 経路) =====

const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;

function installChromeI18nMock(): void {
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
        i18n: {
            getMessage: (key: string, substitutions?: string | string[]) => {
                if (!substitutions) return key;
                const values = Array.isArray(substitutions) ? substitutions : [substitutions];
                return `${key}: ${values.join(',')}`;
            },
        },
    } as typeof chrome;
}

test('convertCriteriaWithProvider(openrouter) は OpenRouter エンドポイントへ POST して結果を正規化する', async () => {
    installChromeI18nMock();
    setSessionOpenRouterApiKey('test-openrouter-key');

    const successPayload = {
        criteria: {
            template: 'peco',
            fields: {
                P: '成人糖尿病患者',
                E: '運動療法',
                // C, O は欠損 → 補完される
            },
        },
        screening_prompt: 'OpenRouter スクリーニングプロンプト',
    };

    let requestUrl = '';
    let requestBodyText = '';
    let authHeader = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        requestBodyText = typeof init?.body === 'string' ? init.body : '';
        const headers = init?.headers as Record<string, string> | undefined;
        authHeader = headers?.['Authorization'] ?? '';
        return new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify(successPayload) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
        const result = await convertCriteriaWithProvider(
            'openrouter',
            {
                protocolText: 'protocol body',
                model: 'qwen/qwen3-235b-a22b-2507',
                temperature: 0,
                outputLanguage: 'ja',
            },
            { retryDelayMs: 0 }
        );

        assert.equal(requestUrl, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(authHeader, 'Bearer test-openrouter-key');
        const sentBody = JSON.parse(requestBodyText);
        assert.equal(sentBody.model, 'qwen/qwen3-235b-a22b-2507');
        assert.equal(sentBody.temperature, 0);
        // PECO 欠損フィールドが空文字で補完されること
        assert.deepEqual(result.criteria.fields, {
            P: '成人糖尿病患者',
            E: '運動療法',
            C: '',
            O: '',
        });
        assert.equal(result.screening_prompt, 'OpenRouter スクリーニングプロンプト');
    } finally {
        globalThis.fetch = originalFetch;
        (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
        clearSessionOpenRouterApiKey();
    }
});

test('convertCriteriaWithProvider(openrouter) は JSON 以外を含む応答でも {...} 抽出でパースする', async () => {
    installChromeI18nMock();
    setSessionOpenRouterApiKey('test-openrouter-key');

    const successPayload = {
        criteria: { template: 'pico', fields: { P: '成人', I: '介入', C: '対照', O: 'QOL' } },
        screening_prompt: 'prompt',
    };
    const wrappedText = '```json\n' + JSON.stringify(successPayload) + '\n```\n余計なテキスト';

    globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: wrappedText } }],
    }), { status: 200 })) as typeof fetch;

    try {
        const result = await convertCriteriaWithProvider(
            'openrouter',
            {
                protocolText: 'protocol body',
                model: 'qwen/qwen3-235b-a22b-2507',
                temperature: 0,
                outputLanguage: 'ja',
            },
            { retryDelayMs: 0 }
        );
        assert.equal(result.criteria.template, 'pico');
        assert.equal(result.criteria.fields.P, '成人');
    } finally {
        globalThis.fetch = originalFetch;
        (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
        clearSessionOpenRouterApiKey();
    }
});

test('convertCriteriaWithProvider(openrouter) はリトライ上限後にエラーを投げる', async () => {
    installChromeI18nMock();
    setSessionOpenRouterApiKey('test-openrouter-key');

    let callCount = 0;
    const retryEvents: number[] = [];
    globalThis.fetch = (async () => {
        callCount += 1;
        return new Response('server error', { status: 500 });
    }) as typeof fetch;

    try {
        await assert.rejects(
            convertCriteriaWithProvider(
                'openrouter',
                {
                    protocolText: 'protocol body',
                    model: 'qwen/qwen3-235b-a22b-2507',
                    temperature: 0,
                    outputLanguage: 'ja',
                },
                {
                    maxRetries: 2,
                    retryDelayMs: 0,
                    onRetry: (attempt) => retryEvents.push(attempt),
                }
            )
        );
        // 初回 + リトライ 2 回 = 3 回
        assert.equal(callCount, 3);
        assert.deepEqual(retryEvents, [1, 2]);
    } finally {
        globalThis.fetch = originalFetch;
        (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
        clearSessionOpenRouterApiKey();
    }
});

// ===== convertCriteriaWithProvider / screenViaOpenAi (OpenAI Responses API 経路) =====

test('convertCriteriaWithProvider(openai) は OpenAI Responses API へ POST して結果を正規化する', async () => {
    setSessionOpenAiApiKey('test-openai-key');

    const criteriaPayload = {
        criteria: {
            template: 'peco',
            fields: {
                P: '成人喘息患者',
                E: '吸入ステロイド',
                C: null, // strict json_schema では未使用フィールドが null で返る想定
                O: 'QOL改善',
            },
        },
        screening_prompt: 'OpenAI スクリーニングプロンプト',
    };

    let requestUrl = '';
    let requestBodyText = '';
    let authHeader = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        requestBodyText = typeof init?.body === 'string' ? init.body : '';
        const headers = init?.headers as Record<string, string> | undefined;
        authHeader = headers?.['Authorization'] ?? '';
        return new Response(JSON.stringify({
            id: 'resp_1',
            model: 'gpt-5.6-terra',
            status: 'completed',
            output: [
                {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: JSON.stringify(criteriaPayload) }],
                },
            ],
            usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
        const result = await convertCriteriaWithProvider(
            'openai',
            {
                protocolText: 'protocol body',
                model: 'gpt-5.6-terra',
                temperature: 0,
                outputLanguage: 'ja',
            },
            { retryDelayMs: 0 }
        );

        assert.equal(requestUrl, 'https://api.openai.com/v1/responses');
        assert.ok(authHeader.startsWith('Bearer '), `Authorization ヘッダーが Bearer 形式であること: ${authHeader}`);

        const sentBody = JSON.parse(requestBodyText);
        assert.equal(sentBody.text.format.type, 'json_schema');
        assert.equal(sentBody.text.format.strict, true);
        assert.equal(sentBody.store, false);
        assert.equal('temperature' in sentBody, false, 'gpt-5.x reasoning モデルは temperature を送ると 400 になるため body に含めない');

        // null だった C フィールドは normalizeCriteriaConversionResult 経由で空文字に正規化される
        assert.deepEqual(result.criteria.fields, {
            P: '成人喘息患者',
            E: '吸入ステロイド',
            C: '',
            O: 'QOL改善',
        });
        assert.equal(result.screening_prompt, 'OpenAI スクリーニングプロンプト');
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenAiApiKey();
    }
});

test('screenViaOpenAi は completed レスポンスをパースして usageMetadata を変換する', async () => {
    setSessionOpenAiApiKey('test-openai-key');

    const screeningPayload = {
        include_probability: 0.8,
        reasons: ['介入と対象集団が一致する'],
        evidence: [
            { field: 'title', quote: 'asthma', start_char: 0, end_char: 6 },
        ],
    };

    globalThis.fetch = (async () => new Response(JSON.stringify({
        id: 'resp_2',
        model: 'gpt-5.6-terra',
        status: 'completed',
        output: [
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: JSON.stringify(screeningPayload) }],
            },
        ],
        usage: {
            input_tokens: 50,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens: 80,
            output_tokens_details: { reasoning_tokens: 15 },
            total_tokens: 130,
        },
    }), { status: 200 })) as typeof fetch;

    try {
        const result = await screenViaOpenAi({
            title: 'A randomized trial of inhaled steroids for asthma',
            abstract: 'RCT evaluating inhaled corticosteroids in adults with asthma.',
            screeningPrompt: 'Evaluate whether to include this study.',
            model: 'gpt-5.6-terra',
            temperature: 0,
            outputLanguage: 'en',
        });

        assert.deepEqual(result.output, screeningPayload);
        assert.deepEqual(result.usageMetadata, {
            promptTokenCount: 50,
            candidatesTokenCount: 80,
            thoughtsTokenCount: 15,
            totalTokenCount: 130,
            cachedInputTokens: 20,
        });
        assert.equal(result.responseMetadata.modelVersion, 'gpt-5.6-terra');
        assert.equal(result.responseMetadata.responseId, 'resp_2');
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenAiApiKey();
    }
});

test('screenViaOpenAi は max_output_tokens による打ち切りをリトライせず reject する', async () => {
    setSessionOpenAiApiKey('test-openai-key');

    let callCount = 0;
    globalThis.fetch = (async () => {
        callCount += 1;
        return new Response(JSON.stringify({
            id: 'resp_3',
            model: 'gpt-5.6-terra',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
            usage: {
                input_tokens: 5,
                output_tokens: 100,
                output_tokens_details: { reasoning_tokens: 100 },
                total_tokens: 105,
            },
        }), { status: 200 });
    }) as typeof fetch;

    try {
        await assert.rejects(
            screenViaOpenAi(
                {
                    title: 'title',
                    abstract: 'abstract',
                    screeningPrompt: 'prompt',
                    model: 'gpt-5.6-terra',
                    temperature: 0,
                    outputLanguage: 'en',
                },
                2,    // maxRetries
                5000  // timeoutMs
            )
        );
        // retryable:false のため即座に投げられ、fetch は1回しか呼ばれない
        assert.equal(callCount, 1);
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenAiApiKey();
    }
});

// ===== _toStrictSchemaForTest (Gemini responseSchema → OpenAI strict json_schema 変換) =====

interface TestSchemaNode {
    type?: string | string[];
    properties?: Record<string, TestSchemaNode>;
    required?: string[];
    items?: TestSchemaNode;
    additionalProperties?: boolean;
}

test('_toStrictSchemaForTest は optional プロパティを nullable required に変換する', () => {
    const schema: TestSchemaNode = {
        type: 'object',
        properties: {
            a: { type: 'string' },
            b: { type: 'number' },
        },
        required: ['a'],
    };

    const strict = _toStrictSchemaForTest(schema);

    assert.equal(strict.additionalProperties, false);
    assert.deepEqual(strict.required, ['a', 'b']);
    // 元々 required だった a はそのまま string 型を維持
    assert.equal(strict.properties!.a.type, 'string');
    // 元々 optional だった b は required 化されつつ null を許容する
    assert.deepEqual(strict.properties!.b.type, ['number', 'null']);
});

test('_toStrictSchemaForTest は items / ネストした object も再帰的に変換する', () => {
    const nestedSchema: TestSchemaNode = {
        type: 'object',
        properties: {
            list: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        x: { type: 'string' },
                        y: { type: 'number' },
                    },
                    required: ['x'],
                },
            },
        },
        required: ['list'],
    };

    const strict = _toStrictSchemaForTest(nestedSchema);

    assert.equal(strict.additionalProperties, false);
    assert.deepEqual(strict.required, ['list']);

    const items = strict.properties!.list.items!;
    assert.equal(items.additionalProperties, false);
    assert.deepEqual(items.required, ['x', 'y']);
    assert.equal(items.properties!.x.type, 'string');
    assert.deepEqual(items.properties!.y.type, ['number', 'null']);
});
