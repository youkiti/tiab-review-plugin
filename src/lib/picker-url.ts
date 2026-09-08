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
 * 一括再付与（`mode=regrant`）で「読めないPDFのfileIdだけ」をPickerに表示させるためのフラグ名
 * （Issue #203）。`drives=1` と同じ理由（PICKER_DRIVES_PARAM 参照）でフラグメント側にゲートを
 * 置く。Pickerページは GitHub Pages から配信され旧バージョンの拡張機能にも即時反映されるため、
 * **拡張機能が明示的に `fileIds` を渡したときだけ** Picker 側の挙動を変える。渡されなければ
 * 従来どおりフォルダ全体を初期表示する経路をそのまま通す。
 */
export const PICKER_FILE_IDS_PARAM = 'fileIds';

/**
 * フラグメントで渡された fileIds 文字列（カンマ区切り）をパースする純関数（Issue #203）。
 * フラグメントは外部から任意の値を与えられうるため、Drive のファイルID相当の文字種
 * （英数字・`_`・`-`）にマッチするものだけを残し、それ以外は黙って捨てる
 * （Picker へ素通しせず、形が壊れた値をここで弾く）。
 */
export function parseRegrantFileIds(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^[A-Za-z0-9_-]+$/.test(id));
}

/**
 * 一括再付与のPickerを1回に開く際の fileIds の上限件数（Issue #203）。
 * Picker の初期表示件数の実測上限が概ね50件で、それを超えると対象ファイルが一覧から
 * 見つからず選びようがなくなる（Issue #203 の報告事象そのもの）。この定数を
 * URL組み立てのモジュールに置く理由: 分割する理由が「1回のPickerに載せるfileIdsの量を、
 * URL長とPickerのビュー設定サイズと表示件数の上限に当てない粒度へ抑える」ことであり、
 * URLの制約そのものだから。
 */
export const REGRANT_PICKER_CHUNK_SIZE = 50;

/**
 * fileIds を REGRANT_PICKER_CHUNK_SIZE 件ずつのチャンクへ分割する（Issue #203）。
 * 空配列を渡したら空配列を返す（呼び出し側はPickerを1回も開かない判断に使える）。
 * chunkSize に 1 未満の値（0や負数）が渡っても無限ループにならないよう 1 に丸める。
 */
export function chunkRegrantFileIds(fileIds: string[], chunkSize = REGRANT_PICKER_CHUNK_SIZE): string[][] {
    if (fileIds.length === 0) return [];
    const size = Math.max(1, chunkSize);
    const chunks: string[][] = [];
    for (let i = 0; i < fileIds.length; i += size) {
        chunks.push(fileIds.slice(i, i + size));
    }
    return chunks;
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
 * email/redirect/folderId/fileIds はすべてURLフラグメントで渡す（配信サーバーのログに残さないため）。
 * folderId は再付与対象のfulltextフォルダを初期表示するために必須（pdfモードと異なり省略不可。
 * fileIds をPickerページ側が使えなかった場合のフォールバック表示にも要る）。
 * fileIds（空でない配列のときのみ付与）は「読めないPDFのfileIdだけ」を表示させるためのフラグ
 * （Issue #203。PICKER_FILE_IDS_PARAM 参照）。
 * `drives=1` は共有ドライブ対応のゲート（PICKER_DRIVES_PARAM 参照）。
 */
export function buildRegrantPickerUrl(options: {
    email?: string;
    redirectUri: string;
    folderId: string;
    fileIds?: string[];
    baseUrl?: string;
}): string {
    const { email, redirectUri, folderId, fileIds, baseUrl = PICKER_PAGE_URL } = options;
    const params = new URLSearchParams();
    params.set('mode', 'regrant');
    params.set('redirect', redirectUri);
    params.set('folderId', folderId);
    if (fileIds && fileIds.length > 0) params.set(PICKER_FILE_IDS_PARAM, fileIds.join(','));
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
