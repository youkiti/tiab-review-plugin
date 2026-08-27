// publication-suggest.ts
// Issue #118「レジストリ連携フェーズ1」チャンク2 パスB: 試験登録レコード（registration行）から
// 「その試験の結果論文（linked publication）」の候補を発見する。UI 非依存。
// 発見した候補の永続化（Publication_Candidates タブへの保存）は src/lib/sheets-api.ts の
// savePublicationCandidates() が担う。候補の表示・取り込み・References への行追加は
// このパスの対象外（チャンク3）。**References に行を追加する経路をこのファイルに作らないこと。**

import type { PublicationCandidate, PublicationCandidateStrategy } from './types';

/**
 * discoverPublicationCandidates() が発見した、まだ Publication_Candidates タブへ
 * 保存する前の候補。保存後の PublicationCandidate（candidate_id/status/suggested_at 等が
 * 確定した行）とは別の型にしている（sheets-api.ts の savePublicationCandidates() が
 * それらのフィールドを確定させる）。
 */
export interface PublicationCandidateDraft {
    refId: string;
    trialId: string;
    pmid?: string;
    doi?: string;
    title?: string;
    journal?: string;
    year?: number;
    strategy: PublicationCandidateStrategy;
}

/**
 * trialscout の naive 戦略相当の PubMed 検索クエリを組み立てる。
 * `[si]`（Secondary Source ID）と `[tiab]`（Title/Abstract）の両方を見ることで、
 * PubMed の Secondary Source ID フィールドに登録されているレコードと、
 * 本文中に試験IDが素で書かれているレコードの両方を拾う。
 */
export function buildPubmedIdQuery(trialId: string): string {
    const id = trialId.trim();
    return `"${id}"[si] OR "${id}"[tiab]`;
}

/**
 * 候補配列を PMID・DOI の両方で重複排除する。
 *
 * - 候補ごとに PMID キー（trim）と DOI キー（trim・小文字化）の**両方**を作る。
 *   どちらか一方でも既出なら、その候補は捨てる（PMIDだけで見つかった候補と、別戦略で
 *   DOIだけ返ってきた同一論文が2行に分かれて残らないようにするため。esummary が
 *   PMIDのみだった候補へ後からDOIを補完することがあるので、片方のキーだけで見るのでは
 *   このケースを捕まえられない）。
 * - PMID も DOI も無い候補は捨てる（Publication_Candidates に保存する意味が無いため）。
 * - 残す候補が確定したら、PMID・DOI 両方のキーを登録する（片方しか無い候補も、
 *   持っている方だけ登録する）。
 * - 同一キーが複数戦略で見つかった場合、**先に配列へ現れた側を残す**。呼び出し側
 *   （discoverPublicationCandidates）は戦略の強い順（ctgov_reference → pubmed_id →
 *   europepmc）に積んでから渡す前提なので、strategy の値は結果として「先勝ち＝より強い戦略」
 *   になる。ここでは「先に現れた側を残す」以上のことはしない（フィールドのマージはしない）。
 */
export function dedupePublicationCandidates(
    candidates: PublicationCandidateDraft[]
): PublicationCandidateDraft[] {
    const seenPmids = new Set<string>();
    const seenDois = new Set<string>();
    const result: PublicationCandidateDraft[] = [];

    for (const candidate of candidates) {
        const pmid = candidate.pmid?.trim();
        const doi = candidate.doi?.trim().toLowerCase();
        if (!pmid && !doi) continue;

        if ((pmid && seenPmids.has(pmid)) || (doi && seenDois.has(doi))) continue;

        if (pmid) seenPmids.add(pmid);
        if (doi) seenDois.add(doi);
        result.push(candidate);
    }

    return result;
}

/**
 * 既存 References 行（の pmid/doi）と一致する候補を除外する。
 * 「もう References に取り込まれている論文」を候補として出さないためのフィルタ。
 * PMID はそのまま、DOI は trim・小文字化して突合する。
 */
export function filterAlreadyImportedCandidates(
    candidates: PublicationCandidateDraft[],
    existingRefs: Array<{ pmid?: string; doi?: string }>
): PublicationCandidateDraft[] {
    const existingPmids = new Set<string>();
    const existingDois = new Set<string>();
    for (const ref of existingRefs) {
        const pmid = ref.pmid?.trim();
        if (pmid) existingPmids.add(pmid);
        const doi = ref.doi?.trim().toLowerCase();
        if (doi) existingDois.add(doi);
    }

    return candidates.filter(candidate => {
        const pmid = candidate.pmid?.trim();
        if (pmid && existingPmids.has(pmid)) return false;
        const doi = candidate.doi?.trim().toLowerCase();
        if (doi && existingDois.has(doi)) return false;
        return true;
    });
}

/**
 * Publication_Candidates タブへ既に記録済みの候補（同一 ref_id かつ 同一 PMID または DOI）を
 * 除外する。一括検索を2回流しても Publication_Candidates に重複行が積まれないようにするための
 * フィルタ（src/lib/sheets-api.ts の savePublicationCandidates() が保存直前に使う）。
 */
export function filterNewCandidates(
    existing: PublicationCandidate[],
    incoming: PublicationCandidateDraft[]
): PublicationCandidateDraft[] {
    const existingKeys = new Set<string>();
    for (const e of existing) {
        const pmid = e.pmid?.trim();
        if (pmid) existingKeys.add(`${e.ref_id}::pmid:${pmid}`);
        const doi = e.doi?.trim().toLowerCase();
        if (doi) existingKeys.add(`${e.ref_id}::doi:${doi}`);
    }

    return incoming.filter(candidate => {
        const pmid = candidate.pmid?.trim();
        if (pmid && existingKeys.has(`${candidate.refId}::pmid:${pmid}`)) return false;
        const doi = candidate.doi?.trim().toLowerCase();
        if (doi && existingKeys.has(`${candidate.refId}::doi:${doi}`)) return false;
        return true;
    });
}

// ---------------------------------------------------------------------------
// discoverPublicationCandidates: fetch を伴う探索本体
// ---------------------------------------------------------------------------

/** ClinicalTrials.gov API v2 の referencesModule 由来PMID等、呼び出し側が既に持っている情報 */
export interface DiscoverPublicationCandidatesInput {
    refId: string;
    trialId: string;
    /**
     * extractTrialId() の kind。現在の3戦略はいずれも試験ID文字列ベースの検索で
     * NCT以外にも動くため、この値で戦略を出し分けてはいない（将来レジストリ種別ごとに
     * 戦略を調整する余地を残すため、入力の型にだけ持たせている）。
     */
    kind: 'nct' | 'other';
    /** CTGov referencesModule 由来のPMID（fetchCtgStudy() の pmids）。fetch不要でそのまま使う */
    ctgPmids: string[];
    existingRefs: Array<{ pmid?: string; doi?: string }>;
    /**
     * eutils（esearch/esummary）へ申告する連絡先メールアドレス。NCBIはE-utilities呼び出し元に
     * tool/emailの申告を求めており、本リポジトリの既存コード（fulltext-retriever.ts の
     * enrichNcbiIds()）も同じ流儀で付けている。未指定でも呼び出しは通る（emailパラメータ自体を省略する）。
     */
    email?: string;
}

export interface DiscoverPublicationCandidatesOptions {
    /**
     * eutils（esearch → esummary）への連続呼び出しの間に入れる待機（ms）。
     * PubMed E-utilities はAPIキー無しで 3 req/s が上限のため既定 350ms 空ける。
     * テストを遅くしないよう 0 を注入できるようにしている。
     */
    delayMs?: number;
}

const DEFAULT_EUTILS_DELAY_MS = 350;

// fulltext-retriever.ts の enrichNcbiIds() と同じ申告名。NCBI E-utilities は呼び出し元の
// tool/email申告を求めているため、esearch/esummaryのどちらにも付ける。
const EUTILS_TOOL_NAME = 'tiab-review-plugin';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 出版年の文字列を安全に数値化する。非数値（例: "n/a"）や範囲外の値では
 * NaN を返さず undefined にする（NaN のまま `.toString()` すると
 * savePublicationCandidates() がシートへ文字列 "NaN" を書いてしまうため）。
 */
function parseYearOrUndefined(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const year = parseInt(value, 10);
    return Number.isFinite(year) ? year : undefined;
}

// --- ここから fetch する外部APIレスポンスの型（使用する部分のみ。any は使わない） ---

interface EsearchResponse {
    esearchresult?: { idlist?: string[] };
}

interface EsummaryArticleId {
    idtype?: string;
    value?: string;
}

interface EsummaryDocSummary {
    title?: string;
    fulljournalname?: string;
    pubdate?: string;
    articleids?: EsummaryArticleId[];
}

interface EsummaryResult {
    uids?: string[];
    [pmid: string]: EsummaryDocSummary | string[] | undefined;
}

interface EsummaryResponse {
    result?: EsummaryResult;
}

function isEsummaryDocSummary(
    value: EsummaryDocSummary | string[] | undefined
): value is EsummaryDocSummary {
    return !!value && !Array.isArray(value);
}

interface EuropePmcResult {
    pmid?: string;
    doi?: string;
    title?: string;
    journalTitle?: string;
    pubYear?: string;
}

interface EuropePmcSearchResponse {
    resultList?: { result?: EuropePmcResult[] };
}

/** 戦略2（pubmed_id）: esearch で試験IDに一致するPMID一覧を取る。失敗時は空配列（例外を投げない） */
async function esearchPubmedIds(trialId: string, email?: string): Promise<string[]> {
    try {
        const params = new URLSearchParams({
            db: 'pubmed', retmode: 'json', term: buildPubmedIdQuery(trialId),
        });
        params.set('tool', EUTILS_TOOL_NAME);
        if (email) params.set('email', email);
        const resp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`);
        if (!resp.ok) return [];
        const data = await resp.json() as EsearchResponse;
        return data.esearchresult?.idlist ?? [];
    } catch {
        return [];
    }
}

/** PMID群の書誌（title/journal/year/doi）を esummary でまとめて取得する（1リクエスト）。失敗時は空Map */
async function esummaryForPmids(pmids: string[], email?: string): Promise<Map<string, {
    title?: string; journal?: string; year?: number; doi?: string;
}>> {
    const result = new Map<string, { title?: string; journal?: string; year?: number; doi?: string }>();
    if (pmids.length === 0) return result;

    try {
        const params = new URLSearchParams({ db: 'pubmed', retmode: 'json', id: pmids.join(',') });
        params.set('tool', EUTILS_TOOL_NAME);
        if (email) params.set('email', email);
        const resp = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`);
        if (!resp.ok) return result;
        const data = await resp.json() as EsummaryResponse;
        const uids = data.result?.uids ?? [];
        for (const uid of uids) {
            const doc = data.result?.[uid];
            if (!isEsummaryDocSummary(doc)) continue;
            const yearMatch = doc.pubdate?.match(/\d{4}/);
            const doi = doc.articleids?.find(a => a.idtype === 'doi')?.value;
            result.set(uid, {
                title: doc.title,
                journal: doc.fulljournalname,
                year: parseYearOrUndefined(yearMatch?.[0]),
                doi,
            });
        }
    } catch {
        // 失敗しても他戦略の結果は返す（呼び出し側で空Mapとして扱われる）
    }
    return result;
}

/**
 * 戦略3（europepmc）: 試験ID全文一致で検索。jRCT/UMIN等、PubMedの[si]に無いIDにも有効。失敗時は空配列。
 *
 * - クエリは `"${trialId}"` と引用符で囲み、無引用によるトークナイズで無関係な文献を
 *   拾わないようにする。
 * - resultType は `lite`（pmid/doi/title/journalTitle/pubYear で足りるため）。`core` は
 *   全文リンク・抄録まで含む重いレスポンスで、既存OAウォーターフォール側が `core` なのは
 *   `fullTextUrlList` を使うためであり事情が異なる（ここでは不要）。
 * - pageSize は既定値に依存せず 25 件を明示する。
 */
async function europePmcCandidates(
    refId: string, trialId: string
): Promise<PublicationCandidateDraft[]> {
    try {
        const params = new URLSearchParams({
            query: `"${trialId}"`, format: 'json', resultType: 'lite', pageSize: '25',
        });
        const resp = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`);
        if (!resp.ok) return [];
        const data = await resp.json() as EuropePmcSearchResponse;
        const results = data.resultList?.result ?? [];
        return results.map(r => ({
            refId,
            trialId,
            pmid: r.pmid?.trim() || undefined,
            doi: r.doi?.trim() || undefined,
            title: r.title,
            journal: r.journalTitle,
            year: parseYearOrUndefined(r.pubYear),
            strategy: 'europepmc' as const,
        }));
    } catch {
        return [];
    }
}

/**
 * registration行から結果論文の候補を発見する（3戦略を直列実行）。
 *
 * 1. ctgov_reference: ctgPmids（呼び出し側が fetchCtgStudy() の結果から渡す。fetch不要）
 * 2. pubmed_id: esearch で試験IDから検索
 * 3. europepmc: Europe PMC 全文検索で試験IDから検索（jRCT/UMIN等にも有効）
 *
 * 1・2で集めたPMIDの書誌は esummary に1リクエストでまとめて問い合わせる
 * （PMIDごとに1回呼ばない）。eutils（esearch → esummary）の間だけ options.delayMs
 * （既定350ms）待機する（PubMed E-utilitiesのAPIキー無し上限 3 req/s 対策）。
 * Europe PMC は別ホストのAPIのため、この待機の対象に含めていない。
 *
 * 各戦略の失敗（ネットワークエラー・非200・JSON不正）は例外を投げず、その戦略だけスキップして
 * 他戦略の結果を返す（呼び出し側の一括ループを止めないため）。全滅時は空配列。
 *
 * 最後に dedupePublicationCandidates（戦略の強い順: ctgov_reference → pubmed_id → europepmc）
 * → filterAlreadyImportedCandidates を通してから返す。
 */
export async function discoverPublicationCandidates(
    input: DiscoverPublicationCandidatesInput,
    options: DiscoverPublicationCandidatesOptions = {}
): Promise<PublicationCandidateDraft[]> {
    const delayMs = options.delayMs ?? DEFAULT_EUTILS_DELAY_MS;
    const { refId, trialId, ctgPmids, existingRefs, email } = input;

    const collected: PublicationCandidateDraft[] = [];

    // 1. ctgov_reference（fetch不要）
    const ctgPmidSet = new Set<string>();
    for (const pmid of ctgPmids) {
        const trimmed = pmid.trim();
        if (!trimmed || ctgPmidSet.has(trimmed)) continue;
        ctgPmidSet.add(trimmed);
        collected.push({ refId, trialId, pmid: trimmed, strategy: 'ctgov_reference' });
    }

    // 2. pubmed_id
    const pubmedIds = await esearchPubmedIds(trialId, email);
    const pubmedIdSet = new Set<string>();
    for (const pmid of pubmedIds) {
        const trimmed = pmid.trim();
        if (!trimmed || ctgPmidSet.has(trimmed) || pubmedIdSet.has(trimmed)) continue;
        pubmedIdSet.add(trimmed);
        collected.push({ refId, trialId, pmid: trimmed, strategy: 'pubmed_id' });
    }

    // ctgov_reference / pubmed_id 両方のPMIDの書誌を esummary でまとめて取得
    const summaryTargetPmids = [...ctgPmidSet, ...pubmedIdSet];
    if (summaryTargetPmids.length > 0) {
        await sleep(delayMs);
        const summaries = await esummaryForPmids(summaryTargetPmids, email);
        for (const candidate of collected) {
            const summary = candidate.pmid ? summaries.get(candidate.pmid) : undefined;
            if (!summary) continue;
            candidate.title = summary.title;
            candidate.journal = summary.journal;
            candidate.year = summary.year;
            candidate.doi = summary.doi;
        }
    }

    // 3. europepmc
    collected.push(...await europePmcCandidates(refId, trialId));

    return filterAlreadyImportedCandidates(dedupePublicationCandidates(collected), existingRefs);
}
