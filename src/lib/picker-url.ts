/** Google Picker 許可ページのURLを組み立てるヘルパー。 */

// webpack DefinePlugin によりビルド時に文字列リテラルへ置換されるグローバル定数。
// Pickerページをローカル配信して検証するための上書き用で、dev ビルドでのみ値が入る
// （本番ビルドは webpack 側で無視するため、localhost が焼き込まれることはない）。
declare const __PICKER_PAGE_URL__: string;

const DEFAULT_PICKER_PAGE_URL = 'https://youkiti.github.io/tiab-review-plugin/app/picker.html';

// node --test は DefinePlugin を通さず __PICKER_PAGE_URL__ が未定義のままになる。
// typeof は未宣言の識別子でも例外を投げないため、これを未設定判定に使う。
export const PICKER_PAGE_URL =
    typeof __PICKER_PAGE_URL__ !== 'undefined' && __PICKER_PAGE_URL__
        ? __PICKER_PAGE_URL__
        : DEFAULT_PICKER_PAGE_URL;

/**
 * メールアドレスを配信サーバーのログへ残さないため、パラメータはクエリではなく
 * URLフラグメントで渡す。
 */
export function buildPickerUrl(spreadsheetId?: string, email?: string, baseUrl = PICKER_PAGE_URL): string {
    const params = new URLSearchParams();
    if (spreadsheetId) params.set('fileId', spreadsheetId);
    if (email) params.set('email', email);
    const hash = params.toString();
    return hash ? `${baseUrl}#${hash}` : baseUrl;
}

/**
 * PDFモード（mode=pdf）でPickerページを開くためのURLを組み立てる。
 * 選択結果は chrome.identity.launchWebAuthFlow のリダイレクト捕捉で拡張機能へ直接返す設計のため、
 * 拡張機能側のリダイレクトURI（chrome.identity.getRedirectURL(...)）を redirect パラメータとして渡す。
 * email/redirect/folderId のいずれも配信サーバーのログに残さないため、buildPickerUrl 同様
 * すべてURLフラグメントで渡す。
 */
export function buildPdfPickerUrl(options: {
    email?: string;
    redirectUri: string;
    folderId?: string;
    baseUrl?: string;
}): string {
    const { email, redirectUri, folderId, baseUrl = PICKER_PAGE_URL } = options;
    const params = new URLSearchParams();
    params.set('mode', 'pdf');
    params.set('redirect', redirectUri);
    if (folderId) params.set('folderId', folderId);
    if (email) params.set('email', email);
    return `${baseUrl}#${params.toString()}`;
}

/**
 * redirect パラメータが拡張機能の chromiumapp.org リダイレクトURIかどうかを検証する純粋関数。
 * Picker側（src/webapp/picker.ts）はこの検証を通った場合のみ window.location.href で遷移する
 * （オープンリダイレクト防止。redirect はURLフラグメント経由でPickerページに渡ってくる値のため、
 * 拡張機能自身が発行したリダイレクトURIであることを検証してからのみ使用する）。
 */
export function isExtensionRedirectUri(url: string): boolean {
    return /^https:\/\/[a-p]{32}\.chromiumapp\.org\//.test(url);
}
