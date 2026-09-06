/**
 * フルテキスト相サマリの集計（結果ビュー・論文用テキスト生成で共用）。
 *
 * features/fulltext/results.ts（結果ビューのUI本体、Issue #155（#150 工程4）で遅延読み込みチャンクへ
 * 移動）と features/manuscript.ts（初期バンドルに残る）の両方が使うため、`state` を直接読まない
 * 純関数としてここへ切り出している。判定者選択（enabledJudges）・除外理由リスト・自分の
 * メールアドレスは呼び出し側が引数で渡す。
 *
 * PRISMA の腕別集計（Issue #120）: Registry linkage 由来の行は database 腕から分離集計する
 * （splitByIdentificationRoute()）。両腕が要るときは getFulltextResultsSummaryByRoute() を使う。
 */

import {
    computeFulltextConsensus,
    isAdjudicationKey,
} from './fulltext-consensus';
import type { FulltextConsensusResult, FulltextVote } from './fulltext-consensus';
import { splitByIdentificationRoute } from './identification-route';
import type { ExcludeReasonItem } from './exclude-reasons';
import type { Decision, FulltextStatus, ReferenceWithStatus } from './types';

/** 入手状態（未記録は not_retrieved 扱い） */
export function fulltextRetrievalStatus(ref: ReferenceWithStatus): FulltextStatus {
    return ref.fulltext_status ?? 'not_retrieved';
}

export function isFulltextObtained(ref: ReferenceWithStatus): boolean {
    const s = fulltextRetrievalStatus(ref);
    return (s === 'cached' || s === 'retrieved') && !!ref.fulltext_url;
}

/**
 * 文献ごとに「判定者キー → 最新のフルテキスト判定」をマップ化する。
 * キー開封後は allFulltextDecisions、未開封時は myFulltextDecision のみ。
 */
export function judgeDecisionMap(ref: ReferenceWithStatus): Map<string, Decision> {
    const list: Decision[] =
        ref.allFulltextDecisions && ref.allFulltextDecisions.length > 0
            ? ref.allFulltextDecisions
            : ref.myFulltextDecision
                ? [ref.myFulltextDecision]
                : [];
    const map = new Map<string, Decision>();
    for (const d of list) {
        const key = (d.reviewer_id || '').trim();
        if (!key) continue;
        const existing = map.get(key);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            map.set(key, d);
        }
    }
    return map;
}

/**
 * 全候補から判定者キーを収集（ヒトを先、AI(llm:)を後ろにソート）。
 * 裁定票（adjudication:）は判定者選択（チェックボックス）の対象から除外する。
 * ここでチェックを外せてしまうと、選択判定者に依存する合議計算から裁定票そのものが
 * 消えてしまい、裁定が無効化されてしまうため。
 *
 * @param fallbackUserEmail 判定者が1人も見つからない場合に代わりに使う自分のメールアドレス
 *   （state.userEmail 相当）。
 */
export function collectFulltextJudges(
    candidates: ReferenceWithStatus[],
    fallbackUserEmail: string
): string[] {
    const set = new Set<string>();
    for (const r of candidates) {
        for (const key of judgeDecisionMap(r).keys()) {
            if (isAdjudicationKey(key)) continue;
            set.add(key);
        }
    }
    if (set.size === 0 && fallbackUserEmail) set.add(fallbackUserEmail);
    return [...set].sort((a, b) => {
        const al = a.startsWith('llm:') ? 1 : 0;
        const bl = b.startsWith('llm:') ? 1 : 0;
        if (al !== bl) return al - bl;
        return a.localeCompare(b);
    });
}

/**
 * 有効な判定者集合（全候補の判定者と enabledJudges の積。空なら全員にフォールバック）。
 * @param enabledJudges 呼び出し側（結果ビューのチェックボックス選択）の現在値。null = 既定で全員。
 */
export function effectiveFulltextJudges(
    allJudges: string[],
    enabledJudges: Set<string> | null
): Set<string> {
    if (!enabledJudges) return new Set(allJudges);
    const eff = new Set(allJudges.filter(j => enabledJudges.has(j)));
    if (eff.size === 0) return new Set(allJudges); // 安全弁（最小1人）
    return eff;
}

/**
 * ある文献について、合議計算（fulltext-consensus.ts）に渡す票配列を組み立てる。
 * - 通常の判定者票: judges（選択中の判定者集合）に含まれるものだけを渡す
 * - 裁定票（adjudication:）: judges の選択に関わらず常に含める
 *   （判定者選択のチェックボックスに出ないため、外して無効化される心配がない）
 */
export function buildFulltextVotesForConsensus(
    ref: ReferenceWithStatus,
    judges: Set<string>
): FulltextVote[] {
    const map = judgeDecisionMap(ref);
    const votes: FulltextVote[] = [];
    for (const [key, d] of map) {
        if (!isAdjudicationKey(key) && !judges.has(key)) continue;
        votes.push({ judge: key, decision: d.decision, reason: d.reason, note: d.note, decidedAt: d.decided_at });
    }
    return votes;
}

/** 選択判定者＋裁定票から合議結果を計算する（表示・エクスポート双方の唯一の入口） */
export function getFulltextConsensus(
    ref: ReferenceWithStatus,
    judges: Set<string>,
    excludeReasonItems: readonly ExcludeReasonItem[]
): FulltextConsensusResult {
    return computeFulltextConsensus(buildFulltextVotesForConsensus(ref, judges), excludeReasonItems);
}

/**
 * フルテキスト相の集計サマリ（結果ビューのPRISMA表示・論文用テキスト生成で共用）
 *
 * conflict と reasonConflict は意図的に別枠で持つ（決してマージしないこと）。
 * `conflict` は論文原稿の "Disagreements between screeners (n = …)" にそのまま使われる数値であり、
 * SR の報告慣行では screener 間の disagreement は組入/除外などの「判定」不一致を指す。
 * ここに理由だけの相違（reasonConflict）を混ぜると、論文で報告する数字の意味が変わってしまう。
 */
export interface FulltextResultsSummary {
    sought: number;        // 候補（Reports sought for retrieval）
    obtained: number;      // 入手済（Reports assessed for eligibility）
    notRetrieved: number;  // 未入手
    include: number;
    exclude: number;
    maybe: number;
    pending: number;
    conflict: number;       // 判定不一致のみ（裁定済みも含む生の件数）
    reasonConflict: number; // 理由不一致のみ（裁定済みも含む生の件数）。conflict とは合算しない
    unresolved: number;     // うち未解消（(conflict||reasonConflict) && !adjudicated）
    reasons: Array<{ reason: string; count: number }>;  // 除外理由（件数降順、生キー）
    judges: string[];      // 集計に使った判定者キー
}

export function summarizeFulltextCandidates(
    candidates: ReferenceWithStatus[],
    judges: Set<string>,
    excludeReasonItems: readonly ExcludeReasonItem[]
): FulltextResultsSummary {
    const obtained = candidates.filter(isFulltextObtained).length;

    let inc = 0, exc = 0, maybe = 0, pend = 0, conflict = 0, reasonConflict = 0, unresolved = 0;
    const reasonCounts = new Map<string, number>();
    for (const r of candidates) {
        const c = getFulltextConsensus(r, judges, excludeReasonItems);
        if (c.conflict) conflict++;
        if (c.reasonConflict) reasonConflict++;
        if (c.unresolved) unresolved++;
        switch (c.decision) {
            case 'include': inc++; break;
            case 'exclude':
                exc++;
                reasonCounts.set(c.primaryReason, (reasonCounts.get(c.primaryReason) ?? 0) + 1);
                break;
            case 'maybe': maybe++; break;
            default: pend++;
        }
    }

    return {
        sought: candidates.length,
        obtained,
        notRetrieved: candidates.length - obtained,
        include: inc,
        exclude: exc,
        maybe,
        pending: pend,
        conflict,
        reasonConflict,
        unresolved,
        reasons: [...reasonCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => ({ reason, count })),
        judges: [...judges],
    };
}

export interface FulltextResultsSummaryOptions {
    /** 結果ビューの判定者チェックボックス選択（未訪問・全員なら null） */
    enabledJudges: Set<string> | null;
    excludeReasonItems: readonly ExcludeReasonItem[];
    /** 判定者が1人も見つからない場合のフォールバック（state.userEmail 相当） */
    userEmail: string;
}

/**
 * フルテキスト相サマリを同定経路（database / registryLinkage）別に分けて返す。
 * PRISMA の「other methods」腕（レジストリ連携由来）の集計に使う（Issue #120）。
 */
export function getFulltextResultsSummaryByRoute(
    candidates: ReferenceWithStatus[],
    options: FulltextResultsSummaryOptions
): { database: FulltextResultsSummary; registryLinkage: FulltextResultsSummary } {
    const allJudges = collectFulltextJudges(candidates, options.userEmail);
    const judges = effectiveFulltextJudges(allJudges, options.enabledJudges);
    const { database, registryLinkage } = splitByIdentificationRoute(candidates);
    return {
        database: summarizeFulltextCandidates(database, judges, options.excludeReasonItems),
        registryLinkage: summarizeFulltextCandidates(registryLinkage, judges, options.excludeReasonItems),
    };
}
