/**
 * 未送信キュー機能モジュール
 *
 * 責務:
 * - 未送信キュー件数のバッジ表示（refreshUnsentBadge）
 * - バッジクリックからの送信、必要なら対話的な再ログインを挟んでの再送信（flushUnsentQueue）
 * - 判定保存 → 失敗時の分類 → 認証失敗ならその場で再ログインを試して1回だけ再試行 →
 *   それでも失敗ならキューへ退避、という判定保存の共通ロジック（saveDecisionOrQueue）
 *
 * 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応: ログイン切れ後の保存失敗が
 * 一律「オフラインキューへ退避」として扱われ、ユーザーが気づかないまま作業を続けた結果、
 * 別環境で開いたときに判定が「未評価」に見える事故につながった。未送信件数を常に見える形にし、
 * 判定クリック直後（＝ユーザー操作の文脈が生きている間）に再ログインを試みることで、
 * キューへ積む前に復旧できるケースを増やす。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { showToast } from '../ui/feedback';
import { saveDecision as apiSaveDecision, getAuthToken } from '../../lib/sheets-api';
import {
    classifySaveFailure,
    shouldAttemptReauth,
    shouldRetryAfterReauth,
    pickSaveFailureToast,
    type SaveFailureKind,
} from '../../lib/save-failure';
import { enqueueDecision, flushDecisionQueue, countQueuedDecisions } from '../utils/offline-queue';
import { createAsyncCoalescer } from '../../lib/async-coalesce';
import type { Decision } from '../../lib/types';

type FlushResult = { flushedCount: number; remainingCount: number };

/** バッジの click ハンドラ登録。bootstrap から1回だけ呼ぶ。 */
export function initUnsentQueue(): void {
    dom.unsentQueueBadge?.addEventListener('click', () => {
        void handleBadgeClick();
    });
}

async function handleBadgeClick(): Promise<void> {
    const { flushedCount, remainingCount } = await flushUnsentQueue({ interactive: true });
    if (remainingCount > 0) {
        showToast(t('screening_unsentRemaining', String(remainingCount)));
    } else if (flushedCount > 0) {
        showToast(t('screening_unsentFlushed', String(flushedCount)));
    }
}

/**
 * 未送信キュー件数バッジを更新する。プロジェクト未接続時は隠す。
 */
export async function refreshUnsentBadge(): Promise<void> {
    const badge = dom.unsentQueueBadge;
    if (!badge) return;

    if (!state.spreadsheetId || !state.userEmail) {
        badge.classList.add('hidden');
        return;
    }

    const count = await countQueuedDecisions(state.spreadsheetId, state.userEmail);
    if (count === 0) {
        badge.classList.add('hidden');
        return;
    }

    badge.textContent = t('screening_unsentBadge', String(count));
    badge.title = t('screening_unsentBadgeHint');
    badge.classList.remove('hidden');
}

// getAuthToken(true) を1本へ合流させる。バッジ連打やほぼ同時の複数保存失敗が、
// 対話的な再認可ポップアップを何本も同時に開いてしまうのを防ぐ
// （createAsyncCoalescer の用途は async-coalesce.ts 参照）。
const coalescedInteractiveAuth = createAsyncCoalescer(async (): Promise<boolean> => {
    try {
        await getAuthToken(true);
        return true;
    } catch (error) {
        console.error('Interactive re-auth failed:', error);
        return false;
    }
});

/** 対話的な再ログインを試みる。成功で true、失敗（キャンセル含む）で false。 */
export function ensureInteractiveAuth(): Promise<boolean> {
    return coalescedInteractiveAuth();
}

/**
 * flush を1回実行し、送信結果に加えて「最後に失敗した保存の分類」も返す。
 * spreadsheetId/userEmail は呼び出し元（flushUnsentQueue）が関数冒頭でキャプチャした値を
 * そのまま受け取る（PR #138 レビュー指摘: flush中に state.spreadsheetId が可変なプロジェクト
 * 切替で書き換わると、キュー識別に使った値と送信コールバックが参照する値がずれ、別シートの
 * Decisionsへ誤って追記されうる。詳細は下記 flushUnsentQueue のコメント）。
 * lastFailureKind は flushDecisionQueue の戻り値の lastError（PR #138 レビュー指摘:
 * 合流した flush の失敗種別が呼び出し元へ伝わらない問題への対応で追加されたフィールド）を
 * 分類して求める。合流した全呼び出しが同じ結果オブジェクトを受け取るため、どのコールバックが
 * 失敗を観測しても対話側（バッジクリック）に届く。
 */
async function runFlushOnce(
    spreadsheetId: string,
    userEmail: string
): Promise<FlushResult & { lastFailureKind: SaveFailureKind | null }> {
    const result = await flushDecisionQueue(
        spreadsheetId,
        userEmail,
        (decision) => apiSaveDecision(spreadsheetId, decision)
    );
    const lastFailureKind = 'lastError' in result
        ? classifySaveFailure(result.lastError, navigator.onLine)
        : null;
    return { flushedCount: result.flushedCount, remainingCount: result.remainingCount, lastFailureKind };
}

/**
 * 未送信キューの送信を試みる。
 * interactive: true（バッジクリック起点）のときは、認証失敗で止まった場合に
 * ensureInteractiveAuth() で再ログインしてからもう一度だけ試す。
 *
 * spreadsheetId/userEmail は関数冒頭で state から一度だけキャプチャし、以降は
 * このキャプチャ値だけを使う（PR #138 レビュー指摘: シートAのflush中にユーザーが
 * handleBack 経由で別プロジェクト（シートB）へ切り替えると、可変な state を再参照する
 * 実装ではAの未送信判定がBのDecisionsへ追記され、Aのキューからは削除されてしまう）。
 */
export async function flushUnsentQueue(options: { interactive: boolean }): Promise<FlushResult> {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;
    if (!spreadsheetId || !userEmail) {
        return { flushedCount: 0, remainingCount: 0 };
    }

    try {
        let { flushedCount, remainingCount, lastFailureKind } = await runFlushOnce(spreadsheetId, userEmail);

        if (options.interactive && remainingCount > 0 && shouldAttemptReauth(lastFailureKind ?? 'other')) {
            const reauthed = await ensureInteractiveAuth();
            if (shouldRetryAfterReauth(lastFailureKind ?? 'other', reauthed)) {
                const retry = await runFlushOnce(spreadsheetId, userEmail);
                flushedCount += retry.flushedCount;
                remainingCount = retry.remainingCount;
            }
        }

        // 表示中のプロジェクトが切り替わっていてもバッジは「今表示中のプロジェクト」を
        // 反映すべきなので、ここだけは state を見たままでよい（refreshUnsentBadge 内で読む）。
        await refreshUnsentBadge();
        return { flushedCount, remainingCount };
    } catch (error) {
        // flushDecisionQueue 自体は各項目の送信失敗を握りつぶすため、ここに来るのは
        // ストレージ書き戻し（chainQueueWrite）側の想定外エラーのみ。呼び出し側（bootstrap の
        // fire-and-forget 呼び出しを含む）を壊さないよう、ログに残して安全な既定値を返す。
        console.error('Queue flush error:', error);
        await refreshUnsentBadge();
        return { flushedCount: 0, remainingCount: await countQueuedDecisions(spreadsheetId, userEmail) };
    }
}

/**
 * 判定を保存し、失敗したらキューへ退避する共通ロジック。
 * screening/actions.ts・ml/actions.ts の両方から呼ぶ（判定ボタン・ML確認判定のどちらも
 * ユーザークリック直後の呼び出しのため、認証失敗ならその場で再ログインを試す）。
 *
 * spreadsheetId/userEmail は関数冒頭で state から一度だけキャプチャする（PR #138
 * レビュー指摘: 再認証の await 中にユーザーが別プロジェクトへ切り替えると、以降 state を
 * 再参照する実装では保存先・キューのキーが元のプロジェクトとずれてしまう）。
 */
export async function saveDecisionOrQueue(
    decision: Decision,
    options: { notifyOnFailure: boolean }
): Promise<void> {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;
    try {
        await apiSaveDecision(spreadsheetId, decision);
    } catch (error) {
        console.error('Failed to save decision:', error);
        let kind = classifySaveFailure(error, navigator.onLine);

        if (shouldAttemptReauth(kind)) {
            const reauthed = await ensureInteractiveAuth();
            if (shouldRetryAfterReauth(kind, reauthed)) {
                try {
                    await apiSaveDecision(spreadsheetId, decision);
                    await flushUnsentQueue({ interactive: false });
                    return;
                } catch (retryError) {
                    console.error('Failed to save decision after re-auth:', retryError);
                    kind = classifySaveFailure(retryError, navigator.onLine);
                }
            }
        }

        await enqueueDecision(spreadsheetId, userEmail, decision);
        await refreshUnsentBadge();
        if (options.notifyOnFailure) {
            const toast = pickSaveFailureToast(kind);
            showToast(t(toast.messageKey), toast.duration);
        }
        return;
    }

    await flushUnsentQueue({ interactive: false });
}
