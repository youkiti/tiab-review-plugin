// publication-candidate-panel.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3b: 候補パネル（サイドパネルUI、
// src/sidepanel/features/fulltext-publication-candidates.ts）が使う UI非依存の純ロジック。
// DOM・state に依存しないため、ここだけユニットテストできる
// （fulltext-consensus.ts / fulltext-other-decisions.ts と同じ方針）。
//
// 候補データそのものの読み込み（getPublicationCandidates() の呼び出しとキャッシュ保持）は
// src/sidepanel/features/fulltext-tab.ts 側の責務（このタブ限定の関心事のため state には
// 足さない）。ここには「読み込んだ配列をどう並べる・絞り込む・数える・重複判定するか」の
// 純粋な計算だけを置く。

import type { PublicationCandidate, PublicationCandidateStrategy } from './types';
import { filterAlreadyImportedCandidates } from './publication-suggest';
import type { PublicationCandidateDraft } from './publication-suggest';

/**
 * 発見戦略の強さ順（discoverPublicationCandidates() と同じ並び:
 * ctgov_reference → pubmed_id → europepmc）。数値が小さいほど強い。
 */
const STRATEGY_ORDER: Record<PublicationCandidateStrategy, number> = {
    ctgov_reference: 0,
    pubmed_id: 1,
    europepmc: 2,
};

/**
 * ある registration 行（refId）に紐づく「未決着（status==='suggested'）」の候補だけを、
 * 発見戦略の強い順に並べて返す。候補パネルの一覧表示に使う。
 * status が 'imported'/'dismissed' になった候補はここで除外されるため、取り込み・対象外化の
 * 直後にこの関数へ渡す配列を更新するだけでパネルから自動的に消える。
 */
export function selectSuggestedPublicationCandidates(
    candidates: PublicationCandidate[],
    refId: string
): PublicationCandidate[] {
    return candidates
        .filter(c => c.ref_id === refId && c.status === 'suggested')
        .sort((a, b) => STRATEGY_ORDER[a.strategy] - STRATEGY_ORDER[b.strategy]);
}

/**
 * 「論文候補 n件」バッジ用に、registration行(ref_id)ごとの未決着候補数をまとめて数える。
 * カード1枚ごとに配列を毎回フィルタするのではなく、一覧描画1回につき1パスで済ませるための
 * 集計版（selectSuggestedPublicationCandidates と同じ絞り込み条件）。
 */
export function countSuggestedPublicationCandidatesByRef(
    candidates: PublicationCandidate[]
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const c of candidates) {
        if (c.status !== 'suggested') continue;
        counts.set(c.ref_id, (counts.get(c.ref_id) ?? 0) + 1);
    }
    return counts;
}

/**
 * ある候補が既に References に取り込み済み（同一PMIDまたは同一DOIの行が既存）かどうかを判定する。
 *
 * 「取り込む」ボタンを押した瞬間（探索時点より後、References が変わりうる）にもう一度見る
 * 重複チェックに使う。publication-suggest.ts の filterAlreadyImportedCandidates()（探索直後の
 * 重複除外と全く同じ規則: PMIDはそのまま、DOIはtrim・小文字化して突合）をそのまま流用し、
 * 判定ロジックを独自実装しない。
 *
 * filterAlreadyImportedCandidates() は探索直後・保存前の型 PublicationCandidateDraft[]
 * （camelCase の refId/trialId/strategy を持つ）を受け取る一方、ここで扱うのは
 * Publication_Candidates シートに保存済みの PublicationCandidate（snake_case）。
 * フィルタの実体は pmid/doi の2項目しか判定に使わないため、それ以外（refId/trialId/strategy）は
 * 使われないダミー値で埋めたシムを1件だけ渡せば、判定結果は完全に一致する
 * （filterAlreadyImportedCandidates() 自体は変更していない）。
 */
export function isPublicationCandidateAlreadyImported(
    candidate: Pick<PublicationCandidate, 'pmid' | 'doi'>,
    existingRefs: Array<{ pmid?: string; doi?: string }>
): boolean {
    const shim: PublicationCandidateDraft = {
        refId: '',
        trialId: '',
        strategy: 'pubmed_id',
        pmid: candidate.pmid,
        doi: candidate.doi,
    };
    return filterAlreadyImportedCandidates([shim], existingRefs).length === 0;
}

/**
 * 発見戦略の人間可読ラベルに使う i18n キー名を返す（実際の翻訳・表示はUI側で t() を通して行う。
 * ここでは「どの戦略にどのキーを割り当てるか」という表だけを純関数として切り出し、
 * 対応漏れ・キー名の書き間違いをユニットテストで検出できるようにする）。
 */
export function publicationCandidateStrategyLabelKey(strategy: PublicationCandidateStrategy): string {
    switch (strategy) {
        case 'ctgov_reference': return 'pubCandidate_strategyCtgovReference';
        case 'pubmed_id': return 'pubCandidate_strategyPubmedId';
        case 'europepmc': return 'pubCandidate_strategyEuropepmc';
    }
}
