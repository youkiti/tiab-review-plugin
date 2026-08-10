import test from 'node:test';
import assert from 'node:assert/strict';

// __WEB_OAUTH_CLIENT_ID__ は webpack DefinePlugin が埋め込むグローバル定数。
// このテストでは globalThis に直接生やしてビルド無しで実行する。
Object.assign(globalThis, {
    __WEB_OAUTH_CLIENT_ID__: '',
});

test('クライアントID未設定時は GIS の TokenClient を作る前にガードが停止する（Web版, interactive=true）', async () => {
    const { getAuthToken } = await import('../src/platform/web/auth');

    // ensureClient() が google.accounts.oauth2.initTokenClient を呼ぶ前に例外を投げるため、
    // ブラウザ環境（google グローバル）が無い Node のテストでも検証できる。
    await assert.rejects(
        () => getAuthToken(true),
        (error: Error) => {
            assert.match(error.message, /OAuth|クライアントID/);
            return true;
        }
    );
});

test('クライアントID未設定時はサイレント取得（interactive=false）も同様に失敗する', async () => {
    const { getAuthToken } = await import('../src/platform/web/auth');

    // interactive=false は元々ポップアップを試みず即座に失敗する既存仕様。
    // ensureClient() まで到達しないため、こちらはガード追加前と同じ interaction_required のまま。
    await assert.rejects(() => getAuthToken(false), /interaction_required/);
});
