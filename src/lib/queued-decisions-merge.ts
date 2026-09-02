// 読み込んだ文献一覧に、未送信のオフラインキュー内の判定を重ねる純関数。
//
// 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応: 判定保存がオフラインキューへ
// 退避された場合、サーバ側（Decisionsタブ）にはまだ書き込まれていないため、その状態で文献一覧を
// 再取得すると判定が「未評価」に戻って見えてしまっていた（キューの中身は消えていないが、画面上は
// 消えたように見える）。読み込んだ一覧にキュー内容をマージすることで、未送信でも自分が付けた
// 判定として表示を保つ。

import type { Decision, ReferenceWithStatus } from './types';

/**
 * `refs` に `queued`（未送信キューの判定）をマージした新しい配列を返す。
 * - 対象は tiab フェーズの判定のみ（フルテキストはオフラインキューを使わないため無視する）
 * - 同じ ref_id のキュー項目が複数あれば decided_at が最新の1件を使う
 * - キュー項目の decided_at が ref.myDecision?.decided_at より新しい場合（または myDecision が
 *   無い場合）だけ myDecision を差し替え、status を再計算する
 *   （sheets-api.ts の getReferencesWithStatus と同じ規則: decision !== 'pending' ならその
 *   decision、それ以外は 'pending'）
 * - ただし ref.hasConflict === true（キー開封後の不一致表示）の場合は status を維持し、
 *   myDecision だけ更新する
 * - `keyOpened` が true かつ allDecisions が配列で存在する場合（キー開封後）は、自分の
 *   reviewer_id の要素を差し替える（無ければ push）。`keyOpened` が false（Blind中）のときは
 *   allDecisions に一切触れない。getReferencesWithStatus はBlind中、allDecisions に
 *   LLM判定だけの配列を入れて返すため、ここで無条件に自分のhuman判定を差し込むと
 *   Blind中にAI Evidenceハイライトへ人間の判定が混入してしまう
 *   （screening/actions.ts の handleDecision も state.isKeyOpened && ref.allDecisions の
 *   ときだけ allDecisions を更新している）
 * - 入力の配列・要素は破壊せず、更新したrefだけ新しいオブジェクトを返す
 *   （対象外のrefはそのまま同一参照を返してよい）
 */
export function mergeQueuedDecisions<T extends ReferenceWithStatus>(
    refs: T[],
    queued: Decision[],
    keyOpened: boolean
): T[] {
    const latestByRefId = new Map<string, Decision>();
    queued.forEach((decision) => {
        // フルテキストフェーズの判定はキューを使わないため対象外
        if ((decision.screening_phase ?? 'tiab') !== 'tiab') return;
        const refId = decision.ref_id;
        if (!refId) return;
        const existing = latestByRefId.get(refId);
        if (!existing || decision.decided_at > existing.decided_at) {
            latestByRefId.set(refId, decision);
        }
    });

    if (latestByRefId.size === 0) return refs;

    return refs.map((ref) => {
        const queuedDecision = latestByRefId.get(ref.ref_id);
        if (!queuedDecision) return ref;

        const currentDecidedAt = ref.myDecision?.decided_at;
        if (currentDecidedAt && queuedDecision.decided_at <= currentDecidedAt) {
            return ref;
        }

        const status = ref.hasConflict === true
            ? ref.status
            : (queuedDecision.decision !== 'pending' ? queuedDecision.decision : 'pending');

        const next: T = { ...ref, myDecision: queuedDecision, status };

        if (keyOpened && Array.isArray(ref.allDecisions)) {
            const index = ref.allDecisions.findIndex((d) => d.reviewer_id === queuedDecision.reviewer_id);
            next.allDecisions = index >= 0
                ? ref.allDecisions.map((d, i) => (i === index ? queuedDecision : d))
                : [...ref.allDecisions, queuedDecision];
        }

        return next;
    });
}
