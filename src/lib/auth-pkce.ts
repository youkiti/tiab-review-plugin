// auth-pkce.ts - OAuth 2.0 Authorization Code + PKCE (S256) の純粋ロジック
//
// chrome.* に一切依存しないため Node のテストランナー（node --test）からそのまま import できる。
// 実際の chrome.identity.launchWebAuthFlow 呼び出しやトークンエンドポイントへの fetch は
// background/auth-flow.ts 側が担当し、本ファイルは以下の3点のみを扱う。
//   1. PKCE の code_verifier / code_challenge (S256) の生成
//   2. リダイレクトURL（クエリ文字列）からの認可コード / エラー抽出
//   3. トークンエンドポイントのJSONレスポンスの整形

// RFC 7636 が定める code_verifier の許可文字集合（unreserved characters: ALPHA / DIGIT / "-" / "." / "_" / "~"）
const VERIFIER_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/**
 * PKCE の code_verifier を生成する。
 * RFC 7636 は 43〜128 文字（unreserved charset）を要求するため、デフォルトは最長の128文字とする。
 * crypto.getRandomValues で乱数バイト列を取得し、上記文字集合へマッピングする（1回のフローにつき使い捨て）。
 */
export function generateCodeVerifier(length = 128): string {
    if (length < 43 || length > 128) {
        throw new Error('code_verifier length must be between 43 and 128');
    }
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let verifier = '';
    for (let i = 0; i < bytes.length; i++) {
        verifier += VERIFIER_CHARSET[bytes[i] % VERIFIER_CHARSET.length];
    }
    return verifier;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** バイト列を base64url（パディング無し、"+/" は "-_" に置換）にエンコードする。 */
function base64UrlEncode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
        out += BASE64_CHARS[b0 >> 2];
        out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 !== undefined ? b1 >> 4 : 0)];
        out += b1 !== undefined ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 !== undefined ? b2 >> 6 : 0)] : '';
        out += b2 !== undefined ? BASE64_CHARS[b2 & 0x3f] : '';
    }
    return out.replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * code_verifier から code_challenge (S256) を計算する。
 * code_challenge = BASE64URL(SHA256(code_verifier))
 * ブラウザ（Service Worker）・Node のどちらでも globalThis.crypto.subtle が利用できる。
 */
export async function computeCodeChallenge(verifier: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Error('SubtleCrypto is not available in this environment');
    }
    const data = new TextEncoder().encode(verifier);
    const digest = await subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
}

/**
 * launchWebAuthFlow が返すリダイレクトURLから認可コードを取り出す。
 * Authorization Code フローでは access_token ではなく code がクエリ文字列（ハッシュフラグメントではない）
 * に載る。?error=...（interaction_required, access_denied 等）が付与されている場合は、
 * Implicit フロー時代と同様にその文字列をそのまま Error として投げる。
 */
export function parseAuthCodeFromRedirect(redirectUrl: string): string {
    const params = new URL(redirectUrl).searchParams;
    const error = params.get('error');
    if (error) {
        throw new Error(error);
    }
    const code = params.get('code');
    if (!code) {
        throw new Error('no_auth_code');
    }
    return code;
}

/** トークンエンドポイント（POST /token）が返す生のJSONレスポンス形状。 */
export interface TokenEndpointResponse {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    error?: string;
    error_description?: string;
}

/** アプリ内部で扱う整形済みトークン。 */
export interface ShapedToken {
    token: string;
    expiresAt: number; // epoch ms
    refreshToken?: string;
}

/**
 * トークンエンドポイントのレスポンスを内部形式に整形する。
 * access_token が無い場合はエラー（error フィールドがあればそれを、無ければ汎用メッセージを）を投げる。
 * refresh_token はレスポンスに含まれる場合のみ返す（refresh_token grant の交換では省略されることがある）。
 *
 * @param nowMs 有効期限計算の基準時刻（テスト用に注入可能。省略時は Date.now()）
 */
export function shapeTokenResponse(response: TokenEndpointResponse, nowMs: number = Date.now()): ShapedToken {
    if (!response.access_token) {
        throw new Error(response.error || response.error_description || 'no_access_token');
    }
    const expiresIn = Number(response.expires_in ?? 3600);
    return {
        token: response.access_token,
        expiresAt: nowMs + expiresIn * 1000,
        refreshToken: response.refresh_token,
    };
}
