/**
 * OpenRouter カスタムモデル機能のテスト
 *
 * - storage CRUD (add/get/remove)
 * - 上限・重複・形式バリデーション
 * - getAllAvailableModels によるビルトイン + カスタムの合成
 * - testOpenRouterModel の成功/失敗判定
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addCustomOpenRouterModel,
    getCustomOpenRouterModels,
    removeCustomOpenRouterModel,
    setSessionOpenRouterApiKey,
    clearSessionOpenRouterApiKey,
    OPENROUTER_CUSTOM_MODELS_LIMIT,
} from '../src/lib/storage';
import { getAllAvailableModels, AVAILABLE_MODELS } from '../src/lib/gemini-api';
import { testOpenRouterModel, _sanitizeApiKeyForTest } from '../src/lib/providers/openrouter';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

interface StorageState { [key: string]: unknown }

function installChromeStorageMock(initial: StorageState = {}): StorageState {
    const state: StorageState = { ...initial };
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
        i18n: {
            getMessage: (key: string, substitutions?: string | string[]) => {
                if (!substitutions) return key;
                const values = Array.isArray(substitutions) ? substitutions : [substitutions];
                return `${key}: ${values.join(',')}`;
            },
        },
        storage: {
            local: {
                async get(keys: string | string[] | null) {
                    const list = keys === null
                        ? Object.keys(state)
                        : typeof keys === 'string'
                            ? [keys]
                            : keys;
                    const out: StorageState = {};
                    for (const k of list) {
                        if (k in state) out[k] = state[k];
                    }
                    return out;
                },
                async set(items: StorageState) {
                    for (const [k, v] of Object.entries(items)) state[k] = v;
                },
                async remove(keys: string | string[]) {
                    const list = typeof keys === 'string' ? [keys] : keys;
                    for (const k of list) delete state[k];
                },
            },
        },
    } as unknown as typeof chrome;
    return state;
}

function restoreChrome(): void {
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = originalChrome;
}

// ===== storage CRUD =====

test('addCustomOpenRouterModel: 空 ID は invalid', async () => {
    installChromeStorageMock();
    try {
        const result = await addCustomOpenRouterModel({ id: '' });
        assert.deepEqual(result, { added: false, reason: 'invalid' });
    } finally {
        restoreChrome();
    }
});

test('addCustomOpenRouterModel: 正常追加で永続化され getCustomOpenRouterModels から取得できる', async () => {
    installChromeStorageMock();
    try {
        const result = await addCustomOpenRouterModel({
            id: 'anthropic/claude-3.7-sonnet',
            label: 'Claude 3.7',
        });
        assert.deepEqual(result, { added: true });

        const list = await getCustomOpenRouterModels();
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 'anthropic/claude-3.7-sonnet');
        assert.equal(list[0].label, 'Claude 3.7');
        assert.ok(list[0].addedAt);
    } finally {
        restoreChrome();
    }
});

test('addCustomOpenRouterModel: 同一IDの再追加は duplicate', async () => {
    installChromeStorageMock();
    try {
        await addCustomOpenRouterModel({ id: 'anthropic/claude-3.7-sonnet' });
        const result = await addCustomOpenRouterModel({ id: 'anthropic/claude-3.7-sonnet' });
        assert.deepEqual(result, { added: false, reason: 'duplicate' });
    } finally {
        restoreChrome();
    }
});

test('addCustomOpenRouterModel: 上限到達後の追加は limit', async () => {
    installChromeStorageMock();
    try {
        for (let i = 0; i < OPENROUTER_CUSTOM_MODELS_LIMIT; i++) {
            await addCustomOpenRouterModel({ id: `vendor-${i}/model-${i}` });
        }
        const result = await addCustomOpenRouterModel({ id: 'overflow/model' });
        assert.deepEqual(result, { added: false, reason: 'limit' });
    } finally {
        restoreChrome();
    }
});

test('removeCustomOpenRouterModel: 指定 ID のみ削除される', async () => {
    installChromeStorageMock();
    try {
        await addCustomOpenRouterModel({ id: 'a/x' });
        await addCustomOpenRouterModel({ id: 'b/y' });
        await removeCustomOpenRouterModel('a/x');
        const list = await getCustomOpenRouterModels();
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 'b/y');
    } finally {
        restoreChrome();
    }
});

test('getCustomOpenRouterModels: 不正な保存値は除外される', async () => {
    installChromeStorageMock({
        openrouter_custom_models: [
            { id: 'valid/model', addedAt: '2026-01-01T00:00:00Z' },
            { id: '' },              // 空 ID
            { foo: 'bar' },          // id 欠落
            'not-an-object',         // 型違反
        ],
    });
    try {
        const list = await getCustomOpenRouterModels();
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 'valid/model');
    } finally {
        restoreChrome();
    }
});

// ===== getAllAvailableModels =====

test('getAllAvailableModels: ビルトインのみのときは AVAILABLE_MODELS と同じ', async () => {
    installChromeStorageMock();
    try {
        const all = await getAllAvailableModels();
        assert.equal(all.length, AVAILABLE_MODELS.length);
        for (let i = 0; i < AVAILABLE_MODELS.length; i++) {
            assert.equal(all[i].id, AVAILABLE_MODELS[i].id);
            assert.notEqual((all[i] as { custom?: boolean }).custom, true);
        }
    } finally {
        restoreChrome();
    }
});

test('getAllAvailableModels: カスタムモデルは末尾に custom:true で追加される', async () => {
    installChromeStorageMock();
    try {
        await addCustomOpenRouterModel({ id: 'anthropic/claude-3.7-sonnet', label: 'Claude 3.7' });
        const all = await getAllAvailableModels();
        const custom = all.find(m => m.id === 'anthropic/claude-3.7-sonnet');
        assert.ok(custom, 'カスタムモデルが含まれること');
        assert.equal(custom!.provider, 'openrouter');
        assert.equal((custom as { custom?: boolean }).custom, true);
        // label 付きの場合は "label (id)" 形式の name
        assert.ok(custom!.name.includes('Claude 3.7'));
        assert.ok(custom!.name.includes('anthropic/claude-3.7-sonnet'));
    } finally {
        restoreChrome();
    }
});

test('getAllAvailableModels: ビルトイン ID と重複するカスタムは無視される', async () => {
    installChromeStorageMock();
    try {
        // qwen/qwen3-235b-a22b-2507 はビルトイン
        await addCustomOpenRouterModel({ id: 'qwen/qwen3-235b-a22b-2507' });
        const all = await getAllAvailableModels();
        // ビルトイン数だけ存在し、custom:true のものは無いこと
        const matchingId = all.filter(m => m.id === 'qwen/qwen3-235b-a22b-2507');
        assert.equal(matchingId.length, 1);
        assert.notEqual((matchingId[0] as { custom?: boolean }).custom, true);
    } finally {
        restoreChrome();
    }
});

// ===== testOpenRouterModel =====

test('testOpenRouterModel: JSON が返れば ok:true', async () => {
    installChromeStorageMock();
    setSessionOpenRouterApiKey('test-key');
    const successPayload = {
        include_probability: 0.5,
        reasons: ['test'],
        evidence: [],
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(successPayload) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        model: 'foo/bar',
    }), { status: 200 })) as typeof fetch;

    try {
        const result = await testOpenRouterModel('foo/bar', 5000);
        assert.equal(result.ok, true);
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenRouterApiKey();
        restoreChrome();
    }
});

test('testOpenRouterModel: API キー未設定なら ok:false', async () => {
    installChromeStorageMock();
    clearSessionOpenRouterApiKey();
    // process.env からも来ないようにする
    const originalEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
        const result = await testOpenRouterModel('foo/bar', 5000);
        assert.equal(result.ok, false);
        assert.ok(result.error);
    } finally {
        if (originalEnv !== undefined) process.env.OPENROUTER_API_KEY = originalEnv;
        restoreChrome();
    }
});

test('testOpenRouterModel: HTTP エラー応答は ok:false でエラー詳細を返す', async () => {
    installChromeStorageMock();
    setSessionOpenRouterApiKey('test-key');
    globalThis.fetch = (async () =>
        new Response('Model not found', { status: 404 })
    ) as typeof fetch;

    try {
        const result = await testOpenRouterModel('nonexistent/model', 5000);
        assert.equal(result.ok, false);
        assert.ok(result.error && result.error.includes('404'));
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenRouterApiKey();
        restoreChrome();
    }
});

// ===== sanitizeApiKey =====

test('sanitizeApiKey: 通常ASCII キーはそのまま通る', () => {
    const key = 'sk-or-v1-abc123XYZ_-=';
    assert.equal(_sanitizeApiKeyForTest(key), key);
});

test('sanitizeApiKey: 前後空白を除去', () => {
    assert.equal(_sanitizeApiKeyForTest('  sk-or-v1-abc  '), 'sk-or-v1-abc');
});

test('sanitizeApiKey: ZWSP / BOM / NBSP を除去', () => {
    const dirty = '​sk‌-or‍-v1⁠-﻿abc ';
    assert.equal(_sanitizeApiKeyForTest(dirty), 'sk-or-v1-abc');
});

test('sanitizeApiKey: ISO-8859-1 範囲外（全角文字）は例外', () => {
    assert.throws(() => _sanitizeApiKeyForTest('sk-or-v1-ｘｘｘ'), /ISO-8859-1/);
});

test('sanitizeApiKey: 日本語が混入したキーも例外', () => {
    assert.throws(() => _sanitizeApiKeyForTest('sk-or-v1-あいう'), /ISO-8859-1/);
});

test('testOpenRouterModel: JSON 不正応答は ok:false', async () => {
    installChromeStorageMock();
    setSessionOpenRouterApiKey('test-key');
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({
            choices: [{ message: { content: 'これはJSONではない普通の文章です。' } }],
        }), { status: 200 })
    ) as typeof fetch;

    try {
        const result = await testOpenRouterModel('foo/bar', 5000);
        assert.equal(result.ok, false);
    } finally {
        globalThis.fetch = originalFetch;
        clearSessionOpenRouterApiKey();
        restoreChrome();
    }
});
