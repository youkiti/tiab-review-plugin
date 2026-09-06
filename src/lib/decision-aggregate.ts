import type { Decision } from './types';

/**
 * 自分のフルテキストフェーズ判定を ref_id 別にマップ化（最新優先）
 * TiAb 画面の集計からは除外されるが、フルテキストタブの状態表示に使う
 */
export function buildMyFulltextDecisionMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    normalizedReviewerEmail: string
): Map<string, Decision> {
    const map = new Map<string, Decision>();
    if (!normalizedReviewerEmail) return map;
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId || reviewerId !== normalizedReviewerEmail) return;
        const existing = map.get(refId);
        if (!existing || (decision.decided_at || '') > (existing.decided_at || '')) {
            map.set(refId, decision);
        }
    });
    return map;
}

/**
 * 全レビュアー（および有効な LLM）のフルテキストフェーズ判定を ref_id 別にマップ化する。
 * TiAb の allDecisions と同じ構造で、結果集計（判定者選択・OR合議・不一致検出）に使う。
 * 無効な LLM 判定（active Run 配下でない reviewer_id）は除外する。
 * 入力の Decision は書き換えない（正規化はコピーへ行う。Issue #153）
 */
export function buildAllFulltextDecisionsMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    activeFulltextAiRound: string | null
): Map<string, Decision[]> {
    const map = new Map<string, Decision[]>();
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        const reviewerId = (decision.reviewer_id || '').trim();
        if (refId !== decision.ref_id || (reviewerId && reviewerId !== decision.reviewer_id)) {
            decision = { ...decision, ref_id: refId, reviewer_id: reviewerId || decision.reviewer_id };
        }
        // フルテキストAI判定(llm:)は「採用ラウンド」のものだけを有効にする。
        // 採用ラウンド未設定、または別ラウンドの判定は集計から除外する。
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!activeFulltextAiRound || decision.reviewer_id !== activeFulltextAiRound) {
                return;
            }
        }
        const list = map.get(refId);
        if (list) list.push(decision);
        else map.set(refId, [decision]);
    });
    return map;
}

/**
 * 不一致を検出
 * - 2人以上の判定がある場合、判定内容が異なれば不一致
 * - どちらか一方が未判定（pendingまたは判定なし）の場合も不一致
 *
 * PR #138 レビュー指摘（未送信キューのマージ後に hasConflict/status が再計算されない問題）:
 * `src/lib/queued-decisions-merge.ts` の `mergeQueuedDecisions` からも同じ規則で
 * hasConflict を再計算できるよう export する（実装はここまで変更していない）。
 */
export function detectConflict(decisions: Decision[]): boolean {
    // 判定がない、または1人のみの場合は不一致なし
    if (decisions.length === 0) {
        return false;
    }

    if (decisions.length === 1) {
        // 1人だけ判定済み = もう1人が未判定 = 不一致
        return true;
    }

    // 2人以上の判定がある場合、判定内容をチェック
    const uniqueDecisions = new Set(decisions.map(d => d.decision));
    return uniqueDecisions.size > 1;
}

