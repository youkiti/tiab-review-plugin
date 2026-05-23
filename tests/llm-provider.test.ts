import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderId, convertCriteriaWithProvider } from '../src/lib/llm-provider';
import { setSessionOpenRouterApiKey, clearSessionOpenRouterApiKey } from '../src/lib/storage';

const models = [
    { id: 'gemini-3.1-flash-lite', provider: 'gemini' as const },
    { id: 'gemini-3-flash-preview', provider: 'gemini' as const },
    { id: 'qwen/qwen3-235b-a22b-2507', provider: 'openrouter' as const },
    { id: 'deepseek/deepseek-v4-flash', provider: 'openrouter' as const },
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
