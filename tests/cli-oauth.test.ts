import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { get } from 'node:http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
    OAUTH_SCOPES, buildAuthUrl, createPkcePair, loadCredentials, saveCredentials, deleteCredentials,
    createTokenProvider,
} from '../src/cli/oauth';

const credentials = { refresh_token: 'fake-refresh-value', client_id: 'desktop-client', scope: OAUTH_SCOPES.join(' '), saved_at: '2026-01-01' };

async function withFile(fn: (file: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tiab-oauth-'));
    try { await fn(path.join(directory, 'nested', 'credentials.json')); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

function options(file: string) {
    return {
        clientId: credentials.client_id, clientSecret: 'fake-client-secret', credentialsPath: file,
        openBrowser: async (_url: string) => {}, log: (_message: string) => {}, callbackTimeoutMs: 1000,
    };
}

function tokenResponse(extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ access_token: 'fake-access-value', expires_in: 3600, ...extra }));
}

async function callback(authUrl: string, wrongState = false): Promise<void> {
    const auth = new URL(authUrl);
    const url = new URL(auth.searchParams.get('redirect_uri')!);
    assert.equal(url.hostname, '127.0.0.1');
    url.searchParams.set('code', 'fake-code-value');
    url.searchParams.set('state', wrongState ? 'wrong-state' : auth.searchParams.get('state')!);
    await new Promise<void>((resolve, reject) => {
        get(url, response => { response.resume(); response.on('end', resolve); }).on('error', reject);
    });
}

test('認可 URL は指定の 2 スコープと PKCE・ループバックを持つ', () => {
    const pair = createPkcePair();
    assert.match(pair.verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(pair.challenge, createHash('sha256').update(pair.verifier).digest('base64url'));
    const url = new URL(buildAuthUrl({ clientId: 'desktop-client', redirectUri: 'http://127.0.0.1:12345', codeChallenge: pair.challenge, state: 'state' }));
    assert.deepEqual(url.searchParams.get('scope')?.split(' '), [
        'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/drive.file',
    ]);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:/);
});

test('資格情報は保存・読み込みでき、別クライアントや壊れた JSON は無い扱い', async () => {
    await withFile(async file => {
        assert.equal(await loadCredentials(file), null);
        await saveCredentials(file, credentials);
        const loaded = await loadCredentials(file, credentials.client_id);
        assert.ok(loaded?.refresh_token === credentials.refresh_token);
        assert.equal(loaded?.client_id, credentials.client_id);
        const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(Object.keys(saved).sort(), ['client_id', 'refresh_token', 'saved_at', 'scope']);
        if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal(await loadCredentials(file, 'other-client'), null);
        await writeFile(file, '{broken');
        assert.equal(await loadCredentials(file), null);
        await deleteCredentials(file);
        assert.equal(await loadCredentials(file), null);
    });
});

test('保存済みトークンを 1 回更新し、次回はメモリを使う', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        let posts = 0;
        let opened = false;
        const provider = createTokenProvider({ ...options(file), openBrowser: () => { opened = true; },
            fetchImpl: async (url, init) => {
                posts++;
                assert.equal(url, 'https://oauth2.googleapis.com/token');
                assert.equal(init?.method, 'POST');
                assert.ok(init?.signal);
                assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
                return tokenResponse();
            } });
        assert.ok(await provider.getAccessToken() === 'fake-access-value');
        assert.ok(await provider.getAccessToken() === 'fake-access-value');
        assert.equal(posts, 1);
        assert.equal(opened, false);
        const message = provider.formatError(new Error(`失敗: fake-access-value fake-refresh-value fake-client-secret https://example.com/?token=value`));
        assert.match(message, /失敗/);
        assert.ok(!message.includes('fake-'));
        assert.ok(!message.includes('https://'));
    });
});

test('invalid_grant は資格情報を消し、非対話なら再ログインを案内する', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        const provider = createTokenProvider({ ...options(file), fetchImpl: async () =>
            new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) });
        await assert.rejects(provider.getAccessToken(false), /もう一度コマンドを実行/);
        assert.equal(await loadCredentials(file), null);
    });
});

test('ループバックで認可コードを交換し更新用資格情報を保存する', async () => {
    await withFile(async file => {
        let exchanged = false;
        const provider = createTokenProvider({ ...options(file), openBrowser: url => callback(url),
            fetchImpl: async (_url, init) => {
                const body = new URLSearchParams(String(init?.body));
                assert.equal(body.get('grant_type'), 'authorization_code');
                assert.ok(body.get('code_verifier'));
                assert.match(body.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:/);
                exchanged = true;
                return tokenResponse({ refresh_token: credentials.refresh_token });
            } });
        assert.ok(await provider.getAccessToken(true) === 'fake-access-value');
        assert.equal(exchanged, true);
        assert.ok((await loadCredentials(file))?.refresh_token === credentials.refresh_token);
    });
});

test('認可前の favicon リクエストは 404 で無視し、正しいコールバックでログインできる', async () => {
    await withFile(async file => {
        let faviconStatus: number | undefined;
        const messages: string[] = [];
        const provider = createTokenProvider({
            ...options(file),
            log: message => messages.push(message),
            openBrowser: async authUrl => {
                const auth = new URL(authUrl);
                const faviconUrl = new URL('/favicon.ico', auth.searchParams.get('redirect_uri')!);
                faviconStatus = await new Promise<number | undefined>((resolve, reject) => {
                    get(faviconUrl, response => {
                        response.resume();
                        response.on('end', () => resolve(response.statusCode));
                    }).on('error', reject);
                });
                assert.equal(faviconStatus, 404);
                await callback(authUrl);
            },
            fetchImpl: async () => tokenResponse({ refresh_token: credentials.refresh_token }),
        });
        assert.ok(await provider.getAccessToken(true) === 'fake-access-value');
        assert.equal(faviconStatus, 404);
        assert.ok((await loadCredentials(file))?.refresh_token === credentials.refresh_token);
        assert.equal(messages[0],
            'ブラウザで Google の許可画面を開きます。開かないときは、次の URL をブラウザに貼ってください:');
        assert.ok(messages[1].startsWith('https://accounts.google.com/'));
    });
});

test('state 不一致では交換も保存もせずサーバを閉じる', async () => {
    await withFile(async file => {
        let posted = false;
        let authUrl = '';
        const provider = createTokenProvider({ ...options(file), openBrowser: async url => { authUrl = url; await callback(url, true); },
            fetchImpl: async () => { posted = true; return tokenResponse(); } });
        await assert.rejects(provider.getAccessToken(true), /コールバック/);
        assert.equal(posted, false);
        assert.equal(await loadCredentials(file), null);
        await assert.rejects(callback(authUrl));
    });
});

test('コールバックが来なければ時間切れでサーバを閉じる', async () => {
    await withFile(async file => {
        let authUrl = '';
        const provider = createTokenProvider({ ...options(file), callbackTimeoutMs: 50,
            openBrowser: url => { authUrl = url; }, fetchImpl: async () => { throw new Error('呼ばれてはいけません'); } });
        await assert.rejects(provider.getAccessToken(true), /時間切れ/);
        await assert.rejects(callback(authUrl));
    });
});

test('交換応答に更新用トークンがなければ保存しない', async () => {
    await withFile(async file => {
        const provider = createTokenProvider({ ...options(file), openBrowser: url => callback(url), fetchImpl: async () => tokenResponse() });
        await assert.rejects(provider.getAccessToken(true), /リフレッシュトークンがありません/);
        assert.equal(await loadCredentials(file), null);
    });
});

test('更新が失効しても対話モードなら認可し直せる', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        let posts = 0;
        const provider = createTokenProvider({ ...options(file), openBrowser: url => callback(url), fetchImpl: async () => {
            posts++;
            return posts === 1 ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
                : tokenResponse({ refresh_token: credentials.refresh_token });
        } });
        assert.ok(await provider.getAccessToken(true) === 'fake-access-value');
        assert.equal(posts, 2);
        assert.ok(await loadCredentials(file));
    });
});

test('有効期限の 60 秒前からメモリのトークンを再利用しない', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        let posts = 0;
        const provider = createTokenProvider({ ...options(file), fetchImpl: async () => {
            posts++;
            return tokenResponse({ expires_in: 59 });
        } });
        await provider.getAccessToken();
        await provider.getAccessToken();
        assert.equal(posts, 2);
        await provider.clearAuth();
        assert.equal(await loadCredentials(file), null);
    });
});

test('トークン通信の時間切れは再試行せず秘密を含まないエラーになる', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        let posts = 0;
        const keepAlive = setTimeout(() => {}, 1000);
        try {
            const provider = createTokenProvider({ ...options(file), requestTimeoutMs: 10, fetchImpl: async (_url, init) => {
                posts++;
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('fake-client-secret')), { once: true });
                });
            } });
            await assert.rejects(provider.getAccessToken(), error => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /時間切れ/);
                assert.ok(!error.message.includes('fake-client-secret'));
                return true;
            });
            assert.equal(posts, 1);
        } finally { clearTimeout(keepAlive); }
    });
});

test('認証エラーに秘密情報や URL を含めず再試行もしない', async () => {
    await withFile(async file => {
        await saveCredentials(file, credentials);
        let posts = 0;
        const provider = createTokenProvider({ ...options(file), fetchImpl: async () => {
            posts++;
            return new Response(JSON.stringify({ error: 'invalid_client',
                error_description: `fake-client-secret ${credentials.refresh_token} https://example.com/?secret=value`,
                extra: '表示してはいけない本文',
            }), { status: 400 });
        } });
        await assert.rejects(provider.getAccessToken(), error => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes('fake-client-secret'));
            assert.ok(!error.message.includes(credentials.refresh_token));
            assert.ok(!error.message.includes('https://'));
            assert.ok(!error.message.includes('表示してはいけない本文'));
            assert.match(error.message, /HTTP 400/);
            return true;
        });
        assert.equal(posts, 1);
    });
    await withFile(async file => {
        const provider = createTokenProvider({ ...options(file), openBrowser: url => callback(url), fetchImpl: async () =>
            new Response(JSON.stringify({ error: 'invalid_request', error_description: 'fake-code-value fake-client-secret' }), { status: 400 }) });
        await assert.rejects(provider.getAccessToken(true), error => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes('fake-code-value'));
            assert.ok(!error.message.includes('fake-client-secret'));
            return true;
        });
    });
});
