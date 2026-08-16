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

import { buildRegrantPickerUrl } from './picker-url';
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
 */
export async function runRegrantPickerFlow(options: {
    folderId: string;
    email?: string;
}): Promise<RegrantPickerOutcome> {
    const redirectUri = chrome.identity.getRedirectURL('picker');
    const url = buildRegrantPickerUrl({ email: options.email, redirectUri, folderId: options.folderId });

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
