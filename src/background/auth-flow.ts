/**
 * Chrome拡張版バックグラウンド認証コア: chrome.identity.launchWebAuthFlow による
 * OAuth (Implicit フロー、response_type=token) 実装。
 * chrome.identity.getAuthToken は Chrome プロファイルのアカウントに固定されるため、
 * 認可時に任意の Google アカウントを選べる launchWebAuthFlow へ移行した。
 * MV3 の Service Worker はアイドルで破棄されメモリ上のキャッシュが消えるため、
 * トークンは chrome.storage.session に保持する（ディスク非永続・ブラウザ終了で消去）。
 * 前回使ったメールアドレスだけは chrome.storage.local に保持し、Chrome 再起動後の
 * サイレント再認証で login_hint として使う。トークン自体は永続化しない。
 */

// webpack DefinePlugin によりビルド時に文字列リテラルへ置換されるグローバル定数。
declare const __EXTENSION_OAUTH_CLIENT_ID__: string;

// このアプリが要求する OAuth スコープ（ユーザーメール・Drive のアプリ作成/ユーザー選択ファイルのみ）
const SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
].join(' ');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_KEY = 'oauthToken';
// 認可済みアカウントのメール。機密トークンではないため local に保存し、
// Chrome 再起動後もサイレント再認証の login_hint として使う。
const EMAIL_KEY = 'oauthEmail';

interface CachedToken {
    token: string;
    expiresAt: number; // epoch ms
}

/**
 * クライアントIDが未設定のビルドで認可フローに入るのを止める（実行時ガード）。
 * webpack のビルド時 fail-fast をすり抜けたケース（ALLOW_NO_AUTH=1 のdevビルド等）でも、
 * client_id が空のまま Google 側へ投げて「Invalid OAuth2 Client ID.」という原因の
 * 追いにくいエラーになるのを防ぐ。globalThis を都度読む __EXTENSION_OAUTH_CLIENT_ID__ を
 * 呼び出し時に判定する（モジュール読み込み時の定数畳み込みにしない。テストから差し替え可能にするため）。
 * クライアントID自体は機密情報ではないが、値そのものはログ・エラーメッセージに出さない。
 */
function assertClientIdConfigured(): void {
    if (__EXTENSION_OAUTH_CLIENT_ID__) return;
    throw new Error(chrome.i18n.getMessage('auth_clientIdMissing') || 'OAuth client ID is not configured.');
}

/** 認可URLを組み立てる。prompt/login_hint は指定時のみ付与する。 */
function buildAuthUrl(prompt?: 'none' | 'select_account' | 'consent' | 'select_account consent', loginHint?: string): string {
    assertClientIdConfigured();
    const params = new URLSearchParams({
        client_id: __EXTENSION_OAUTH_CLIENT_ID__,
        response_type: 'token',
        redirect_uri: chrome.identity.getRedirectURL(),
        scope: SCOPES,
        include_granted_scopes: 'false',
    });
    if (prompt) params.set('prompt', prompt);
    if (loginHint) params.set('login_hint', loginHint);
    return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** リダイレクトURLのハッシュフラグメントから access_token を取り出す（Implicit フロー特有）。 */
function parseTokenFromRedirect(redirectUrl: string): CachedToken {
    const params = new URLSearchParams(new URL(redirectUrl).hash.replace(/^#/, ''));
    const token = params.get('access_token');
    if (!token) {
        throw new Error(params.get('error') || 'no_access_token');
    }
    const expiresIn = Number(params.get('expires_in') ?? '3600');
    return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

/** launchWebAuthFlow を実行し、成功したトークンを storage.session に保存する。 */
async function launch(
    interactive: boolean,
    prompt?: 'none' | 'select_account' | 'consent' | 'select_account consent',
    loginHint?: string
): Promise<string> {
    const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: buildAuthUrl(prompt, loginHint),
        interactive,
    });
    if (!redirectUrl) {
        throw new Error('auth_flow_cancelled');
    }
    const cached = parseTokenFromRedirect(redirectUrl);
    await chrome.storage.session.set({ [TOKEN_KEY]: cached });
    return cached.token;
}

async function readCachedToken(): Promise<CachedToken | undefined> {
    const stored = await chrome.storage.session.get(TOKEN_KEY);
    return stored[TOKEN_KEY] as CachedToken | undefined;
}

async function readCachedEmail(): Promise<string | undefined> {
    const stored = await chrome.storage.local.get(EMAIL_KEY);
    const email = stored[EMAIL_KEY];
    if (typeof email === 'string' && email) return email;

    // 旧バージョンの session 保存から、ブラウザを閉じる前に一度だけ移行する。
    const legacyStored = await chrome.storage.session.get(EMAIL_KEY);
    const legacyEmail = legacyStored[EMAIL_KEY];
    if (typeof legacyEmail !== 'string' || !legacyEmail) return undefined;

    await chrome.storage.local.set({ [EMAIL_KEY]: legacyEmail });
    await chrome.storage.session.remove(EMAIL_KEY);
    return legacyEmail;
}

/**
 * userinfo からメールを取得して EMAIL_KEY に保存する（ベストエフォート）。
 * force=false かつ既にキャッシュがあれば何もしない。取得失敗はここで握りつぶし、
 * 呼び出し元（認可フロー）を失敗させない。
 */
async function cacheEmail(token: string, force: boolean): Promise<void> {
    if (!force && (await readCachedEmail())) return;
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const info = await response.json();
        if (info.email) {
            await chrome.storage.local.set({ [EMAIL_KEY]: info.email });
        }
    } catch {
        // userinfo は付随情報のため、失敗してもトークン取得自体は成功として扱う
    }
}

// 同時に複数の launchWebAuthFlow を走らせないための単一飛行ガード。
// （popup とサイドパネルのサイレント試行が同時に来る・トークン失効直後に
//  API 呼び出しが並ぶ等。Web版 GIS 実装の pending ガードと同じ趣旨）
let inflight: Promise<string> | null = null;

/**
 * OAuth アクセストークンを取得する。
 * キャッシュ済み（有効期限に余裕あり）ならそれを返す。
 * まず prompt=none でサイレント取得を試み、失敗時のみ interactive の値に従う。
 * interactive=false（サイドパネル読み込み時のサイレント試行等）では認可ウィンドウを
 * 一切開かず即座に失敗させる。
 */
export async function getAuthToken(interactive = false): Promise<string> {
    const cached = await readCachedToken();
    if (cached && Date.now() < cached.expiresAt - 60_000) {
        // トークンがキャッシュヒットする間は下の inflight フロー（cacheEmail 経由の
        // local 保存）が実行されない。旧 session 保存のメールが残ったままだと
        // ブラウザを閉じた瞬間に失われるため、ヒット時も移行だけは都度試みる。
        await readCachedEmail();
        return cached.token;
    }

    if (inflight) {
        try {
            return await inflight;
        } catch {
            // 先行フローの失敗は自分の条件で再試行する（サイレント試行の失敗に
            // 相乗りした interactive な呼び出しをここで潰さないため rethrow しない）
        }
        // 先行フローが別の呼び出しに対して成功していればキャッシュに載っている
        const refreshed = await readCachedToken();
        if (refreshed && Date.now() < refreshed.expiresAt - 60_000) return refreshed.token;
    }

    inflight = (async () => {
        const loginHint = await readCachedEmail();
        try {
            // 複数 Google セッション環境で prompt=none が interaction_required にならないよう
            // login_hint で対象アカウントを明示する
            const token = await launch(false, 'none', loginHint);
            await cacheEmail(token, false);
            return token;
        } catch {
            if (!interactive) throw new Error('interaction_required');
            // アカウント選択画面に加えて同意画面も必ず出す（プロファイル固定から離れることが
            // 今回の移行の目的）。launchWebAuthFlow 移行でOAuthクライアントが変わり、
            // 再同意が必要な既存ユーザーが select_account のみでは同意未済のまま
            // 「このアプリはブロックされます」画面に落ちるため、consent を併記して
            // 通常の承認画面へ確実に誘導する
            const token = await launch(true, 'select_account consent');
            await cacheEmail(token, true); // アカウントが変わった可能性があるので必ず取り直す
            return token;
        }
    })();
    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}

/** トークンを破棄して強制的に再認可する（スコープ変更・権限エラー時に使用） */
export async function forceReauth(): Promise<string> {
    await chrome.storage.session.remove(TOKEN_KEY);
    const loginHint = await readCachedEmail();
    // 同じアカウントで再同意させるため login_hint を付ける
    const token = await launch(true, 'consent', loginHint);
    await cacheEmail(token, true);
    return token;
}

/** ログアウト処理。トークンを取り消し、セッションとアカウントヒントを破棄する。 */
export async function clearAuth(): Promise<void> {
    const cached = await readCachedToken();
    if (cached) {
        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(cached.token)}`, {
                method: 'POST',
            });
        } catch {
            // revoke 失敗してもローカルキャッシュの破棄は継続する
        }
    }
    await chrome.storage.session.remove([TOKEN_KEY, EMAIL_KEY]);
    await chrome.storage.local.remove(EMAIL_KEY);
}

/** 現在サインイン中のメールを返す。未ログイン・取得失敗時は null。 */
export async function getSignedInEmail(): Promise<string | null> {
    let token: string;
    try {
        token = await getAuthToken(false);
    } catch {
        return null;
    }

    const cachedEmail = await readCachedEmail();
    if (cachedEmail) return cachedEmail;

    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return null;
        const info = await response.json();
        if (!info.email) return null;
        await chrome.storage.local.set({ [EMAIL_KEY]: info.email });
        return info.email;
    } catch {
        return null;
    }
}
