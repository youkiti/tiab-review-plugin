/**
 * Web 版プラットフォームアダプタ: Google Identity Services (GIS) の
 * Token Client を用いた OAuth 認証実装。
 * トークンはメモリ上にのみ保持し、localStorage 等の永続化ストレージには一切保存しない
 * （タブを閉じる・リロードすると再認可が必要になる仕様）。
 */

import { getMessage } from './i18n';

// webpack DefinePlugin によりビルド時に文字列リテラルへ置換されるグローバル定数。
declare const __WEB_OAUTH_CLIENT_ID__: string;

// このアプリが要求する OAuth スコープ（ユーザーメール・Drive のアプリ作成/ユーザー選択ファイルのみ）
const SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file',
].join(' ');

// メモリ上のトークンキャッシュ（永続化しない）
let accessToken: string | null = null;
let expiresAt = 0; // epoch ms
let tokenClient: google.accounts.oauth2.TokenClient | null = null;
// requestAccessToken は同時に1つしか呼べないため、進行中の Promise を保持する
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

/**
 * クライアントIDが未設定のビルドで GIS の TokenClient を作るのを止める（実行時ガード）。
 * webpack のビルド時 fail-fast をすり抜けたケース（ALLOW_NO_AUTH=1 のdevビルド等）でも、
 * client_id が空のまま GIS へ渡してわかりにくいエラーになるのを防ぐ。__WEB_OAUTH_CLIENT_ID__ は
 * 呼び出し時に都度読む（モジュール読み込み時の定数畳み込みにしない。テストから差し替え可能にするため）。
 * クライアントID自体は機密情報ではないが、値そのものはログ・エラーメッセージに出さない。
 */
function assertClientIdConfigured(): void {
    if (__WEB_OAUTH_CLIENT_ID__) return;
    throw new Error(getMessage('auth_clientIdMissing') || 'OAuth client ID is not configured.');
}

/**
 * GIS の TokenClient を遅延初期化する（初回のみ生成し、以後は使い回す）
 */
function ensureClient(): google.accounts.oauth2.TokenClient {
    if (tokenClient) return tokenClient;
    assertClientIdConfigured();
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: __WEB_OAUTH_CLIENT_ID__,
        scope: SCOPES,
        include_granted_scopes: false,
        callback: (resp) => {
            const p = pending; pending = null;
            if (!p) return;
            if (resp.error) { p.reject(new Error(resp.error)); return; }
            accessToken = resp.access_token;
            expiresAt = Date.now() + Number(resp.expires_in) * 1000;
            p.resolve(resp.access_token);
        },
        error_callback: (err) => {
            // ポップアップが閉じられた等、OAuth 以外のエラー
            const p = pending; pending = null;
            p?.reject(new Error(err.type));
        },
    });
    return tokenClient;
}

/**
 * GIS のトークン取得フローを開始し、コールバックの結果を Promise 化する。
 * prompt='' はサイレント取得（既に許可済みならダイアログなし）、
 * prompt='consent' は強制的に同意画面を表示する。
 */
function requestToken(promptValue: '' | 'consent'): Promise<string> {
    return new Promise((resolve, reject) => {
        // 進行中の要求が残っていても、それを破棄して新しい要求で上書きする。
        // 前回のポップアップがブロック/放置されコールバック未達のまま pending が
        // 残留しても、次のユーザー操作で確実にやり直せるようにするための自己修復。
        // （旧実装は新しい要求を「auth in progress」で拒否しており、一度詰まると復旧不能だった）
        if (pending) { pending.reject(new Error('auth superseded')); pending = null; }
        pending = { resolve, reject };
        ensureClient().requestAccessToken({ prompt: promptValue });
    });
}

/**
 * OAuth アクセストークンを取得する。
 * メモリにキャッシュ済み（有効期限に余裕あり）ならそれを返す。
 *
 * Web(GIS) はトークンを永続化しないため、キャッシュが無い状態での取得には
 * 必ずトークン取得ポップアップが要る。ポップアップはユーザー操作（クリック）起点で
 * しか開けないので、interactive=false（ページ読み込み時のサイレント試行など）では
 * ポップアップを試みず即座に失敗させる。
 * ここでポップアップを試みると、ブラウザにブロックされてコールバックが来ず、
 * pending が残留して以後のログインが弾かれる原因になっていた。
 */
export async function getAuthToken(interactive = false): Promise<string> {
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    if (!interactive) throw new Error('interaction_required');
    return requestToken('');
}

/**
 * トークンを破棄して強制的に再認可する（スコープ変更・権限エラー時に使用）
 */
export async function forceReauth(): Promise<string> {
    accessToken = null; expiresAt = 0;
    return requestToken('consent');
}

/**
 * ログアウト処理。GIS 側のトークンを取り消し、メモリ上のキャッシュも破棄する。
 */
export async function clearAuth(): Promise<void> {
    if (accessToken) {
        await new Promise<void>((r) => google.accounts.oauth2.revoke(accessToken!, () => r()));
    }
    accessToken = null; expiresAt = 0;
}
