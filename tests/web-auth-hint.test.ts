import test from 'node:test';
import assert from 'node:assert/strict';

// setAuthHint() が GIS の requestAccessToken() へ login_hint として渡ることの検証。
// tests/web-auth.test.ts とはグローバル設定（__WEB_OAUTH_CLIENT_ID__ / google）が衝突するため
// 別ファイルに分ける（node --test はファイルごとに別プロセスなので問題ない）。
//
// google.accounts.oauth2.initTokenClient / TokenClient.requestAccessToken を、呼び出された
// override 設定を記録した上でその場でトークン取得成功のコールバックを呼ぶスタブに差し替える。
// import 前にグローバルへ生やす必要がある（auth.ts は google をモジュール読み込み時ではなく
// 呼び出し時に参照するため、後から差し替えても本来は動くが、既存テストの流儀に合わせる）。

let captured: google.accounts.oauth2.OverridableTokenClientConfig | undefined;

Object.assign(globalThis, {
    __WEB_OAUTH_CLIENT_ID__: 'client-id',
});
(globalThis as unknown as { google: typeof google }).google = {
    accounts: {
        oauth2: {
            initTokenClient: (cfg: google.accounts.oauth2.TokenClientConfig) => ({
                requestAccessToken: (override?: google.accounts.oauth2.OverridableTokenClientConfig) => {
                    captured = override;
                    cfg.callback({ access_token: 't', expires_in: '3600' } as google.accounts.oauth2.TokenResponse);
                },
            }),
        },
    },
} as unknown as typeof google;

test('login_hint 未設定なら requestAccessToken に login_hint キーを渡さない', async () => {
    const { getAuthToken } = await import('../src/platform/web/auth');

    const token = await getAuthToken(true);

    assert.equal(token, 't');
    assert.ok(captured);
    assert.equal('login_hint' in captured!, false);
});

test('setAuthHint で指定したメールアドレスが login_hint として渡される', async () => {
    const { setAuthHint, getAuthToken } = await import('../src/platform/web/auth');
    setAuthHint('a@example.com');

    // 前のテストで取得したトークンがメモリキャッシュ（TTL内）に残っているため、そのままでは
    // getAuthToken がキャッシュを返すだけで requestAccessToken を呼ばない。
    // TTL経過後の時刻を装って、実際に GIS への再取得を発生させる
    // （tests/decision-row-cache.test.ts の TTL経過テストと同じ手法）。
    const originalNow = Date.now;
    try {
        Date.now = () => originalNow() + 3600_000 + 61_000;
        const token = await getAuthToken(true);
        assert.equal(token, 't');
    } finally {
        Date.now = originalNow;
    }

    assert.ok(captured);
    assert.equal(captured!.login_hint, 'a@example.com');
});
