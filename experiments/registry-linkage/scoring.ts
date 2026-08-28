// scoring.ts
// Issue #119「着手条件」の測定で使う純関数（ネットワーク非依存）。
// 実行本体は measure-recall.ts。こちらはユニットテスト（tests/registry-linkage-scoring.test.ts）の対象。
//
// この測定の目的は「#118 の3戦略（ctgov_reference / pubmed_id / europepmc）が、
// 結果論文をどれだけ取りこぼすか」を測ること。取りこぼしが小さければ Issue #119
// （LLMによる検索式生成）は割に合わないので実装しない、という判断のために使う。

import type { PublicationCandidateDraft } from '../../src/lib/publication-suggest';

/**
 * 正解ペアの由来。**測定の妥当性はここで決まる**ため、単なるメモではなく検証対象にしている
 * （validateGroundTruth() が循環する由来を弾く）。
 *
 * 循環とは「正解セットを作った信号を、測定対象の戦略がそのまま使っている」状態のこと。
 * その戦略は自明に当てるので recall が過大評価される。
 *
 * - `pubmed_si`: PubMedの `[si]`（Secondary Source ID）から作ったペア。**戦略2（pubmed_id）と循環**。
 *   AGENTS.md に記録されている既存の36ペアがこれに当たり、だからこそ「#118 が取りこぼす論文」を
 *   一切測れていない（Issue #119 の保留理由そのもの）。
 * - `ctgov_references`: CTGov `referencesModule` から作ったペア。**戦略1（ctgov_reference）と循環**。
 *   Issue #119 の当初案では独立な正解セットの候補として挙げていたが、戦略1が読んでいるのは
 *   まさにこのフィールドなので、`[si]` と同じ誤りの鏡像になる。
 * - `sr_included_table`: 既発表SR/メタ解析の組み入れ研究表に載っている「登録番号 ↔ 文献」の対応。
 *   人手で紐付けられたものなので3戦略のどの信号とも独立。
 * - `registry_declared`: レジストリ側の投稿者申告フィールド（jRCTの主たる公表論文、UMIN-CTRの
 *   結果の公表状況、ISRCTNのpublication citations 等）。CTGov以外のレジストリに限る
 *   （CTGovのそれは `ctgov_references` であり循環するため）。
 * - `manual_curation`: 上記以外で人手により紐付けたもの。source_note に根拠を書くこと。
 * - `crossref_ct_number`: Crossref の `clinical-trial-number`（出版社が論文メタデータとして
 *   寄託する試験登録番号）。3戦略のどれとも別系統:
 *   戦略1が読むのはレジストリ側の CTGov `referencesModule`、戦略2が引くのはNLMが索引する
 *   PubMedの `[si]`/`[tiab]`、戦略3が見るのは Europe PMC の抄録・全文テキストであり、
 *   いずれも出版社のCrossref寄託とは別のパイプライン。Crossrefに番号があってもPubMedの
 *   `[si]` に索引されているとは限らず、抄録本文に書かれているとも限らないため、
 *   「3戦略が取りこぼす論文」を実際に含みうる。
 *   **ただし `registry_declared` と同じ向きの偏りがある**: 出版社が試験番号を寄託するような
 *   論文は、抄録にも登録番号を書いている可能性が高い。したがってこの由来で測った取りこぼし率は
 *   **下限**（実際の取りこぼしはこれ以上）であり、#119 を「実装しない」判断に使う分には
 *   保守的だが、「実装する」判断の根拠にするときは割り引くこと。
 */
export type Provenance =
    | 'sr_included_table'
    | 'registry_declared'
    | 'manual_curation'
    | 'crossref_ct_number'
    | 'pubmed_si'
    | 'ctgov_references';

/** 循環する由来（validateGroundTruth() が弾く）と、その理由 */
const CIRCULAR_PROVENANCE: Partial<Record<Provenance, string>> = {
    pubmed_si: 'PubMedの[si]由来。戦略2（pubmed_id）が同じ信号を使うため自明に当たる',
    ctgov_references: 'CTGov referencesModule由来。戦略1（ctgov_reference）が同じ信号を使うため自明に当たる',
};

/**
 * レジストリ種別。**層別集計のためだけに使う**（製品側の extractTrialId() は nct / other の
 * 2値しか持たないが、測定では取りこぼしの偏りを見たいので細かく分ける）。
 *
 * 層別する理由: 戦略1（CTGov referencesModule）はNCTにしか効かない。非CTGov（jRCT/UMIN等）は
 * 戦略2・3だけで戦うことになり、しかも日本のレジストリIDはPubMedの[si]に索引されにくい。
 * つまり取りこぼしは非NCT側に偏っている可能性が高く、全体を1つの数字にまとめると
 * 「NCTは十分／非NCTは全然ダメ」が平均に埋もれて見えなくなる。
 */
export type RegistryStratum = 'ctgov' | 'jrct' | 'umin' | 'isrctn' | 'other';

export interface GroundTruthPair {
    /** 試験ID（NCT........ / jRCT........... / UMIN の C000...... 等）。References の pmid 列に入るのと同じ値 */
    trial_id: string;
    /** 正解論文のPMID。pmid / doi は少なくとも一方が必要 */
    pmid?: string;
    /** 正解論文のDOI */
    doi?: string;
    provenance: Provenance;
    /** 出典（SRのPMID/DOI、レジストリ画面のURL等）。再現性のため必須運用にする */
    source_note?: string;
}

export function classifyRegistry(trialId: string): RegistryStratum {
    const id = trialId.trim().toUpperCase();
    if (/^NCT\d{8}$/.test(id)) return 'ctgov';
    if (id.startsWith('JRCT')) return 'jrct';
    // UMIN-CTR の受付番号は UMIN000000000 形式と C000000000 形式の両方が流通している
    if (id.startsWith('UMIN') || /^C\d{6,9}$/.test(id)) return 'umin';
    if (id.startsWith('ISRCTN')) return 'isrctn';
    return 'other';
}

export function normalizePmid(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

/** DOI は大文字小文字を区別しない（DOIハンドブック）。`https://doi.org/` 接頭辞も剥がす */
export function normalizeDoi(value: string | undefined): string | undefined {
    let trimmed = value?.trim().toLowerCase();
    if (!trimmed) return undefined;
    trimmed = trimmed.replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
    return trimmed ? trimmed : undefined;
}

export interface ValidationResult {
    usable: GroundTruthPair[];
    rejected: Array<{ pair: GroundTruthPair; reason: string }>;
}

/**
 * 正解セットを検証し、測定に使えないペアを落とす。
 *
 * **この関数が本測定の肝**。「独立な正解セットを使う」という前提を運用の心がけではなく
 * コードの検証に落としてあるので、あとから循環したペアが紛れ込んでも黙って通ることはない。
 */
export function validateGroundTruth(pairs: GroundTruthPair[]): ValidationResult {
    const usable: GroundTruthPair[] = [];
    const rejected: Array<{ pair: GroundTruthPair; reason: string }> = [];
    const seenTrialIds = new Set<string>();

    for (const pair of pairs) {
        const trialId = pair.trial_id?.trim();
        if (!trialId) {
            rejected.push({ pair, reason: 'trial_id が空' });
            continue;
        }
        const circular = CIRCULAR_PROVENANCE[pair.provenance];
        if (circular) {
            rejected.push({ pair, reason: `循環する由来（${pair.provenance}）: ${circular}` });
            continue;
        }
        if (!normalizePmid(pair.pmid) && !normalizeDoi(pair.doi)) {
            rejected.push({ pair, reason: 'pmid / doi のどちらも無く、当たったか判定できない' });
            continue;
        }
        const key = trialId.toUpperCase();
        if (seenTrialIds.has(key)) {
            rejected.push({ pair, reason: `試験ID ${trialId} が重複している（1試験1行にする）` });
            continue;
        }
        seenTrialIds.add(key);
        usable.push(pair);
    }

    return { usable, rejected };
}

/** 候補1件が正解ペアと一致するか（PMID か DOI のどちらかが一致すれば一致とみなす） */
export function candidateMatchesTruth(
    candidate: Pick<PublicationCandidateDraft, 'pmid' | 'doi'>,
    pair: GroundTruthPair
): boolean {
    const truthPmid = normalizePmid(pair.pmid);
    const truthDoi = normalizeDoi(pair.doi);
    const candPmid = normalizePmid(candidate.pmid);
    const candDoi = normalizeDoi(candidate.doi);
    if (truthPmid && candPmid && truthPmid === candPmid) return true;
    if (truthDoi && candDoi && truthDoi === candDoi) return true;
    return false;
}

export interface PairResult {
    trial_id: string;
    stratum: RegistryStratum;
    provenance: Provenance;
    /** 正解が候補一覧に現れたか（＝#118 が発見できたか） */
    found: boolean;
    /** 当てた戦略。dedupe が強い戦略を残すので、実質「最も強い当てた戦略」になる */
    found_by: PublicationCandidateDraft['strategy'] | null;
    /** 候補一覧の中での順位（1始まり）。見つからなければ null */
    rank: number | null;
    /** 返ってきた候補の件数（ノイズ量の目安） */
    candidate_count: number;
    /** 戦略別の候補件数（どの戦略がノイズを持ち込んでいるかを見る） */
    count_by_strategy: Record<string, number>;
}

export function evaluatePair(
    pair: GroundTruthPair,
    candidates: PublicationCandidateDraft[]
): PairResult {
    const countByStrategy: Record<string, number> = {};
    for (const candidate of candidates) {
        countByStrategy[candidate.strategy] = (countByStrategy[candidate.strategy] ?? 0) + 1;
    }

    const index = candidates.findIndex(candidate => candidateMatchesTruth(candidate, pair));

    return {
        trial_id: pair.trial_id,
        stratum: classifyRegistry(pair.trial_id),
        provenance: pair.provenance,
        found: index >= 0,
        found_by: index >= 0 ? candidates[index].strategy : null,
        rank: index >= 0 ? index + 1 : null,
        candidate_count: candidates.length,
        count_by_strategy: countByStrategy,
    };
}

export interface StratumSummary {
    n: number;
    found: number;
    missed: number;
    /** 取りこぼし率（0〜1）。Issue #119 の着手判断はこの値で行う */
    miss_rate: number;
    mean_candidate_count: number;
    /** 当てた戦略の内訳。ここが ctgov_reference / pubmed_id に偏っていれば戦略3は効いていない */
    found_by: Record<string, number>;
}

export interface Summary {
    overall: StratumSummary;
    by_stratum: Partial<Record<RegistryStratum, StratumSummary>>;
}

function summarizeGroup(results: PairResult[]): StratumSummary {
    const n = results.length;
    const found = results.filter(r => r.found).length;
    const foundBy: Record<string, number> = {};
    for (const r of results) {
        if (r.found_by) foundBy[r.found_by] = (foundBy[r.found_by] ?? 0) + 1;
    }
    const totalCandidates = results.reduce((sum, r) => sum + r.candidate_count, 0);
    return {
        n,
        found,
        missed: n - found,
        // n===0 のとき 0/0 が NaN になり、JSON へ null として書き出されて集計が壊れるため 0 で返す
        miss_rate: n === 0 ? 0 : (n - found) / n,
        mean_candidate_count: n === 0 ? 0 : totalCandidates / n,
        found_by: foundBy,
    };
}

export function summarize(results: PairResult[]): Summary {
    const byStratum: Partial<Record<RegistryStratum, StratumSummary>> = {};
    for (const stratum of new Set(results.map(r => r.stratum))) {
        byStratum[stratum] = summarizeGroup(results.filter(r => r.stratum === stratum));
    }
    return { overall: summarizeGroup(results), by_stratum: byStratum };
}

/** Issue #119 の着手判断（本文「着手条件」の閾値をそのままコードにしたもの） */
export type Verdict = 'not_worth_it' | 'low_priority' | 'build_it';

export function decide(missRate: number): Verdict {
    if (missRate < 0.10) return 'not_worth_it';
    if (missRate <= 0.25) return 'low_priority';
    return 'build_it';
}

/**
 * 「特定の戦略が、ある時点から最後まで一度も候補を返していない」状態を検出する。
 *
 * 到達性チェックは測定の前後しか見ないので、途中だけ落ちて復帰したケースを拾えない。
 * 各戦略が候補を最後に返したのが何件目かを見て、末尾に長い空白が続いていれば
 * 「その戦略が途中で死んだ可能性」として警告する（正常でも0件は普通に起きるので、
 * **中止はせず判断材料として出すだけ**）。
 */
export function detectStrategyOutage(
    results: PairResult[],
    minRun = 10
): Array<{ strategy: string; lastHitIndex: number; trailing: number }> {
    const strategies = new Set<string>();
    for (const r of results) for (const k of Object.keys(r.count_by_strategy)) strategies.add(k);

    const outages: Array<{ strategy: string; lastHitIndex: number; trailing: number }> = [];
    for (const strategy of strategies) {
        let lastHitIndex = -1;
        for (const [i, r] of results.entries()) {
            if ((r.count_by_strategy[strategy] ?? 0) > 0) lastHitIndex = i;
        }
        const trailing = results.length - 1 - lastHitIndex;
        if (trailing >= minRun) outages.push({ strategy, lastHitIndex, trailing });
    }
    return outages;
}
