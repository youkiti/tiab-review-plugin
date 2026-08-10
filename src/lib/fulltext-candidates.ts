// fulltext-candidates.ts - フルテキスト候補判定の Single Source of Truth
//
// これまで「1文献がフルテキスト候補か」の判定は
//   - src/sidepanel/features/screening/filters.ts の isFulltextCandidate（state依存）
//   - src/sidepanel/store/selectors.ts の isFulltextCandidate（引数版）
//   - src/fulltext/fulltext.ts の recomputeCandidates 内インライン実装
// の3か所に重複実装されていた。全て「判定票にプールルールを適用」して毎回計算するため、
// Blind中（key_opened=FALSE）は他人の票が読み込まれず候補が空になる問題があった。
//
// 一方 References シートの fulltext_set 列には、担当割り振り生成時にプール確定済みの
// 文献へ ft-group-N が書き込まれている。この列は判定票に依存しないため、Blind中でも
// 全員が同じ値を見られる。担当割り振り設定済みのプロジェクトでは、これを優先して使う
// ことで Blind 中の候補一覧を全員一致させる。
//
// このモジュールは純関数のみで、DOM・state に依存しない。

import type { Decision, Reference } from './types';
import { isInFulltextPool, isTiabDecision, type FulltextPoolRule } from './fulltext-pool';
import type { FulltextAssignmentConfig } from './fulltext-assignment';

/**
 * 1文献がフルテキスト候補か
 *
 * - assignment.status === 'configured'（担当割り振り設定済み）:
 *   `候補 = fulltext_set が非空の文献 ∪ プールルール評価で候補入りするが fulltext_set が空の文献`
 *   前者は判定票に依存しないため Blind 中でも全員が同じ集合を見られる。
 *   後者（未割り当て流入分）はロード済みの票でベストエフォート評価する
 *   （Blind中の非管理者には見えなくてよい。管理者がキーを開けば見える）。
 * - assignment.status === 'none'（未設定）: 従来ロジック
 *   - poolRule あり: isInFulltextPool（採用voter + 必要票数）で判定
 *   - poolRule なし: decisions に TiAb の include があり、(isAdmin || その票の reviewer_id === userEmail)
 */
export function isFulltextCandidateRef(input: {
    ref: Pick<Reference, 'fulltext_set'>;
    decisions: Decision[];
    poolRule: FulltextPoolRule | null;
    assignment: FulltextAssignmentConfig;
    userEmail: string;
    isAdmin: boolean;
}): boolean {
    const { ref, decisions, poolRule, assignment, userEmail, isAdmin } = input;

    if (assignment.status === 'configured' && (ref.fulltext_set || '').trim() !== '') {
        return true;
    }

    // 未設定、または割り振り済みだが fulltext_set が空（未割り当て流入分）はプールルール評価
    if (poolRule) {
        return isInFulltextPool(decisions, poolRule);
    }

    return decisions.some(d =>
        d.decision === 'include' &&
        isTiabDecision(d) &&
        (isAdmin || d.reviewer_id === userEmail)
    );
}

/**
 * チーム進捗など「全員で一致すべき分母」用の共有プールメンバー判定（ユーザー非依存）。
 * - 割り振り設定済み: fulltext_set 非空 ∪ プールルール成立（未割り当て流入分）
 * - 未設定: プールルール成立のみ（ルール無しなら false）
 *
 * isFulltextCandidateRef と違い、ルール未設定時の「自分のInclude」フォールバックを持たない
 * （それはユーザー依存のため共有分母に使えない）。
 */
export function isSharedFulltextPoolMember(input: {
    ref: Pick<Reference, 'fulltext_set'>;
    decisions: Decision[];
    poolRule: FulltextPoolRule | null;
    assignment: FulltextAssignmentConfig;
}): boolean {
    const { ref, decisions, poolRule, assignment } = input;

    if (assignment.status === 'configured' && (ref.fulltext_set || '').trim() !== '') {
        return true;
    }

    return poolRule ? isInFulltextPool(decisions, poolRule) : false;
}
