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
 * - related_ref_id が非空（Issue #118 チャンク3: registration行から取り込んだ論文行）:
 *   無条件で候補（下記いずれの評価よりも先に判定する）。取り込んだ論文行はTiAb票を
 *   一切持たない（screening_setの対象外で通常のTiAbスクリーニングを経ないため）ので、
 *   fulltext_set / poolRule / TiAb Include票のいずれで判定してもプールから落ちてしまう
 *   （Issue #118 実装内容9）。
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
    ref: Pick<Reference, 'fulltext_set' | 'related_ref_id'>;
    decisions: Decision[];
    poolRule: FulltextPoolRule | null;
    assignment: FulltextAssignmentConfig;
    userEmail: string;
    isAdmin: boolean;
}): boolean {
    const { ref, decisions, poolRule, assignment, userEmail, isAdmin } = input;

    if ((ref.related_ref_id || '').trim() !== '') return true;

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
 * プロジェクト全体集計（PRISMA・論文用テキスト・エクスポート）用の候補判定。
 * ログインユーザー非依存であることが要件。
 * - related_ref_id が非空（取り込んだ論文行）: 無条件で候補（isFulltextCandidateRef と同じ理由。
 *   Issue #118 実装内容9）
 * - 割り振り設定済み: fulltext_set 非空 ∪ プールルール成立
 * - 未設定: poolRule 成立、ルール無しなら「誰かの TiAb Include が1件でもある」
 *   （旧 isProjectFulltextCandidate と同セマンティクス）
 */
export function isProjectFulltextCandidateRef(input: {
    ref: Pick<Reference, 'fulltext_set' | 'related_ref_id'>;
    decisions: Decision[];
    poolRule: FulltextPoolRule | null;
    assignment: FulltextAssignmentConfig;
}): boolean {
    const { ref, decisions, poolRule, assignment } = input;

    if ((ref.related_ref_id || '').trim() !== '') return true;

    if (assignment.status === 'configured' && (ref.fulltext_set || '').trim() !== '') {
        return true;
    }

    if (poolRule) {
        return isInFulltextPool(decisions, poolRule);
    }

    return decisions.some(d => isTiabDecision(d) && d.decision === 'include');
}

/**
 * チーム進捗など「全員で一致すべき分母」用の共有プールメンバー判定（ユーザー非依存）。
 * - related_ref_id が非空（取り込んだ論文行）: 無条件で候補
 * - 割り振り設定済み: fulltext_set 非空 ∪ プールルール成立（未割り当て流入分）
 * - 未設定: プールルール成立のみ（ルール無しなら false）
 *
 * isFulltextCandidateRef と違い、ルール未設定時の「自分のInclude」フォールバックを持たない
 * （それはユーザー依存のため共有分母に使えない）。
 *
 * 【related_ref_id チェックを追加した判断（Issue #118 チャンク3）】
 * この関数は Issue 本文が名指ししていない（isFulltextCandidateRef /
 * isProjectFulltextCandidateRef の2関数のみ名指し）が、以下の理由でここにも同じ分岐を追加した:
 * - 「自分のInclude」フォールバックを持たない理由（ユーザー依存だから共有分母に使えない）と違い、
 *   related_ref_id の非空は文献そのものの属性であり、誰から見ても同じ値になる
 *   （ユーザー依存ではない＝この関数の「全員で一致すべき分母」という要件と矛盾しない）。
 * - ここで分岐を追加しないと、isFulltextCandidateRef（個々のレビュアーが見る候補一覧）は
 *   取り込んだ論文行を候補に含めるのに、team-progress.ts の共有分母（本関数が算出する
 *   poolRefIds）には含まれないという不整合が生まれる。team-progress.ts はこの
 *   poolRefIds を fulltextTotal（分母）だけでなく fulltextDone（分子）の絞り込みにも使うため、
 *   分岐が無いと「取り込んだ論文行をフルテキスト判定しても進捗にカウントされない」まま
 *   チーム進捗から静かに欠落し続ける。
 *
 * 【注意】この分岐が本番で効くには、呼び出し元が渡す ref が related_ref_id を実際に運んでいる
 * 必要がある。TeamProgressRef（team-progress.ts）は Reference を絞り込んだ最小形のため、
 * related_ref_id を持たせ忘れると型は Pick<Reference, ...> に構造的に適合してしまい
 * typecheck では検出できないまま、この分岐が一度も発火しなくなる（実際に一度これで見落とした）。
 */
export function isSharedFulltextPoolMember(input: {
    ref: Pick<Reference, 'fulltext_set' | 'related_ref_id'>;
    decisions: Decision[];
    poolRule: FulltextPoolRule | null;
    assignment: FulltextAssignmentConfig;
}): boolean {
    const { ref, decisions, poolRule, assignment } = input;

    if ((ref.related_ref_id || '').trim() !== '') return true;

    if (assignment.status === 'configured' && (ref.fulltext_set || '').trim() !== '') {
        return true;
    }

    return poolRule ? isInFulltextPool(decisions, poolRule) : false;
}
