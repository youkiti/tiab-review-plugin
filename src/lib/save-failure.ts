// 判定保存失敗の分類。UI・DOM・state には一切依存しない純関数のみを置く。
//
// 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応: 判定保存が失敗したとき
// 「ログイン切れ（再ログインすれば直る）」なのか「オフライン」なのか「それ以外（権限不足・
// クォータ超過など再ログインでは直らないもの）」なのかを区別できないまま一律オフラインキューへ
// 退避していたため、ログイン切れに気づかないまま作業を続け、後から「未評価」に見える事故が
// 起きた。呼び出し側（UI層）がこの分類を見て、再ログイン導線を出すかどうかを判断する。

import { SheetsAccessDeniedError } from './sheets-api';

export type SaveFailureKind = 'auth' | 'offline' | 'other';

// トークン失効・未認可を示すエラーメッセージのパターン。
// Google Identity Services 側の 'interaction_required'（サイレント再取得不可）、
// Sheets API 側の 401/invalid_grant/認証情報関連文言を拾う。
// 裸の 'token' は使わない。API がHTMLエラーページ等を返して response.json() が失敗したときの
// 「Unexpected token '<' ...」のようなJSONパースエラーまで auth 扱いになり、不要な再認可
// ポップアップと誤った案内につながるため。実際に出る文言（Google側の401本文
// "Request had invalid authentication credentials. Expected OAuth 2 access token, ..."、
// および fetch の response.statusText "Unauthorized"）に絞る。
const AUTH_ERROR_PATTERN = /\b401\b|unauthorized|invalid (?:authentication )?credentials|invalid_grant|access token/i;

/**
 * 判定保存の失敗を分類する。
 * - online が false のときは、エラー内容を見るまでもなく 'offline'
 * - 401や認証情報関連の文言を含むエラーは 'auth'（再ログインで直る可能性がある）
 * - SheetsAccessDeniedError（403/404）は権限不足で、再ログインしても直らないため 'other'
 * - それ以外は 'other'
 */
export function classifySaveFailure(error: unknown, online: boolean): SaveFailureKind {
    if (!online) return 'offline';

    if (error instanceof SheetsAccessDeniedError) return 'other';

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('interaction_required') || AUTH_ERROR_PATTERN.test(message)) {
        return 'auth';
    }

    return 'other';
}

/**
 * 保存失敗が 'auth' のとき、再ログインを試すべきかどうか。
 * 'offline' / 'other' は再ログインでは直らないため試さない。
 */
export function shouldAttemptReauth(kind: SaveFailureKind): boolean {
    return kind === 'auth';
}

/**
 * 再ログインを試した後、保存を1回だけ再試行すべきかどうか。
 * 'auth' 以外は再ログインを試していない（呼び出し側で分岐済み）ため false。
 * 'auth' でも再ログイン自体が失敗した場合は再試行しても無駄なので false。
 */
export function shouldRetryAfterReauth(kind: SaveFailureKind, reauthSucceeded: boolean): boolean {
    return kind === 'auth' && reauthSucceeded;
}

export type SaveFailureToastKey =
    | 'screening_reloginQueued'
    | 'screening_offlineQueued'
    | 'screening_saveFailedQueued';

export type SaveFailureToast = { messageKey: SaveFailureToastKey; duration: number };

// トースト表示時間。既定の2000msは短く読み切れないため、再ログイン導線が要る auth と、
// 原因の分かりにくい other は長め（5000ms）にする。offline は既存文言・既存の長さを維持する。
const DEFAULT_TOAST_DURATION = 2000;
const LONGER_TOAST_DURATION = 5000;

/**
 * 保存失敗の種類から、キュー退避後に出すトーストのメッセージキーと表示時間を選ぶ。
 * 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応: 一律「オフラインのため
 * キューへ保存しました」だったものを、実際の原因（ログイン切れ/オフライン/その他）で
 * 出し分ける。
 */
export function pickSaveFailureToast(kind: SaveFailureKind): SaveFailureToast {
    switch (kind) {
        case 'auth':
            return { messageKey: 'screening_reloginQueued', duration: LONGER_TOAST_DURATION };
        case 'offline':
            return { messageKey: 'screening_offlineQueued', duration: DEFAULT_TOAST_DURATION };
        case 'other':
            return { messageKey: 'screening_saveFailedQueued', duration: LONGER_TOAST_DURATION };
    }
}
