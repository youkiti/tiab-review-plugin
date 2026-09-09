/**
 * drive-regrant-picker.ts - 読み取り権限の再付与（mode=regrant の Picker）をUI非依存で起動する
 *
 * Issue #69 でフルテキストページ（`src/fulltext/`）の左ペインからも再付与を起動する必要が
 * 生じたため、`src/sidepanel/features/fulltext-regrant.ts` から
 * **Picker 起動とリダイレクト解析だけ**を抜き出したモジュール。
 * モーダル・トースト・検知結果の表示は呼び出し側（UI層）の責務として残す
 * （このモジュールは `state` / `dom` / `showToast` に依存しない）。
 *
 * `chrome.identity.launchWebAuthFlow` は拡張機能ページであればサイドパネル以外でも動くため、
 * フルテキストページ（`fulltext.html`）から呼んでも制約は無い。
 *
 * 付与そのものはユーザーが Picker で「選択」を押した時点でサーバー側に確定する。
 * したがって戻り値の件数は**進捗表示のヒントでしかなく**、真値としては使わないこと
 * （真値は `listAccessibleFileIdsInFolder` の再取得や、PDF の再ダウンロードで取り直す）。
 */

import { buildRegrantPickerUrl, chunkRegrantFileIdsForUrl } from './picker-url';
import { parseRegrantPickerRedirect } from './drive-picker-result';

export type RegrantPickerOutcome =
    /** Picker が正常に閉じた（granted は選択件数。0件でありうる） */
    | { status: 'granted'; granted: number }
    /** ユーザーがキャンセル、またはリダイレクトを受け取れなかった */
    | { status: 'cancelled' }
    /** リダイレクトは来たが解釈できなかった（呼び出し側でエラー表示する） */
    | { status: 'parse-error' };

/**
 * chrome.identity.launchWebAuthFlow の失敗が「ユーザーがウィンドウを閉じた/キャンセルした」
 * ものかを、例外メッセージ（chrome.runtime.lastError由来）から best-effort で判定する。
 * 該当すればサイレントに終了し、それ以外（ネットワークエラー等）は呼び出し側でエラー表示する。
 */
export function isUserCancelledAuthError(message: string): boolean {
    return /did not approve|cancel|closed the window|dismissed/i.test(message || '');
}

/**
 * fulltextフォルダを初期表示にした mode=regrant の Picker を開く。
 * キャンセル・解析失敗は戻り値で表現し、例外は投げない。
 * launchWebAuthFlow 自体の失敗（キャンセル以外。ネットワークエラー等）だけを投げる。
 *
 * fileIds（Issue #203）を渡すと、Pickerページ側は folderId 全体ではなく
 * 「その fileIds だけ」を表示する（buildRegrantPickerUrl / src/webapp/picker.ts 参照）。
 * 省略時・空配列のときは従来どおりフォルダ全体の初期表示のまま変わらない。
 *
 * redirectUri は省略時のみ自分で chrome.identity.getRedirectURL('picker') を呼ぶ。
 * runRegrantPickerChunks から呼ばれる場合は、チャンク分割時にURL長を測るのに使った
 * redirectUri と、実際にPickerを開くときの redirectUri を一致させる必要があるため、
 * そちらが解決済みの値を渡してくる（同モジュールの runRegrantPickerChunks 参照）。
 */
export async function runRegrantPickerFlow(options: {
    folderId: string;
    email?: string;
    fileIds?: string[];
    redirectUri?: string;
}): Promise<RegrantPickerOutcome> {
    const redirectUri = options.redirectUri ?? chrome.identity.getRedirectURL('picker');
    const url = buildRegrantPickerUrl({
        email: options.email,
        redirectUri,
        folderId: options.folderId,
        fileIds: options.fileIds,
    });

    let redirectUrl: string | undefined;
    try {
        redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (err) {
        if (isUserCancelledAuthError((err as Error).message)) return { status: 'cancelled' };
        throw err;
    }
    if (!redirectUrl) return { status: 'cancelled' };

    // Pickerページの実装不備・想定外の遷移を疑い、拡張機能自身が発行したリダイレクトURIで
    // 始まっていることを確認してから解析する。
    if (!redirectUrl.startsWith(redirectUri)) {
        console.warn('[drive-regrant-picker] 想定外のリダイレクトURLを受信しました:', redirectUrl);
        return { status: 'parse-error' };
    }

    const parsed = parseRegrantPickerRedirect(redirectUrl);
    if (parsed === null) return { status: 'parse-error' };
    if (parsed === 'cancelled') return { status: 'cancelled' };
    return { status: 'granted', granted: parsed.granted };
}

/** runRegrantPickerChunks の戻り値（Issue #203）。 */
export interface RegrantPickerChunkedOutcome {
    /** 分割後の総チャンク数 */
    total: number;
    /** 実際に開いた（＝ユーザーが「選択」を押した）チャンク数 */
    opened: number;
    /** ループを終わらせた理由。'completed' は全チャンクを開き切った */
    stoppedBy: 'completed' | 'cancelled' | 'parse-error';
}

/**
 * 「読めないPDFのfileIdだけ」を表示する mode=regrant の Picker を、fileIds を
 * 組み立てたURLの実長基準で分割してチャンクごとに開き直す（Issue #203、chunkRegrantFileIdsForUrl
 * 参照）。UI非依存（このモジュール冒頭のコメントの原則どおり、state/dom/showToast/DOM APIに触れない）。
 *
 * チャンク分割には実際に開くURLが要るため、buildRegrantPickerUrl で測る。**測るURLと実際に
 * 開くURLを一致させる**ために、redirectUri をこの関数の中で1箇所だけ決め（省略時は
 * chrome.identity.getRedirectURL('picker')）、分割時の buildUrl と openPicker への引数の
 * 両方へ同じ値を渡す。redirectUri が buildUrl と openPicker でズレると、分割の根拠にした
 * URL長と実際に開くURLの長さが食い違い、分割の意味が無くなるため。
 *
 * 各チャンクの Picker が 'granted' 以外（'cancelled' / 'parse-error'）で閉じたら、
 * その時点で残りのチャンクは開かずに打ち切る。打ち切らないと、ユーザーは
 * チャンク数だけキャンセルを押さないとフローを抜けられなくなるため。
 * ただし打ち切っても、そこまでの選択でサーバー側の付与は既に確定している
 * （drive.file の付与はPickerで「選択」を押した時点で確定するため）。
 * よって呼び出し側は stoppedBy の値に関わらず、必ず再検知（files.list の取り直し）へ
 * 進むこと。
 *
 * launchWebAuthFlow 自体の失敗（キャンセル以外。ネットワークエラー等）は
 * runRegrantPickerFlow がそのまま投げるため、ここでは catch せず呼び出し側へ伝播させる。
 */
export async function runRegrantPickerChunks(options: {
    folderId: string;
    fileIds: string[];
    email?: string;
    /**
     * 各チャンクのPickerを開くURLと、分割時にURL長を測るURLの両方に使う redirectUri。
     * 省略時は chrome.identity.getRedirectURL('picker') を呼ぶ。テストからはこれを注入する
     * ことで、fileIds が非空でも chrome.identity に触れずに分割結果まで検証できる。
     */
    redirectUri?: string;
    /** 各チャンクのPickerを開く直前に呼ぶ。index は0始まり、remainingはこの回を含む未処理のfileId件数 */
    onChunkStart?: (progress: { index: number; total: number; remaining: number }) => void;
    /**
     * 1チャンク分のPickerを開く関数の差し替え口。既定は runRegrantPickerFlow。
     * chrome.identity に依存する runRegrantPickerFlow を経由せずにループ制御（打ち切り判断・
     * remaining計算・チャンクの分割と消費）だけを検証するテストのための依存注入（Issue #203）。
     * 本番の呼び出し側（src/sidepanel/features/fulltext/regrant.ts）は指定しないため、
     * これまでどおり実物の runRegrantPickerFlow がそのまま動く。
     */
    openPicker?: (args: { folderId: string; email?: string; fileIds: string[]; redirectUri: string }) => Promise<RegrantPickerOutcome>;
}): Promise<RegrantPickerChunkedOutcome> {
    const openPicker = options.openPicker ?? runRegrantPickerFlow;
    if (options.fileIds.length === 0) return { total: 0, opened: 0, stoppedBy: 'completed' };

    // fileIds が空なら上のreturnで既に抜けているため、ここに到達する時点で分割が必要。
    // chrome.identity に触れないテスト（fileIds空のケース）を壊さないよう、必要になるまで呼ばない。
    const redirectUri = options.redirectUri ?? chrome.identity.getRedirectURL('picker');
    const buildUrl = (ids: string[]): string => buildRegrantPickerUrl({
        email: options.email,
        redirectUri,
        folderId: options.folderId,
        fileIds: ids,
    });
    // options.fileIds が非空である以上 chunkRegrantFileIdsForUrl は必ず1件以上のチャンクを返す
    // （「1チャンクには必ず1件以上入れる」という同関数の保証）ため、ここでの空チェックは不要。
    const chunks = chunkRegrantFileIdsForUrl(options.fileIds, buildUrl);

    let processed = 0;
    let opened = 0;
    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const remaining = options.fileIds.length - processed;
        options.onChunkStart?.({ index, total: chunks.length, remaining });

        const outcome = await openPicker({
            folderId: options.folderId,
            email: options.email,
            fileIds: chunk,
            redirectUri,
        });
        if (outcome.status !== 'granted') {
            return { total: chunks.length, opened, stoppedBy: outcome.status };
        }
        opened++;
        processed += chunk.length;
    }
    return { total: chunks.length, opened, stoppedBy: 'completed' };
}
