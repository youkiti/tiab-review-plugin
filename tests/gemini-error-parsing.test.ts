// gemini-error-parsing.test.ts
// 429 適応スロットリングの前提となる Gemini エラーボディ解析の回帰テスト。
// streamGenerateContent は配列 `[{"error":{...}}]` でエラーを返すため、
// 旧実装 (`errorData.error?.message` 決め打ち) では常に undefined になり、
// statusText ("Too Many Requests") しか残らずクォータ情報・待機時間を全て捨てていた。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiErrorPayload, GeminiApiError, callGeminiApiWithParts } from '../src/lib/gemini-api';
import { clearSessionApiKey, setSessionApiKey } from '../src/lib/storage';

const RETRY_INFO_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';
const QUOTA_FAILURE_TYPE = 'type.googleapis.com/google.rpc.QuotaFailure';

/** 実際に観測された 429 エラーボディ (brief 記載のサンプル) を模して組み立てる */
function buildQuotaExceededError(opts: { retryDelay?: string; quotaId?: string } = {}): { error: unknown } {
    const details: unknown[] = [
        { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
    ];
    if (opts.quotaId) {
        details.push({
            '@type': QUOTA_FAILURE_TYPE,
            violations: [{
                quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                quotaId: opts.quotaId,
                quotaDimensions: { location: 'global', model: 'gemini-3.1-flash-lite' },
                quotaValue: '15',
            }],
        });
    }
    if (opts.retryDelay) {
        details.push({ '@type': RETRY_INFO_TYPE, retryDelay: opts.retryDelay });
    }
    return {
        error: {
            code: 429,
            message:
                'You exceeded your current quota, please check your plan and billing details.\n'
                + '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.1-flash-lite\n'
                + 'Please retry in 8.710506329s.',
            status: 'RESOURCE_EXHAUSTED',
            details,
        },
    };
}

// ===== parseGeminiErrorPayload (純関数) =====

test('parseGeminiErrorPayload: 配列形式 (streamGenerateContent の実際の形) から RetryInfo/QuotaFailure を抽出する', () => {
    const body = [buildQuotaExceededError({ retryDelay: '8s', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' })];
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.retryAfterMs, 8000);
    assert.equal(parsed.quotaId, 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
    assert.equal(parsed.isFreeTierQuota, true);
    assert.ok(parsed.message?.startsWith('You exceeded your current quota'));
});

test('parseGeminiErrorPayload: オブジェクト形式 {"error":{...}} でも同様に抽出する', () => {
    const body = buildQuotaExceededError({ retryDelay: '8.7s', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' });
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.retryAfterMs, 8700);
    assert.equal(parsed.isFreeTierQuota, true);
});

test('parseGeminiErrorPayload: RetryInfo が無ければ message 内の "Please retry in Ns" から抽出する', () => {
    const body = {
        error: {
            code: 429,
            message: 'You exceeded your current quota.\nPlease retry in 8.710506329s.',
            status: 'RESOURCE_EXHAUSTED',
            details: [],
        },
    };
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.retryAfterMs, 8711); // Math.round(8.710506329 * 1000)
});

test('parseGeminiErrorPayload: RetryInfo が details にあれば message 内の記載より優先する', () => {
    const body = {
        error: {
            code: 429,
            message: 'Please retry in 99s.', // details と矛盾する値。details 側が優先されるべき
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': RETRY_INFO_TYPE, retryDelay: '8s' }],
        },
    };
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.retryAfterMs, 8000);
});

test('parseGeminiErrorPayload: RetryInfo も message 内の記載も無ければ retryAfterMs は undefined（0 にしない）', () => {
    const body = { error: { code: 403, message: 'Forbidden', status: 'PERMISSION_DENIED', details: [] } };
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.retryAfterMs, undefined);
});

test('parseGeminiErrorPayload: quotaId に FreeTier を含まなければ isFreeTierQuota は false', () => {
    const body = buildQuotaExceededError({ retryDelay: '8s', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' });
    const parsed = parseGeminiErrorPayload(body);
    assert.equal(parsed.isFreeTierQuota, false);
    assert.equal(parsed.quotaId, 'GenerateRequestsPerMinutePerProjectPerModel');
});

test('parseGeminiErrorPayload: 壊れたボディ・空ボディでも例外を投げず、フィールドは undefined/false になる', () => {
    const brokenBodies: unknown[] = [
        undefined, null, {}, [], 'not-json-object', 42,
        { error: null }, [{}], [{ error: 'string-not-object' }], [{ error: { details: 'not-an-array' } }],
    ];
    for (const body of brokenBodies) {
        assert.doesNotThrow(() => parseGeminiErrorPayload(body));
        const parsed = parseGeminiErrorPayload(body);
        assert.equal(parsed.message, undefined, `message for ${JSON.stringify(body)}`);
        assert.equal(parsed.retryAfterMs, undefined, `retryAfterMs for ${JSON.stringify(body)}`);
        assert.equal(parsed.quotaId, undefined, `quotaId for ${JSON.stringify(body)}`);
        assert.equal(parsed.isFreeTierQuota, false, `isFreeTierQuota for ${JSON.stringify(body)}`);
    }
});

test('parseGeminiErrorPayload: message は1行目相当のみを返す（複数行の詳細・待機時間の文言は含めない）', () => {
    const body = buildQuotaExceededError({ retryDelay: '8s' });
    const parsed = parseGeminiErrorPayload(body);
    assert.ok(parsed.message);
    assert.ok(!parsed.message!.includes('\n'));
    assert.ok(!parsed.message!.includes('Please retry in'));
});

// ===== callGeminiApiWithParts 経由の統合確認 (GeminiApiError に反映されること) =====

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

test.beforeEach(() => {
    installChromeI18nMock();
    setSessionApiKey('test-api-key');
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
    clearSessionApiKey();
});

test('callGeminiApiWithParts: streamGenerateContent の 429 配列ボディから GeminiApiError.retryAfterMs / isFreeTierQuota を復元する（実バグの回帰テスト）', async () => {
    const body = [buildQuotaExceededError({ retryDelay: '8s', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' })];
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    await assert.rejects(
        callGeminiApiWithParts([{ text: 'x' }], {}, { model: 'gemini-3.1-flash-lite', temperature: 0 }),
        (err: unknown) => {
            assert.ok(err instanceof GeminiApiError);
            const geminiErr = err as GeminiApiError;
            assert.equal(geminiErr.status, 429);
            assert.equal(geminiErr.retryable, true); // 429 は従来どおり retryable
            assert.equal(geminiErr.retryAfterMs, 8000);
            assert.equal(geminiErr.isFreeTierQuota, true);
            assert.equal(geminiErr.quotaId, 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier');
            return true;
        }
    );
});

test('callGeminiApiWithParts: 壊れたエラーボディでも例外を投げずに GeminiApiError へフォールバックし、構造化フィールドは undefined/false になる', async () => {
    // 注: t() の substitution (statusText へのフォールバック文言) は、テスト環境では
    // platform() 未初期化 (setPlatform() 未呼び出し) のため常にキー名のみへフォールバックし
    // 検証できない（criteria-conversion.test.ts 等、既存テストも同じ理由で message 内容は見ていない）。
    // ここでは実際に効く構造化フィールド（retryAfterMs/isFreeTierQuota）のフォールバックを検証する。
    globalThis.fetch = (async () => new Response('not-json', {
        status: 429,
        statusText: 'Too Many Requests',
    })) as typeof fetch;

    await assert.rejects(
        callGeminiApiWithParts([{ text: 'x' }], {}, { model: 'gemini-3.1-flash-lite', temperature: 0 }),
        (err: unknown) => {
            assert.ok(err instanceof GeminiApiError);
            const geminiErr = err as GeminiApiError;
            assert.equal(geminiErr.status, 429);
            assert.equal(geminiErr.retryable, true);
            assert.equal(geminiErr.retryAfterMs, undefined);
            assert.equal(geminiErr.quotaId, undefined);
            assert.equal(geminiErr.isFreeTierQuota, false);
            return true;
        }
    );
});

test('callGeminiApiWithParts: 429 以外 (500) でも retryAfterMs が取れれば反映される（RetryInfo は 429 専用ではない）', async () => {
    const body = {
        error: {
            code: 500,
            message: 'Internal error. Please retry in 2s.',
            status: 'INTERNAL',
            details: [{ '@type': RETRY_INFO_TYPE, retryDelay: '2s' }],
        },
    };
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    await assert.rejects(
        callGeminiApiWithParts([{ text: 'x' }], {}, { model: 'gemini-3.1-flash-lite', temperature: 0 }),
        (err: unknown) => {
            assert.ok(err instanceof GeminiApiError);
            const geminiErr = err as GeminiApiError;
            assert.equal(geminiErr.status, 500);
            assert.equal(geminiErr.retryable, true); // 5xx も従来どおり retryable
            assert.equal(geminiErr.retryAfterMs, 2000);
            return true;
        }
    );
});
