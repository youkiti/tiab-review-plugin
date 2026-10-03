// デスクトップ用 OAuth の認可コードと PKCE によるログインを処理する。
// ループバックで認可を待ち、資格情報の保存・更新とエラーの秘匿化を行う。

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** CLI が本人確認と作成ファイルへのアクセスに要求するスコープ。 */
export const OAUTH_SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
];

/** PKCE の検証用乱数と、その SHA-256 チャレンジを生成する。 */
export function createPkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** リフレッシュトークンを要求する Google の認可 URL を組み立てる。 */
export function buildAuthUrl(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string;
}): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
        client_id: input.clientId, redirect_uri: input.redirectUri, response_type: 'code',
        scope: OAUTH_SCOPES.join(' '), code_challenge: input.codeChallenge,
        code_challenge_method: 'S256', state: input.state, access_type: 'offline', prompt: 'consent',
    }).toString();
    return url.toString();
}

export interface Credentials {
    refresh_token: string;
    client_id: string;
    scope: string;
    saved_at: string;
}

/** 保存済み資格情報を読み込み、不正な内容やクライアント不一致なら null を返す。 */
export async function loadCredentials(filePath: string, clientId?: string): Promise<Credentials | null> {
    try {
        const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
        if (typeof value !== 'object' || value === null) {
            return null;
        }
        const data = value as Partial<Credentials>;
        if (typeof data.refresh_token !== 'string' || !data.refresh_token ||
            typeof data.client_id !== 'string' || !data.client_id ||
            typeof data.scope !== 'string' || typeof data.saved_at !== 'string' ||
            (clientId !== undefined && data.client_id !== clientId)) {
            return null;
        }
        return data as Credentials;
    } catch {
        return null;
    }
}

/** 更新用資格情報だけを保存し、ファイルの権限モードに 0600 を指定する。 */
export async function saveCredentials(filePath: string, creds: Credentials): Promise<void> {
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const file = await fs.open(filePath, 'w', 0o600);
        try {
            await file.chmod(0o600);
            await file.writeFile(JSON.stringify({
                refresh_token: creds.refresh_token, client_id: creds.client_id,
                scope: creds.scope, saved_at: creds.saved_at,
            }), 'utf8');
        } finally {
            await file.close();
        }
    } catch {
        throw new OAuthError('資格情報ファイルを保存できませんでした。保存先の権限を確認してください。');
    }
}

/** 保存済み資格情報を削除し、失敗時は保存先の確認を案内する。 */
export async function deleteCredentials(filePath: string): Promise<void> {
    try {
        await fs.rm(filePath, { force: true });
    } catch {
        throw new OAuthError('資格情報ファイルを削除できませんでした。保存先の権限を確認してください。');
    }
}

/** 表示してよい固定文言と、秘密情報を除去済みの OAuth 応答だけを保持する。 */
export class OAuthError extends Error {
    constructor(message: string, public readonly invalidGrant = false) {
        super(message);
        this.name = 'OAuthError';
    }
}

interface TokenProviderOptions {
    clientId: string;
    clientSecret: string;
    credentialsPath: string;
    openBrowser(url: string): void | Promise<void>;
    log(message: string): void;
    fetchImpl?: typeof fetch;
    callbackTimeoutMs?: number;
    requestTimeoutMs?: number;
}

const LOGIN_AGAIN = 'もう一度コマンドを実行してログインし直してください。';

/** 認可・トークン更新・資格情報の破棄をまとめた認証プロバイダを作る。 */
export function createTokenProvider(options: TokenProviderOptions) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const secrets = new Set<string>([options.clientSecret]);
    let accessToken = '';
    let expiresAt = 0;
    let pending: Promise<string> | undefined;

    /** Issue #245: API から反射された認証値と URL を除き、元の原因を表示できるようにする。 */
    function formatError(error: unknown): string {
        let message = error instanceof Error ? error.message : '処理に失敗しました。';
        for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
            for (const form of [secret, encodeURIComponent(secret)]) {
                message = message.split(form).join('[非表示]');
            }
        }
        return Array.from(message.replace(/https?:\/\/\S+/g, '[URL非表示]'))
            .map(character => character.charCodeAt(0) < 32 ? ' ' : character).join('');
    }

    async function postToken(parameters: Record<string, string>): Promise<Record<string, unknown>> {
        for (const key of ['code', 'code_verifier', 'refresh_token']) {
            if (parameters[key]) {
                secrets.add(parameters[key]);
            }
        }
        let response: Response;
        let data: Record<string, unknown>;
        try {
            response = await fetchImpl('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    ...parameters, client_id: options.clientId, client_secret: options.clientSecret,
                }),
                signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30000),
            });
            const parsed: unknown = await response.json().catch(() => null);
            data = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
        } catch {
            throw new OAuthError('トークンの通信に失敗しました。時間切れまたは通信状態を確認してください。');
        }
        for (const key of ['access_token', 'refresh_token', 'id_token']) {
            if (typeof data[key] === 'string') {
                secrets.add(data[key]);
            }
        }
        if (!response.ok) {
            // Issue #245: 応答の説明が入力値を反射しても認証値を表示しない。
            const redact = (value: unknown): string => formatError(new Error(typeof value === 'string' ? value : ''));
            throw new OAuthError(
                `トークン取得に失敗しました（HTTP ${response.status}）: ${redact(data.error)} ${redact(data.error_description)}`,
                data.error === 'invalid_grant',
            );
        }
        if (typeof data.access_token !== 'string' || !data.access_token ||
            typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
            throw new OAuthError('トークン応答に必要な値がありません。');
        }
        return data;
    }

    function remember(data: Record<string, unknown>): string {
        accessToken = data.access_token as string;
        expiresAt = Date.now() + ((data.expires_in as number) - 60) * 1000;
        return accessToken;
    }

    async function authorize(): Promise<string> {
        const { verifier, challenge } = createPkcePair();
        const state = randomBytes(32).toString('base64url');
        let redirectUri = '';
        let timer: ReturnType<typeof setTimeout> | undefined;
        let resolveCode!: (code: string) => void;
        let rejectCode!: (error: OAuthError) => void;
        const codePromise = new Promise<string>((resolve, reject) => {
            resolveCode = resolve;
            rejectCode = reject;
        });
        // Issue #245: ブラウザ起動中のコールバック失敗も未処理の拒否にしない。
        void codePromise.catch(() => undefined);
        const server = createServer((request, response) => {
            let callback: URL;
            try {
                callback = new URL(request.url ?? '/', 'http://127.0.0.1');
            } catch {
                response.writeHead(400, { 'Connection': 'close' });
                response.end();
                rejectCode(new OAuthError('認証コールバックを確認できませんでした。' + LOGIN_AGAIN));
                return;
            }
            const code = callback.searchParams.get('code');
            if (!callback.searchParams.has('code') && !callback.searchParams.has('error')) {
                response.writeHead(404, { 'Connection': 'close' });
                response.end();
                return;
            }
            const valid = callback.searchParams.get('state') === state && !!code && !callback.searchParams.has('error');
            response.writeHead(valid ? 200 : 400, {
                'Content-Type': 'text/html; charset=utf-8', 'Connection': 'close',
            });
            response.end(valid
                ? '<!doctype html><meta charset="utf-8"><p>認証が完了しました。このタブを閉じてターミナルに戻ってください。</p>'
                : '<!doctype html><meta charset="utf-8"><p>認証を確認できませんでした。ターミナルに戻ってください。</p>');
            if (valid) {
                resolveCode(code);
            } else {
                rejectCode(new OAuthError('認証コールバックを確認できませんでした。' + LOGIN_AGAIN));
            }
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', () => reject(new OAuthError('認証用のローカルサーバを開始できませんでした。')));
                server.listen(0, '127.0.0.1', () => resolve());
            });
            server.on('error', () => rejectCode(new OAuthError('認証用のローカルサーバでエラーが発生しました。')));
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new OAuthError('認証用ポートを取得できませんでした。');
            }
            redirectUri = `http://127.0.0.1:${address.port}`;
            timer = setTimeout(
                () => rejectCode(new OAuthError('認証が時間切れになりました。' + LOGIN_AGAIN)),
                options.callbackTimeoutMs ?? 300000,
            );
            const url = buildAuthUrl({ clientId: options.clientId, redirectUri, codeChallenge: challenge, state });
            options.log('ブラウザで Google の許可画面を開きます。開かないときは、次の URL をブラウザに貼ってください:');
            options.log(url);
            void Promise.resolve().then(() => options.openBrowser(url)).catch(() => {
                options.log('ブラウザを開けませんでした。表示された認可 URL を手で開いてください。');
            });
            const code = await codePromise;
            const data = await postToken({
                grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri,
            });
            if (typeof data.refresh_token !== 'string' || !data.refresh_token) {
                throw new OAuthError('リフレッシュトークンがありません。' + LOGIN_AGAIN);
            }
            await saveCredentials(options.credentialsPath, {
                refresh_token: data.refresh_token, client_id: options.clientId,
                scope: typeof data.scope === 'string' ? data.scope : OAUTH_SCOPES.join(' '),
                saved_at: new Date().toISOString(),
            });
            return remember(data);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
            await new Promise<void>(resolve => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        }
    }

    async function acquire(interactive: boolean): Promise<string> {
        if (accessToken && Date.now() < expiresAt) {
            return accessToken;
        }
        const credentials = await loadCredentials(options.credentialsPath, options.clientId);
        if (credentials) {
            try {
                const data = await postToken({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
                return remember(data);
            } catch (error) {
                if (!(error instanceof OAuthError) || !error.invalidGrant) {
                    throw error;
                }
                await deleteCredentials(options.credentialsPath);
            }
        }
        if (!interactive) {
            throw new OAuthError(LOGIN_AGAIN);
        }
        return authorize();
    }

    async function getAccessToken(interactive = false): Promise<string> {
        if (!pending) {
            pending = acquire(interactive).finally(() => {
                pending = undefined;
            });
        }
        return pending;
    }
    async function clearAuth(): Promise<void> {
        accessToken = '';
        expiresAt = 0;
        await deleteCredentials(options.credentialsPath);
    }
    return {
        getAccessToken,
        clearAuth,
        formatError,
        forceReauth: async () => {
            await clearAuth();
            return getAccessToken(true);
        },
    };
}
