/**
 * API キー保存の互換テスト
 *
 * chrome.storage.local の保存キー名・暗号文の形式・優先順位（セッション > 環境変数 > 保存値）を固定する。
 * 保存キー名を変えると既存利用者の保存済みキーが読めなくなるため、名前つき関数の公開名も含めて検査する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/lib/storage';

const originalChrome = globalThis.chrome;

interface StorageState { [key: string]: unknown }

function installChromeStorageMock(): StorageState {
    const state: StorageState = {};
    const pick = (keys: string | string[] | null | undefined): StorageState => {
        if (keys == null) return { ...state };
        const list = Array.isArray(keys) ? keys : [keys];
        const out: StorageState = {};
        for (const k of list) {
            if (k in state) out[k] = state[k];
        }
        return out;
    };
    (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
        runtime: { id: 'test-extension-id' },
        storage: {
            local: {
                get: async (keys?: string | string[] | null) => pick(keys),
                set: async (items: StorageState) => { Object.assign(state, items); },
                remove: async (keys: string | string[]) => {
                    for (const k of Array.isArray(keys) ? keys : [keys]) delete state[k];
                },
            },
        },
    } as unknown as typeof chrome;
    return state;
}

function restoreChrome(): void {
    (globalThis as typeof globalThis & { chrome: typeof chrome | undefined }).chrome = originalChrome;
}

interface ProviderCase {
    id: string;
    storageKey: string;
    prefKey: string;
    envVar: string;
    save: (k: string) => Promise<void>;
    get: () => Promise<string | null>;
    remove: () => Promise<void>;
    has: () => Promise<boolean>;
    setPref: (b: boolean) => Promise<void>;
    getPref: () => Promise<boolean>;
    setSession: (k: string) => void;
    getSession: () => string | null;
    clearSession: () => void;
    getEffective: () => Promise<string | null>;
}

const cases: ProviderCase[] = [
    {
        id: 'gemini', storageKey: 'gemini_api_key', prefKey: 'gemini_api_key_save_preference', envVar: 'GEMINI_API_KEY',
        save: storage.saveGeminiApiKey, get: storage.getGeminiApiKey, remove: storage.removeGeminiApiKey,
        has: storage.hasGeminiApiKey, setPref: storage.setApiKeySavePreference, getPref: storage.getApiKeySavePreference,
        setSession: storage.setSessionApiKey, getSession: storage.getSessionApiKey, clearSession: storage.clearSessionApiKey,
        getEffective: storage.getEffectiveApiKey,
    },
    {
        id: 'openrouter', storageKey: 'openrouter_api_key', prefKey: 'openrouter_api_key_save_preference', envVar: 'OPENROUTER_API_KEY',
        save: storage.saveOpenRouterApiKey, get: storage.getOpenRouterApiKey, remove: storage.removeOpenRouterApiKey,
        has: storage.hasOpenRouterApiKey, setPref: storage.setOpenRouterApiKeySavePreference,
        getPref: storage.getOpenRouterApiKeySavePreference,
        setSession: storage.setSessionOpenRouterApiKey, getSession: storage.getSessionOpenRouterApiKey,
        clearSession: storage.clearSessionOpenRouterApiKey, getEffective: storage.getEffectiveOpenRouterApiKey,
    },
    {
        id: 'openai', storageKey: 'openai_api_key', prefKey: 'openai_api_key_save_preference', envVar: 'OPENAI_API_KEY',
        save: storage.saveOpenAiApiKey, get: storage.getOpenAiApiKey, remove: storage.removeOpenAiApiKey,
        has: storage.hasOpenAiApiKey, setPref: storage.setOpenAiApiKeySavePreference,
        getPref: storage.getOpenAiApiKeySavePreference,
        setSession: storage.setSessionOpenAiApiKey, getSession: storage.getSessionOpenAiApiKey,
        clearSession: storage.clearSessionOpenAiApiKey, getEffective: storage.getEffectiveOpenAiApiKey,
    },
    {
        id: 'anthropic', storageKey: 'anthropic_api_key', prefKey: 'anthropic_api_key_save_preference', envVar: 'ANTHROPIC_API_KEY',
        save: storage.saveAnthropicApiKey, get: storage.getAnthropicApiKey, remove: storage.removeAnthropicApiKey,
        has: storage.hasAnthropicApiKey, setPref: storage.setAnthropicApiKeySavePreference,
        getPref: storage.getAnthropicApiKeySavePreference,
        setSession: storage.setSessionAnthropicApiKey, getSession: storage.getSessionAnthropicApiKey,
        clearSession: storage.clearSessionAnthropicApiKey, getEffective: storage.getEffectiveAnthropicApiKey,
    },
    {
        id: 'typesafe', storageKey: 'typesafe_api_key', prefKey: 'typesafe_api_key_save_preference', envVar: 'TYPE_SAFE_API_KEY',
        save: storage.saveTypeSafeApiKey, get: storage.getTypeSafeApiKey, remove: storage.removeTypeSafeApiKey,
        has: storage.hasTypeSafeApiKey, setPref: storage.setTypeSafeApiKeySavePreference,
        getPref: storage.getTypeSafeApiKeySavePreference,
        setSession: storage.setSessionTypeSafeApiKey, getSession: storage.getSessionTypeSafeApiKey,
        clearSession: storage.clearSessionTypeSafeApiKey, getEffective: storage.getEffectiveTypeSafeApiKey,
    },
];

async function withEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
        await fn();
    } finally {
        if (prev === undefined) delete process.env[name];
        else process.env[name] = prev;
    }
}

for (const c of cases) {
    test(`api-key-store(${c.id}): 保存は保存キー名に暗号文（v:1/iv/data）で入り、平文を含まない`, async () => {
        const state = installChromeStorageMock();
        try {
            await c.save('plain-secret-key');
            const stored = state[c.storageKey];
            assert.equal(typeof stored, 'string');
            const parsed = JSON.parse(stored as string) as { v: number; iv: string; data: string };
            assert.equal(parsed.v, 1);
            assert.ok(parsed.iv);
            assert.ok(parsed.data);
            assert.ok(!(stored as string).includes('plain-secret-key'));
        } finally {
            restoreChrome();
        }
    });

    test(`api-key-store(${c.id}): get/has/remove の往復`, async () => {
        installChromeStorageMock();
        try {
            assert.equal(await c.get(), null);
            assert.equal(await c.has(), false);
            await c.save('round-trip-key');
            assert.equal(await c.get(), 'round-trip-key');
            assert.equal(await c.has(), true);
            await c.remove();
            assert.equal(await c.get(), null);
            assert.equal(await c.has(), false);
        } finally {
            restoreChrome();
        }
    });

    test(`api-key-store(${c.id}): 壊れた保存値は例外にせず null`, async () => {
        const state = installChromeStorageMock();
        try {
            state[c.storageKey] = 'not-json';
            assert.equal(await c.get(), null);
            assert.equal(await c.has(), false);
        } finally {
            restoreChrome();
        }
    });

    test(`api-key-store(${c.id}): 保存設定は既定 false、true を保存設定のキーへ入れる`, async () => {
        const state = installChromeStorageMock();
        try {
            assert.equal(await c.getPref(), false);
            await c.setPref(true);
            assert.equal(await c.getPref(), true);
            assert.equal(state[c.prefKey], true);
            await c.setPref(false);
            assert.equal(await c.getPref(), false);
        } finally {
            restoreChrome();
        }
    });

    test(`api-key-store(${c.id}): 有効なキーの優先順位は セッション > 環境変数 > 保存値`, async () => {
        installChromeStorageMock();
        c.clearSession();
        try {
            await withEnv(c.envVar, undefined, async () => {
                assert.equal(await c.getEffective(), null);
                await c.save('stored-key');
                assert.equal(await c.getEffective(), 'stored-key');
            });
            await withEnv(c.envVar, 'env-key', async () => {
                assert.equal(await c.getEffective(), 'env-key');
                c.setSession('session-key');
                assert.equal(c.getSession(), 'session-key');
                assert.equal(await c.getEffective(), 'session-key');
                c.clearSession();
                assert.equal(c.getSession(), null);
                assert.equal(await c.getEffective(), 'env-key');
            });
        } finally {
            c.clearSession();
            restoreChrome();
        }
    });
}

test('api-key-store: セッションのキーはプロバイダ間で混ざらない', () => {
    for (const c of cases) c.clearSession();
    try {
        for (const target of cases) {
            target.setSession(`session-${target.id}`);
            for (const other of cases) {
                assert.equal(other.getSession(), other === target ? `session-${target.id}` : null);
            }
            target.clearSession();
        }
    } finally {
        for (const c of cases) c.clearSession();
    }
});

test('api-key-store: ソルトは gemini_api_key_salt に1つだけ作られ全プロバイダで共用される', async () => {
    const state = installChromeStorageMock();
    try {
        await cases[0].save('first');
        const salt = state['gemini_api_key_salt'];
        assert.equal(typeof salt, 'string');
        for (const c of cases) await c.save(`key-${c.id}`);
        assert.equal(state['gemini_api_key_salt'], salt);
        assert.deepEqual(Object.keys(state).filter(k => k.includes('salt')), ['gemini_api_key_salt']);
        for (const c of cases) assert.equal(await c.get(), `key-${c.id}`);
    } finally {
        restoreChrome();
    }
});

test('api-key-store: 既存の名前つき関数50個が storage から export されている', () => {
    const names = [
        'saveGeminiApiKey', 'getGeminiApiKey', 'removeGeminiApiKey', 'hasGeminiApiKey',
        'setApiKeySavePreference', 'getApiKeySavePreference',
        'setSessionApiKey', 'getSessionApiKey', 'clearSessionApiKey', 'getEffectiveApiKey',
    ];
    for (const p of ['OpenRouter', 'OpenAi', 'Anthropic', 'TypeSafe']) {
        names.push(
            `save${p}ApiKey`, `get${p}ApiKey`, `remove${p}ApiKey`, `has${p}ApiKey`,
            `set${p}ApiKeySavePreference`, `get${p}ApiKeySavePreference`,
            `setSession${p}ApiKey`, `getSession${p}ApiKey`, `clearSession${p}ApiKey`, `getEffective${p}ApiKey`,
        );
    }
    assert.equal(names.length, 50);
    const mod = storage as unknown as Record<string, unknown>;
    for (const n of names) assert.equal(typeof mod[n], 'function', n);
});
