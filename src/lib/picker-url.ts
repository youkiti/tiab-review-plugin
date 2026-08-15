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
 * 共有ドライブ（Shared drives）を Picker のビュー対象に含めるかどうかのフラグ名（Issue #80 フェーズ4）。
 *
 * **Pickerページは GitHub Pages（`docs/app/picker.js`）から配信されており、拡張機能とは
 * ロールアウトが独立している。** 配信物を差し替えた瞬間、旧バージョンの拡張機能を使っている
 * 全ユーザーのPickerにも反映される。そのため `setEnableDrives(true)` はページ側で無条件に
 * 有効化せず、**拡張機能が明示的に `drives=1` を渡したときだけ**有効になるようゲートする。
 * こうしておくと配信順序に依存せず、問題があってもフラグメント側（拡張機能のビルド）で
 * ロールバックが完結する。
 */
export const PICKER_DRIVES_PARAM = 'drives';

/** 拡張機能が共有ドライブ対応を要求しているか。`'1'` のみを有効とし、他の値は全て無効に倒す。 */
export function isSharedDrivesRequested(value: string | null | undefined): boolean {
    return value === '1';
}

/**
 * メールアドレスを配信サーバーのログへ残さないため、パラメータはクエリではなく
 * URLフラグメントで渡す。
 * `drives=1` は共有ドライブ対応のゲート（PICKER_DRIVES_PARAM 参照）。
 */
export function buildPickerUrl(spreadsheetId?: string, email?: string, baseUrl = PICKER_PAGE_URL): string {
    const params = new URLSearchParams();
    if (spreadsheetId) params.set('fileId', spreadsheetId);
    if (email) params.set('email', email);
    params.set(PICKER_DRIVES_PARAM, '1');
    return `${baseUrl}#${params.toString()}`;
}

/**
 * PDFモード（mode=pdf）でPickerページを開くためのURLを組み立てる。
 * 選択結果は chrome.identity.launchWebAuthFlow のリダイレクト捕捉で拡張機能へ直接返す設計のため、
 * 拡張機能側のリダイレクトURI（chrome.identity.getRedirectURL(...)）を redirect パラメータとして渡す。
 * email/redirect/folderId のいずれも配信サーバーのログに残さないため、buildPickerUrl 同様
 * すべてURLフラグメントで渡す。`drives=1` は共有ドライブ対応のゲート（PICKER_DRIVES_PARAM 参照）。
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
    params.set(PICKER_DRIVES_PARAM, '1');
    return `${baseUrl}#${params.toString()}`;
}

/**
 * mode=regrant（読み取り権限の再付与）でPickerページを開くためのURLを組み立てる。
 * buildPdfPickerUrl と同様、選択結果は launchWebAuthFlow のリダイレクト捕捉で受け取るため
 * email/redirect/folderId はすべてURLフラグメントで渡す（配信サーバーのログに残さないため）。
 * folderId は再付与対象のfulltextフォルダを初期表示するために必須（pdfモードと異なり省略不可）。
 * `drives=1` は共有ドライブ対応のゲート（PICKER_DRIVES_PARAM 参照）。
 */
export function buildRegrantPickerUrl(options: {
    email?: string;
    redirectUri: string;
    folderId: string;
    baseUrl?: string;
}): string {
    const { email, redirectUri, folderId, baseUrl = PICKER_PAGE_URL } = options;
    const params = new URLSearchParams();
    params.set('mode', 'regrant');
    params.set('redirect', redirectUri);
    params.set('folderId', folderId);
    if (email) params.set('email', email);
    params.set(PICKER_DRIVES_PARAM, '1');
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
