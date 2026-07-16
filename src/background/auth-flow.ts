/**
 * Chrome拡張版バックグラウンド認証コア: chrome.identity.launchWebAuthFlow による
 * OAuth 2.0 Authorization Code フロー + PKCE (S256) 実装。
 * かつては response_type=token の Implicit フローでリダイレクトURLのハッシュフラグメントから
 * access_token を直接受け取っていたが、Google が非推奨としているため廃止した。現在は
 * response_type=code + code_challenge (PKCE, S256) で認可し、リダイレクトURLの
 * クエリ文字列（ハッシュではない）から認可コードを受け取り、oauth2.googleapis.com/token へ
 * サーバー間POSTして交換する。本アプリは公開クライアント（Chrome拡張）のため、
 * client_secret は一切使用しない（PKCEのみで正当性を担保する）。
 * PKCE の code_verifier/code_challenge の生成・リダイレクトURL解析・トークンレスポンスの
 * 整形は chrome.* に依存しない純粋ロジックとして lib/auth-pkce.ts に切り出している。
 * chrome.identity.getAuthToken は Chrome プロファイルのアカウントに固定されるため、
 * 認可時に任意の Google アカウントを選べる launchWebAuthFlow を使い続ける。
 * 認可URLに access_type=offline を付け、refresh_token を chrome.storage.local
 * （ディスク永続・ブラウザ再起動後も残る）に保存することで、ブラウザを再起動しても
 * サイレントにアクセストークンを再取得できるようにしている。access_token 本体と
 * 有効期限は今まで通り chrome.storage.session のみに保持する（MV3 の Service Worker は
 * アイドルで破棄されメモリ上のキャッシュが消えるため、ディスク非永続・ブラウザ終了で
 * 消去される storage.session を使う）。
 */

import {
    generateCodeVerifier,
    computeCodeChallenge,
    parseAuthCodeFromRedirect,
    shapeTokenResponse,
    type ShapedToken,
} from '../lib/auth-pkce';

// webpack DefinePlugin によりビルド時に文字列リテラルへ置換されるグローバル定数。
declare const __EXTENSION_OAUTH_CLIENT_ID__: string;

// このアプリが要求する OAuth スコープ（ユーザーメール・Drive のアプリ作成/ユーザー選択ファイルのみ）
// いずれも非 sensitive。full な spreadsheets スコープは Picker + drive.file 移行で廃止済みであり、
// 復活させると OAuth 審査要件と100ユーザー上限が再発するため、ここへ追加してはならない。
const SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
].join(' ');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

// storage.session（揮発。ブラウザ終了で消える）
const TOKEN_KEY = 'oauthToken';
// 認可済みアカウントのメール。login_hint（サイレント再取得時のヒント）とポップアップ表示に使う。
const EMAIL_KEY = 'oauthEmail';
// storage.local（ディスク永続。ブラウザ再起動後もサイレント更新に使うため意図的に永続化する）
const REFRESH_TOKEN_KEY = 'oauthRefreshToken';

interface CachedToken {
    token: string;
    expiresAt: number; // epoch ms
}

type PromptValue = 'none' | 'select_account' | 'consent' | 'select_account consent';

/** 認可URLを組み立てる。PKCE の code_challenge は毎回のフローで使い捨てのため必須で受け取る。 */
function buildAuthUrl(codeChallenge: string, prompt?: PromptValue, loginHint?: string): string {
    const params = new URLSearchParams({
        client_id: __EXTENSION_OAUTH_CLIENT_ID__,
        response_type: 'code',
        redirect_uri: chrome.identity.getRedirectURL(),
        scope: SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // refresh_token を発行させ、ブラウザ再起動後もサイレント更新できるようにする
        access_type: 'offline',
    });
    if (prompt) params.set('prompt', prompt);
    if (loginHint) params.set('login_hint', loginHint);
    return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * トークンエンドポイントへ application/x-www-form-urlencoded で POST し、
 * レスポンスを整形済みトークンとして返す。access_token が無い場合は例外を投げる
 * （invalid_grant 等のエラーコードがそのまま Error.message になる）。
 *
 * エラー時は error_description も console へ出す。Error.message は呼び出し側が
 * invalid_grant を判定する契約のため error コードのみに保たれるが、それだけでは
 * 「このクライアント種別が client_secret 無しの PKCE を受け付けるか」の切り分けが
 * できない（secret 要求時 Google は error=invalid_request /
 * error_description='client_secret is missing.' を返す）。トークン類は出力しない。
 */
async function requestToken(params: Record<string, string>): Promise<ShapedToken> {
    const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
    });
    const json = await response.json().catch(() => ({}));
    if (!json.access_token) {
        console.warn(
            `[auth] token endpoint ${response.status}: ${json.error ?? 'unknown_error'}` +
                `${json.error_description ? ` - ${json.error_description}` : ''}` +
                ` (grant_type=${params.grant_type})`
        );
    }
    return shapeTokenResponse(json);
}

/**
 * 認可コードをアクセストークン（+ 初回同意時は refresh_token）に交換する。
 * 公開クライアントのため client_secret は送らず、code_verifier（PKCE）のみで正当性を示す。
 */
function exchangeAuthorizationCode(code: string, verifier: string): Promise<ShapedToken> {
    return requestToken({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: __EXTENSION_OAUTH_CLIENT_ID__,
        redirect_uri: chrome.identity.getRedirectURL(),
    });
}

/** 保存済み refresh_token でアクセストークンをサイレント更新する（ユーザー操作なし）。 */
function exchangeRefreshToken(refreshToken: string): Promise<ShapedToken> {
    return requestToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: __EXTENSION_OAUTH_CLIENT_ID__,
    });
}

/** refresh_token grant が invalid_grant で失敗したか判定する（失効・取り消し済み）。 */
function isInvalidGrantError(err: unknown): boolean {
    return err instanceof Error && err.message === 'invalid_grant';
}

/**
 * 交換済みトークンを保存する。access_token + 有効期限は storage.session、
 * refresh_token はレスポンスに含まれる場合のみ storage.local へ（含まれない場合は
 * 既存の保存値をそのまま残す＝トークンエンドポイントが常に返すとは限らないため）。
 */
async function applyTokenResult(shaped: ShapedToken): Promise<void> {
    const cached: CachedToken = { token: shaped.token, expiresAt: shaped.expiresAt };
    await chrome.storage.session.set({ [TOKEN_KEY]: cached });
    if (shaped.refreshToken) {
        await chrome.storage.local.set({ [REFRESH_TOKEN_KEY]: shaped.refreshToken });
    }
}

async function readStoredRefreshToken(): Promise<string | undefined> {
    const stored = await chrome.storage.local.get(REFRESH_TOKEN_KEY);
    return stored[REFRESH_TOKEN_KEY] as string | undefined;
}

async function clearStoredRefreshToken(): Promise<void> {
    await chrome.storage.local.remove(REFRESH_TOKEN_KEY);
}

/**
 * launchWebAuthFlow を実行し、認可コードを取得してトークンに交換、storage へ保存する。
 * PKCE の code_verifier/code_challenge は毎回のフローで新規に生成する使い捨て値。
 */
async function launch(interactive: boolean, prompt?: PromptValue, loginHint?: string): Promise<string> {
    const verifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(verifier);
    const redirectUrl = await chrome.identity.launchWebAuthFlow({
        url: buildAuthUrl(codeChallenge, prompt, loginHint),
        interactive,
    });
    if (!redirectUrl) {
        throw new Error('auth_flow_cancelled');
    }
    const code = parseAuthCodeFromRedirect(redirectUrl);
    const shaped = await exchangeAuthorizationCode(code, verifier);
    await applyTokenResult(shaped);
    return shaped.token;
}

async function readCachedToken(): Promise<CachedToken | undefined> {
    const stored = await chrome.storage.session.get(TOKEN_KEY);
    return stored[TOKEN_KEY] as CachedToken | undefined;
}

async function readCachedEmail(): Promise<string | undefined> {
    const stored = await chrome.storage.session.get(EMAIL_KEY);
    return stored[EMAIL_KEY] as string | undefined;
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
            await chrome.storage.session.set({ [EMAIL_KEY]: info.email });
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
 * キャッシュが無い/失効間近の場合、サイレント更新を次の優先順位で試みる。
 *   (a) 保存済み refresh_token があれば grant_type=refresh_token で交換
 *       （invalid_grant で失敗した場合は失効/取り消し済みとみなし、保存値を破棄して次へ）
 *   (b) launchWebAuthFlow を prompt=none（非対話・code フロー）で試行
 *   (c) それでも失敗し、かつ interactive=true の場合のみアカウント選択を伴う対話フローを実行
 * interactive=false（サイドパネル読み込み時のサイレント試行等）で (a)(b) とも失敗した場合は
 * 認可ウィンドウを一切開かず interaction_required を投げて即座に失敗させる。
 */
export async function getAuthToken(interactive = false): Promise<string> {
    const cached = await readCachedToken();
    if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

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

        // (a) 保存済み refresh_token による更新（ユーザー操作なし・最速）
        const refreshToken = await readStoredRefreshToken();
        if (refreshToken) {
            try {
                const shaped = await exchangeRefreshToken(refreshToken);
                await applyTokenResult(shaped);
                await cacheEmail(shaped.token, false);
                return shaped.token;
            } catch (err) {
                // 失効・取り消し済みの refresh_token は破棄し、(b) 以降へフォールバックする
                if (isInvalidGrantError(err)) {
                    await clearStoredRefreshToken();
                }
            }
        }

        try {
            // (b) 複数 Google セッション環境で prompt=none が interaction_required にならないよう
            // login_hint で対象アカウントを明示する
            const token = await launch(false, 'none', loginHint);
            await cacheEmail(token, false);
            return token;
        } catch {
            if (!interactive) throw new Error('interaction_required');
            // (c) アカウント選択画面を必ず出す（プロファイル固定から離れることが今回の移行の目的）。
            // consent も付けて refresh_token を確実に発行させる（access_type=offline だけでは
            // 2回目以降の同意で refresh_token が省略されることがあるため）。
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
    // 同じアカウントで再同意させ、prompt=consent + access_type=offline で refresh_token を確実に発行させる
    const token = await launch(true, 'consent', loginHint);
    await cacheEmail(token, true);
    return token;
}

/**
 * ログアウト処理。refresh_token があればそれを取り消す（refresh_token の revoke は
 * 紐づく access_token も含めグラント全体を無効化するため）。無ければ従来通り access_token を
 * 取り消す。取り消し完了後、storage.session / storage.local のキャッシュも破棄する。
 */
export async function clearAuth(): Promise<void> {
    const cached = await readCachedToken();
    const refreshToken = await readStoredRefreshToken();
    const tokenToRevoke = refreshToken ?? cached?.token;
    if (tokenToRevoke) {
        try {
            await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokenToRevoke)}`, {
                method: 'POST',
            });
        } catch {
            // revoke 失敗してもローカルキャッシュの破棄は継続する
        }
    }
    await chrome.storage.session.remove([TOKEN_KEY, EMAIL_KEY]);
    await chrome.storage.local.remove(REFRESH_TOKEN_KEY);
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
        await chrome.storage.session.set({ [EMAIL_KEY]: info.email });
        return info.email;
    } catch {
        return null;
    }
}
