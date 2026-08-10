import test from 'node:test';
import assert from 'node:assert/strict';

type StorageValues = Record<string, unknown>;

function createStorageArea(initial: StorageValues = {}) {
    const values: StorageValues = { ...initial };
    return {
        values,
        async get(keys: string | string[]) {
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.map((key) => [key, values[key]]));
        },
        async set(items: StorageValues) {
            Object.assign(values, items);
        },
        async remove(keys: string | string[]) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
        },
    };
}

const session = createStorageArea();
const local = createStorageArea();
const launchedUrls: string[] = [];
let redirectUrl = '';

// クライアントID未設定ガードのエラーメッセージ（テスト用固定値）。
// 実際の chrome.i18n.getMessage は拡張パッケージングされた _locales を読むが、
// このテストでは auth_clientIdMissing キーだけを解決するモックで代替する。
const CLIENT_ID_MISSING_MESSAGE = 'テスト用: OAuthクライアントIDが未設定です';

Object.assign(globalThis, {
    __EXTENSION_OAUTH_CLIENT_ID__: 'client-id.apps.googleusercontent.com',
    chrome: {
        identity: {
            getRedirectURL: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
            launchWebAuthFlow: async ({ url }: { url: string }) => {
                launchedUrls.push(url);
                return redirectUrl;
            },
        },
        storage: { session, local },
        i18n: {
            getMessage: (key: string) => (key === 'auth_clientIdMissing' ? CLIENT_ID_MISSING_MESSAGE : ''),
        },
    },
});

const originalFetch = globalThis.fetch;

test.beforeEach(() => {
    for (const key of Object.keys(session.values)) delete session.values[key];
    for (const key of Object.keys(local.values)) delete local.values[key];
    launchedUrls.length = 0;
    redirectUrl = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/#access_token=test-token&expires_in=3600';
    globalThis.fetch = async () => new Response(JSON.stringify({ email: 'reviewer@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
});

test.after(() => {
    globalThis.fetch = originalFetch;
});

test('永続化したメールを Chrome 再起動後のサイレント認証に使う', async () => {
    local.values.oauthEmail = 'reviewer@example.com';
    const { getAuthToken } = await import('../src/background/auth-flow');

    const token = await getAuthToken(false);

    assert.equal(token, 'test-token');
    assert.equal(launchedUrls.length, 1);
    const authUrl = new URL(launchedUrls[0]);
    assert.equal(authUrl.searchParams.get('prompt'), 'none');
    assert.equal(authUrl.searchParams.get('login_hint'), 'reviewer@example.com');
    const cached = session.values.oauthToken as { token: string; expiresAt: number };
    assert.equal(cached.token, 'test-token');
    assert.ok(cached.expiresAt > Date.now());
    assert.equal(session.values.oauthEmail, undefined);
});

test('初回認証後はトークンを session、メールだけを local に保存する', async () => {
    const { getAuthToken } = await import('../src/background/auth-flow');

    await getAuthToken(false);

    assert.equal((session.values.oauthToken as { token: string }).token, 'test-token');
    assert.equal(local.values.oauthEmail, 'reviewer@example.com');
    assert.equal(local.values.oauthToken, undefined);
    assert.equal(session.values.oauthEmail, undefined);
});

test('旧 session のメールを local へ移行してサイレント認証に使う', async () => {
    session.values.oauthEmail = 'legacy@example.com';
    const { getAuthToken } = await import('../src/background/auth-flow');

    await getAuthToken(false);

    const authUrl = new URL(launchedUrls[0]);
    assert.equal(authUrl.searchParams.get('login_hint'), 'legacy@example.com');
    assert.equal(local.values.oauthEmail, 'legacy@example.com');
    assert.equal(session.values.oauthEmail, undefined);
});

test('有効なトークンがキャッシュ済みでも旧 session のメールを local へ移行する', async () => {
    session.values.oauthToken = { token: 'cached-token', expiresAt: Date.now() + 3_600_000 };
    session.values.oauthEmail = 'legacy@example.com';
    const { getAuthToken } = await import('../src/background/auth-flow');

    const token = await getAuthToken(false);

    assert.equal(token, 'cached-token');
    assert.equal(launchedUrls.length, 0); // トークンがキャッシュヒットしたので認可フローは起動しない
    assert.equal(local.values.oauthEmail, 'legacy@example.com');
    assert.equal(session.values.oauthEmail, undefined);
});

test('ログアウト時は session のトークンと local のメールを削除する', async () => {
    session.values.oauthToken = { token: 'test-token', expiresAt: Date.now() + 3_600_000 };
    local.values.oauthEmail = 'reviewer@example.com';
    const { clearAuth } = await import('../src/background/auth-flow');

    await clearAuth();

    assert.equal(session.values.oauthToken, undefined);
    assert.equal(local.values.oauthEmail, undefined);
});

test('クライアントID未設定時は launchWebAuthFlow を呼ぶ前にガードが停止する（interactive=true）', async () => {
    // このテストだけ一時的に空へ差し替え、他のテストへ漏らさないよう finally で必ず戻す。
    const original = (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__;
    (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__ = '';
    try {
        const { getAuthToken } = await import('../src/background/auth-flow');

        await assert.rejects(
            () => getAuthToken(true),
            (error: Error) => {
                assert.equal(error.message, CLIENT_ID_MISSING_MESSAGE);
                return true;
            }
        );
        // client_id が空のまま Google 側へ投げる（= launchWebAuthFlow を呼ぶ）前に止まっていること
        assert.equal(launchedUrls.length, 0);
    } finally {
        (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__ = original;
    }
});

test('クライアントID未設定時はサイレント認証（interactive=false）も launchWebAuthFlow を呼ばずに失敗する', async () => {
    const original = (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__;
    (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__ = '';
    try {
        const { getAuthToken } = await import('../src/background/auth-flow');

        // 呼び出し元（初期化時のサイレント試行など）は「未ログイン」として握り潰す設計のため、
        // interactive=false では既存仕様どおり汎用の interaction_required に丸められる
        // （ガードのメッセージ自体はここでは呼び出し元に届かない。詳細は実装報告を参照）。
        await assert.rejects(() => getAuthToken(false), /interaction_required/);
        assert.equal(launchedUrls.length, 0);
    } finally {
        (globalThis as { __EXTENSION_OAUTH_CLIENT_ID__?: string }).__EXTENSION_OAUTH_CLIENT_ID__ = original;
    }
});
