/**
 * fulltext-pdf-access.ts - PDFペインが取得に失敗したときの「見せ方」を決める純粋関数
 *
 * Issue #69: 以前のフルテキストページは、Drive API での PDF 取得に失敗すると
 * Drive のプレビュー埋め込み（`https://drive.google.com/file/d/{id}/preview`）へ
 * フォールバックしていた。しかし Drive は `/preview` に対して
 * `frame-ancestors https://drive.google.com` を返すため、`chrome-extension://` の
 * ページからは**構造的に埋め込めない**（拡張機能側の CSP 設定では上書きできない）。
 * 結果として左ペインが無言で空になり、ユーザーには原因も復旧手段も分からなかった。
 *
 * 代わりに失敗の種別で案内を出し分ける。判定の元になる型付きエラーは
 * `downloadDriveFile()` が `classifyDriveApiStatus()` の分類から生成しているため、
 * **ここでステータスコードを見て分岐し直さないこと**（判定器を二重に持たない）。
 *
 * `not-granted` と「Drive から完全に削除された」は API から区別できない
 * （どちらも 403/404 になり、`files.get` も同じ理由で失敗するため追加の問い合わせでも割れない）。
 * そのため文言では両方の可能性に触れ、切り分けは再付与フローの結果に委ねる
 * （Picker で選び直しても読めないなら、そのファイルはもう存在しない）。
 */

import { DriveAccessDeniedError, DriveAuthError, DriveTransientError } from './drive-api';

export type PdfLoadFailureKind =
    /** このアカウントに drive.file が未付与（または Drive から削除済み） */
    | 'not-granted'
    /** 認証切れ。再ログインで解消しうる */
    | 'auth-error'
    /** 5xx / 429 / ネットワーク断など。時間をおけば直りうる */
    | 'transient'
    /** 上記のいずれにも分類できない失敗。未付与と断定しない */
    | 'unknown';

export interface PdfLoadFailureView {
    kind: PdfLoadFailureKind;
    /** ペインに出す本文の i18n キー（`src/_locales/{ja,en}/messages.json`） */
    messageKey: string;
    /** 再付与（Picker）を主導線として出すか。未付与のときだけ true */
    showRegrant: boolean;
    /** 「再試行」を出すか。原因が恒久的な未付与のときは出さない */
    showRetry: boolean;
}

/**
 * PDF 取得の失敗を、ペインに出す案内へ変換する。
 * 分類できない失敗（`unknown`）を未付与として扱わないのが要点で、
 * 「再付与しても直らない」案内を出さないための安全側の既定になっている。
 */
export function describePdfLoadFailure(error: unknown): PdfLoadFailureView {
    if (error instanceof DriveAccessDeniedError) {
        return {
            kind: 'not-granted',
            messageKey: 'fulltext_pdfPaneNotGranted',
            showRegrant: true,
            showRetry: false,
        };
    }
    if (error instanceof DriveAuthError) {
        return {
            kind: 'auth-error',
            messageKey: 'fulltext_driveAuthError',
            showRegrant: false,
            showRetry: true,
        };
    }
    if (error instanceof DriveTransientError) {
        return {
            kind: 'transient',
            messageKey: 'fulltext_driveTransientError',
            showRegrant: false,
            showRetry: true,
        };
    }
    return {
        kind: 'unknown',
        messageKey: 'fulltext_pdfPaneLoadFailed',
        showRegrant: false,
        showRetry: true,
    };
}
