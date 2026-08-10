// fulltext-empty-reason.ts - フルテキスト候補「0件」の理由判定（純関数）
//
// フルテキスト候補リストは fulltext_pool_rule（Config）を判定票に適用して計算されるが、
// Blind中（key_opened=FALSE）は他レビュアーの人間票がクライアントにロードされないため、
// ルールの voter が「自分以外の人間」だと全文献0票→候補0件になる。
// このとき従来は一律で fulltext_emptyList（「候補がまだありません」）を出しており、
// 「まだTiAbが終わっていない」と誤認させる（実際に研究チームで混乱が起きた）。
// この関数は0件の理由を切り分け、UI側（サイドパネル/全文閲覧ウィンドウ）が
// 理由に応じたメッセージを出し分けられるようにする。

import type { FulltextPoolRule } from './fulltext-pool';

export type FulltextEmptyReason =
    | 'rule_unevaluable_blind'   // ルールvotersに自分以外のhuman票が含まれ、かつ keyOpened=false
    | 'assignment_mismatch'      // fulltext_set列に件数があるのに候補0件（データ矛盾）
    | 'filtered_out'             // 担当セットのチェックボックス絞り込みで0件になっただけ
    | 'no_candidates';           // 本当にまだ候補が無い（従来メッセージ）

/**
 * フルテキスト候補が0件になった理由を判定する
 *
 * 優先順位:
 *   ① candidateCountBeforeSetFilter > 0 → 'filtered_out'
 *      （担当セット絞り込み前は候補があった＝絞り込みで0件になっただけ）
 *   ② poolRule があり、voters に human: プレフィックスで自分以外のキーが1つでも含まれ、
 *      かつ !keyOpened → 'rule_unevaluable_blind'
 *      （Blind中は他レビュアーの人間票が読み込まれないため、そのvoterの票は常に0票扱いになる）
 *   ③ assignedSetCount > 0 → 'assignment_mismatch'
 *      （担当割り振りには登録があるのに候補が計算できていないデータ矛盾）
 *   ④ それ以外 → 'no_candidates'
 *
 * ml: / llm: の voter は判定対象外（Blindで隠れるのは人間票のみのため）。
 */
export function explainEmptyFulltextCandidates(input: {
    poolRule: FulltextPoolRule | null;
    keyOpened: boolean;
    userEmail: string;
    /** References 全件のうち fulltext_set 列が非空の件数 */
    assignedSetCount: number;
    /** 担当セット絞り込み適用前の候補件数 */
    candidateCountBeforeSetFilter: number;
    /** 絞り込み適用後の候補件数（=表示件数） */
    visibleCandidateCount: number;
}): FulltextEmptyReason | null {
    const {
        poolRule,
        keyOpened,
        userEmail,
        assignedSetCount,
        candidateCountBeforeSetFilter,
        visibleCandidateCount,
    } = input;

    if (visibleCandidateCount > 0) return null;

    if (candidateCountBeforeSetFilter > 0) return 'filtered_out';

    if (poolRule && !keyOpened && hasOtherHumanVoter(poolRule, userEmail)) {
        return 'rule_unevaluable_blind';
    }

    if (assignedSetCount > 0) return 'assignment_mismatch';

    return 'no_candidates';
}

/** poolRule の voters に、自分以外の human: voter が1つでも含まれるか */
function hasOtherHumanVoter(poolRule: FulltextPoolRule, userEmail: string): boolean {
    const normalizedSelf = userEmail.trim().toLowerCase();
    return poolRule.voters.some(voter => {
        if (!voter.startsWith('human:')) return false;
        const voterEmail = voter.slice('human:'.length).trim().toLowerCase();
        return voterEmail !== normalizedSelf;
    });
}
