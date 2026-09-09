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
 * fileIds と一緒に渡す「拡張機能が送った件数」のパラメータ名。
 * URLが途中で切り詰められると fileIds は末尾から失われるため、buildRegrantPickerUrl は
 * これを fileIds より前の位置に置く（詳細は buildRegrantPickerUrl のコメント参照）。
 * Picker ページ（src/webapp/picker.ts）は実際に受け取った fileIds の件数とこの値を比較し、
 * 食い違っていれば「URLが途中で切れた可能性がある」という警告を表示する。
 */
export const PICKER_FILE_IDS_COUNT_PARAM = 'fileIdsCount';

/**
 * fileIds の直後に置く「番兵」のパラメータ名。fileIds が URL の最後の実データであることを
 * 前提に、**わざと犠牲にする値**として fileIds のさらに後ろへ置く。
 *
 * 件数（PICKER_FILE_IDS_COUNT_PARAM）の比較だけでは、末尾の fileId が途中で切れても
 * 検知できない場合がある。`parseRegrantFileIds` は文字種（英数字・`_`・`-`）しか見ないため、
 * 切れた後に残った断片がたまたまこの文字種にマッチすれば「1件」として数えてしまい、件数は
 * 送信件数と一致してしまう。フラグメント上では区切りが `%2C`（3文字）、Drive のIDは33文字
 * 前後なので、切れる位置の大半はID内部に落ちる＝この誤検知は例外ケースではない。
 *
 * `fileIdsEnd=1` という番兵を fileIds の直後に置けば、URLがどこで切り詰められても
 * fileIds 本体より先にこの番兵が失われる。したがって `fileIdsEnd` が `'1'` でなければ
 * 切り詰めが起きたと確実に判定できる（isRegrantFileIdsComplete 参照）。
 *
 * **fileIds 自体は無事で、番兵だけが失われる位置で切れた場合も「切り詰めあり」と判定される
 * （偽陽性）。これは意図した挙動。** 診断は「異常なし」と誤答するより「切り詰めの疑いあり」
 * と警告側に倒す方が安全であり、番兵1件の追加コスト（`&fileIdsEnd=1` で13文字）は
 * buildRegrantPickerUrl で組み立てるURLの実長に自動的に織り込まれるため、チャンク分割側の
 * 追加対応は不要。
 */
export const PICKER_FILE_IDS_END_PARAM = 'fileIdsEnd';

/**
 * fileIds が末尾まで欠けずに届いたか（番兵 fileIdsEnd が `'1'` か）を判定する純関数。
 * `'1'` のみを有効とし、他の値（欠落・改変）は全て「欠けている」に倒す
 * （既存の isSharedDrivesRequested と同じイディオム）。
 */
export function isRegrantFileIdsComplete(value: string | null | undefined): boolean {
    return value === '1';
}

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
 *
 * **localhost へ直接フラグメントを渡す経路（dev ビルドでの手元検証）では**、setFileIds に
 * 20件→20件、60件→60件、100件→100件と渡した件数がそのまま全件表示されることを実測済み。
 * つまりこの経路では、Picker の初期表示が概ね50件で頭打ちになるという事象は再現しなかった。
 *
 * **ただしこの実測は `chrome.identity.launchWebAuthFlow` を通る実運用の経路を覆っていない。**
 * 実運用では約50件で頭打ちになる事象が報告されており、原因が (a) Picker へ渡すURLがどこかで
 * 切り詰められ fileIds の後半が失われている、(b) Picker 側の表示上限が setFileIds にも
 * 実運用環境では効いている、のどちらなのかはまだ確定していない。chunkRegrantFileIdsForUrl
 * によるURL長ベースの分割と、Pickerページの受信件数表示（src/webapp/picker.ts）は、
 * どちらの原因であっても効くようにするための対策。
 *
 * それでも分割している理由は次の2つ:
 * - fileId の個数上限を Google が文書化していない
 * - Picker ページの URL 長に効く（chunkRegrantFileIdsForUrl の maxCount 引数の既定値として
 *   使う。URL長そのものの上限は REGRANT_PICKER_MAX_URL_LENGTH で別に管理する）
 */
export const REGRANT_PICKER_CHUNK_SIZE = 100;

/**
 * 一括再付与のPickerを1回に開く際のURLの長さの上限（文字数）。
 *
 * ブラウザ・サーバーの実装に依存する「2,083文字」というレガシーなURL長制限の目安に対して
 * 安全余裕を取った値。Drive のファイルIDは概ね33文字前後のため、fileIds の件数が増えると
 * URLがこの目安に近づく、または超えうる（背景は buildRegrantPickerUrl と
 * REGRANT_PICKER_CHUNK_SIZE のコメント参照）。
 */
export const REGRANT_PICKER_MAX_URL_LENGTH = 1800;

/**
 * fileIds を「組み立てた URL の実長」基準で貪欲法により分割する。
 * 先頭から順に buildUrl(ids) で実際に組み立てたURLの長さを測り、maxUrlLength を超えるか
 * チャンクの件数が maxCount に達したら、そのチャンクを確定して次のチャンクへ移る。
 *
 * 1チャンクには必ず1件以上入れる: 1件だけで既に maxUrlLength を超えていても、その1件を
 * 捨てずに単独チャンクとして返す（捨てると復旧対象から黙って脱落し、空チャンクを作って
 * 次に回すと同じ1件を永遠に詰め直そうとして無限ループになる）。
 * fileId の並び順はそのまま保ち、どの fileId もちょうど1回だけどこかのチャンクに現れる。
 * 空配列を渡したら空配列を返す（呼び出し側はPickerを1回も開かない判断に使える）。
 */
export function chunkRegrantFileIdsForUrl(
    fileIds: string[],
    buildUrl: (ids: string[]) => string,
    maxUrlLength = REGRANT_PICKER_MAX_URL_LENGTH,
    maxCount = REGRANT_PICKER_CHUNK_SIZE,
): string[][] {
    if (fileIds.length === 0) return [];
    const count = Math.max(1, maxCount);
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const id of fileIds) {
        const candidate = [...current, id];
        // 今のチャンクが空なら（=1件目）、どれだけ長くても必ず受け入れる（1件以上の原則）。
        const exceedsCount = current.length > 0 && candidate.length > count;
        const exceedsLength = current.length > 0 && buildUrl(candidate).length > maxUrlLength;
        if (exceedsCount || exceedsLength) {
            chunks.push(current);
            current = [id];
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) chunks.push(current);
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
 *
 * パラメータの並び順は mode → redirect → folderId → email → drives → fileIdsCount → fileIds
 * → fileIdsEnd。**切り詰めが起きたときに失って困る順に前へ置く。** fileIds は件数次第で
 * 他のどのパラメータよりも長くなりうるため、URLが何らかの事情（ブラウザ・サーバー側のURL長
 * 制限等）で途中で切り詰められると、その後ろにあるパラメータはまとめて失われる。email が
 * 失われると Pickerページ側のアカウント一致確認（picker.ts の expectedEmail 比較）が黙って
 * スキップされ、drives が失われると共有ドライブ対応が無効になる。どちらも影響が大きいため
 * fileIds より前に置く。fileIdsCount は fileIds の受信件数診断に使うカウントだが、
 * fileIds 自体より後ろに置くと切り詰めで一緒に失われ診断にならないため、fileIds の直前に置く。
 * fileIds は「最後の実データ」として置き、そのさらに後ろに**わざと犠牲にする番兵**
 * `fileIdsEnd` を置く（PICKER_FILE_IDS_END_PARAM 参照）。件数の比較だけでは末尾の fileId が
 * 途中で切れても検知できない場合がある（文字種の検証を通ってしまう）ため、fileIds より後ろに
 * 何か置いて「ここまで無事届いたか」を直接確かめる必要がある。
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
    if (email) params.set('email', email);
    params.set(PICKER_DRIVES_PARAM, '1');
    if (fileIds && fileIds.length > 0) {
        params.set(PICKER_FILE_IDS_COUNT_PARAM, String(fileIds.length));
        params.set(PICKER_FILE_IDS_PARAM, fileIds.join(','));
        params.set(PICKER_FILE_IDS_END_PARAM, '1');
    }
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
