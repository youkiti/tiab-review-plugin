// publication-suggest.ts
// Issue #118「レジストリ連携フェーズ1」チャンク2 パスB: 試験登録レコード（registration行）から
// 「その試験の結果論文（linked publication）」の候補を発見する。UI 非依存。
// 発見した候補の永続化（Publication_Candidates タブへの保存）は src/lib/sheets/publication-candidates.ts の
// savePublicationCandidates() が担う。候補の表示・取り込み・References への行追加は
// このパスの対象外（チャンク3）。**References に行を追加する経路をこのファイルに作らないこと。**

import type { PublicationCandidate, PublicationCandidateStrategy } from './types';

/**
 * discoverPublicationCandidates() が発見した、まだ Publication_Candidates タブへ
 * 保存する前の候補。保存後の PublicationCandidate（candidate_id/status/suggested_at 等が
 * 確定した行）とは別の型にしている（sheets/publication-candidates.ts の savePublicationCandidates() が
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

/** buildEuropePmcQuery() のオプション。既定（省略）は抄録限定、fullText: true で全文検索になる。 */
export interface BuildEuropePmcQueryOptions {
    fullText?: boolean;
}

/**
 * Europe PMC 検索クエリを組み立てる。既定は抄録限定 `ABSTRACT:"<試験ID>"`、
 * `options.fullText` を渡すと全文検索 `"<試験ID>"`（0件時のフォールバック用）になる。
 *
 * 抄録限定にする理由: ClinicalTrials.gov/UMIN-CTR/ISRCTNの3レジストリ×各12試験=36ペア
 * （PubMedの`[si]`から作った正解ペア、発行年2015-2022に限定）で実測したところ、
 * 全文検索（従来のEurope PMCクエリ）は recall 86%（31/36）・平均ヒット数9.0件、
 * 抄録限定は recall 86%（同値）・平均ヒット数4.0件で、recallを落とさずノイズだけ
 * 約半分にできる。全文検索は「本文中で試験IDに言及しただけ」の総説・論説・別試験まで
 * 拾ってしまう（実例: EOLIA試験(NCT01470703)でEurope PMC由来23件がヒットしたが
 * 1件も結果論文ではなかった）。
 *
 * recallが同値で済む理由（絞ってもrecallが落ちない理由）: NCT03719521（正解PMID
 * 38162283）は、全文検索だと38件ヒットし`pageSize=25`の1ページ目からあふれて真の
 * 論文を取りこぼす。抄録限定だと17件まで絞られ、同じ論文が1ページ目に収まり拾える。
 * つまり全文検索がノイズの多さで自滅する分を、抄録限定がクエリを絞ることで拾い返して
 * いる（0件時フォールバックの根拠・NCT04112121の例は europePmcCandidates() のJSDoc参照）。
 *
 * なお `TITLE:"<id>"` を OR しても結果が変わったペアは0/36件だった（試験IDは論文
 * タイトルには出現しない）ため、TITLEは追加しない。
 */
export function buildEuropePmcQuery(trialId: string, options: BuildEuropePmcQueryOptions = {}): string {
    const id = trialId.trim();
    return options.fullText ? `"${id}"` : `ABSTRACT:"${id}"`;
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
 * フィルタ（src/lib/sheets/publication-candidates.ts の savePublicationCandidates() が保存直前に使う）。
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
    /**
     * 副登録番号（他の登録機関でのID番号）。src/lib/registry-record.ts の
     * extractSecondaryTrialIds() で取り出したものを呼び出し側が渡す。ctgPmids と同じで、
     * この関数はパースをしない（Issue #134）。
     */
    secondaryTrialIds?: string[];
}

export interface DiscoverPublicationCandidatesOptions {
    /**
     * eutils（esearch → esummary）への連続呼び出しの間に入れる待機（ms）。
     * PubMed E-utilities はAPIキー無しで 3 req/s が上限のため既定 350ms 空ける。
     * テストを遅くしないよう 0 を注入できるようにしている。
     */
    delayMs?: number;
    /**
     * 副登録番号がNCT（`/^NCT\d{8}$/`）だったときに戦略1（ctgov_reference）を使えるようにする
     * ための遅延取得（Issue #134）。主IDでの探索が0件だったときのゲートが発火し、かつ対象の
     * 副登録番号がNCT形式のときだけ呼ばれる（発火しなければ1回も呼ばない）。未指定なら
     * 副登録番号に対する戦略1はスキップする（戦略2・3はこのオプションが無くても動く）。
     */
    fetchCtgPmids?: (nctId: string) => Promise<string[]>;
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
 * Europe PMC 検索を1回実行し、resultList.result 配列を返す。
 * 失敗時（非200・JSON不正・ネットワーク例外）は例外を投げず null を返す。
 * 呼び出し側の europePmcCandidates() は null（失敗）と []（成功して0件）を区別しており、
 * フォールバックは成功して0件のときだけ発火させる（失敗をそのまま「0件」扱いにしない。
 * 他戦略は続行する）。
 */
async function fetchEuropePmcResults(query: string): Promise<EuropePmcResult[] | null> {
    try {
        const params = new URLSearchParams({
            query, format: 'json', resultType: 'lite', pageSize: '25',
        });
        const resp = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`);
        if (!resp.ok) return null;
        const data = await resp.json() as EuropePmcSearchResponse;
        return data.resultList?.result ?? [];
    } catch {
        return null;
    }
}

/**
 * 戦略3（europepmc）: Europe PMC で試験IDから検索する。jRCT/UMIN等、PubMedの[si]に無いIDにも
 * 有効。1回目が失敗（非200・JSON不正・ネットワーク例外）した場合はフォールバックを発火させず
 * この戦略をスキップし空配列を返す（失敗を「0件だった」と同一視して広い全文検索クエリへ
 * フォールバックすると、落ちているサービスへの負荷が倍になるうえ、一過性の失敗から拾った
 * ノイズ候補が Publication_Candidates シートへ永続化されてしまうため）。
 *
 * - 1回目は buildEuropePmcQuery(trialId) の既定（抄録限定 `ABSTRACT:"<試験ID>"`）で検索する。
 * - 1回目が**成功して**0件だったとき（`fetchEuropePmcResults()` が `[]` を返したとき）だけ、
 *   buildEuropePmcQuery(trialId, { fullText: true }) の全文検索 `"<試験ID>"` で2回目を検索する。
 *   1件以上ヒットすれば2回目のリクエストは発生させない。`hitCount` フィールドは現状読んでいない
 *   ため判定には使わない（依存を増やさない）。
 * - 2回目（フォールバック）が失敗した場合は、これまでどおり空配列を返す（この戦略はスキップ）。
 * - フォールバックする理由: 抄録限定・全文検索はいずれも単独では recall 86%（31/36）で同値
 *   （buildEuropePmcQuery()のJSDoc参照）だが、取りこぼす対象が異なる。NCT04112121（正解PMID
 *   40496603）はPubMed抄録に試験の登録番号が書かれていないため抄録限定では0件になり取りこぼす
 *   が、全文検索なら1件ヒットして拾える。逆にNCT03719521は抄録限定が拾い全文検索の方が
 *   取りこぼす（pageSize=25の打ち切りのため。buildEuropePmcQuery()のJSDoc参照）。つまり2つの
 *   検索方式は互いに違うケースを取りこぼしており、0件時だけ全文検索へフォールバックすることで
 *   両方の取り分を得られ recall が 89%（32/36）まで上がる。フォールバックが走るのはヒット0件の
 *   ケースに限られるため平均ヒット数は 4.0 件のまま（抄録限定のみの案と同水準）に抑えられる。
 * - resultType は `lite`（pmid/doi/title/journalTitle/pubYear で足りるため）。`core` は
 *   全文リンク・抄録まで含む重いレスポンスで、既存OAウォーターフォール側が `core` なのは
 *   `fullTextUrlList` を使うためであり事情が異なる（ここでは不要）。
 * - pageSize は既定値に依存せず 25 件を明示する（両クエリとも共通）。
 * - strategy は両経路とも `'europepmc'` のまま据え置く（新しい戦略値は追加しない。
 *   PublicationCandidateStrategy型・Publication_Candidatesシートのstrategy列・STRATEGY_ORDER・
 *   i18nラベルへの波及はスコープ外）。
 * - eutils用の options.delayMs 待機はここに持ち込まない（別ホストのAPIのため。discoverPublicationCandidates()
 *   のJSDoc参照）。
 */
async function europePmcCandidates(
    refId: string, trialId: string
): Promise<PublicationCandidateDraft[]> {
    const firstAttempt = await fetchEuropePmcResults(buildEuropePmcQuery(trialId));
    if (firstAttempt === null) return []; // 1回目が失敗。フォールバックせずこの戦略をスキップする
    let results = firstAttempt;
    if (results.length === 0) {
        const fallback = await fetchEuropePmcResults(buildEuropePmcQuery(trialId, { fullText: true }));
        results = fallback ?? []; // 2回目（フォールバック）が失敗した場合はこれまでどおり空配列
    }
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
}

/**
 * 1つの試験ID（主IDまたは副登録番号）について3戦略を直列実行し、生の候補配列を返す
 * （dedupe/filterAlreadyImportedは呼ばない。呼び出し側の discoverPublicationCandidates() が
 * 主ID・副登録番号ぶんをまとめて統合してから通す）。
 *
 * 1. ctgov_reference: ctgPmids（呼び出し側が fetchCtgStudy() の結果から渡す。fetch不要）
 * 2. pubmed_id: esearch で試験IDから検索
 * 3. europepmc: Europe PMC で試験IDから検索（抄録限定、0件時のみ全文検索へフォールバック。
 *    jRCT/UMIN等にも有効。詳細は europePmcCandidates()/buildEuropePmcQuery() のJSDoc参照）
 *
 * 1・2で集めたPMIDの書誌は esummary に1リクエストでまとめて問い合わせる
 * （PMIDごとに1回呼ばない）。eutils（esearch → esummary）の間だけ delayMs 待機する
 * （PubMed E-utilitiesのAPIキー無し上限 3 req/s 対策）。Europe PMC は別ホストのAPIのため、
 * この待機の対象に含めていない。
 *
 * 各戦略の失敗（ネットワークエラー・非200・JSON不正）は例外を投げず、その戦略だけスキップして
 * 他戦略の結果を返す（呼び出し側の一括ループを止めないため）。全滅時は空配列。
 */
async function collectRawCandidatesForTrialId(
    refId: string,
    trialId: string,
    ctgPmids: string[],
    email: string | undefined,
    delayMs: number
): Promise<PublicationCandidateDraft[]> {
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

    return collected;
}

/**
 * registration行から結果論文の候補を発見する。主ID（input.trialId）に対して3戦略
 * （collectRawCandidatesForTrialId() 参照）を実行し、**主IDで生の候補が1件も無かったときだけ**、
 * 副登録番号（input.secondaryTrialIds）についても同じ3戦略で二巡目を回す（Issue #134）。
 *
 * ## ゲート（重要）
 * 判定は `dedupePublicationCandidates()` / `filterAlreadyImportedCandidates()` を通す**前**の
 * 生の件数（主IDの3戦略が返した候補の合計）で行う。「主戦略が何も返せなかった」ことを見たいの
 * であって、既存Referencesとの重複除去後の件数で判定すると意味が変わってしまう。
 *
 * このゲートは実測に基づく（AGENTS.md「試験登録レコードの論文候補探索」節・Issue #134参照。
 * 実測43件）: 副登録番号で救えた20件のうち18件は主IDで候補0件のケースであり、ゲートで
 * 取りこぼす分はこのうち2件にとどまる一方、副登録番号ぶんの追加リクエストが発生するのは
 * 163ペア中38件（23%）に収まる。#132 で問題になっているリクエスト量を新たに増やさないための
 * 設計判断であり、主IDで1件でも見つかった時点で副登録番号は一切見ない。
 *
 * ## 二巡目の中身（副登録番号1件ごと）
 * 1. 副登録番号が `/^NCT\d{8}$/` にマッチし、かつ options.fetchCtgPmids があれば呼んで
 *    ctgov_reference 候補にする。実測（43件）では副登録番号がNCTだった21件中19件をこの経路が
 *    当てた（取りこぼし9.5%）一方、UMIN副登録番号は9件中7件（77.8%）、JapicCTI副登録番号は
 *    4件中4件を取りこぼした。効くのは実質NCTだけだが、レジストリ種別で明示的な分岐はしない
 *    （実行コストは同じで分岐する理由が薄いうえ、`/^NCT\d{8}$/` に合わない副登録番号は
 *    そもそもこの経路を自然にスキップするため）。
 * 2. esearchPubmedIds() を副登録番号で呼ぶ（pubmed_id）。
 * 3. europePmcCandidates() を副登録番号で呼ぶ（europepmc）。
 * eutilsへの連続呼び出しの間には主IDと同じ delayMs 待機を入れる
 * （collectRawCandidatesForTrialId() 内、副登録番号ごとに独立して適用される）。
 *
 * 副登録番号由来の候補は `trialId` にその副登録番号を入れる（主IDではなく）。これにより
 * Publication_Candidates の列を増やさずに「どのキーで見つけたか」を後から追える。`strategy` は
 * 既存の3値のまま（新しい戦略値は追加しない）。
 *
 * ## 統合順
 * 主ID由来を先に積み、その後に副登録番号由来を積んでから
 * dedupePublicationCandidates（戦略の強い順: ctgov_reference → pubmed_id → europepmc。
 * 同じ強さなら配列の先勝ち＝主ID由来が残る）→ filterAlreadyImportedCandidates を通す。
 */
export async function discoverPublicationCandidates(
    input: DiscoverPublicationCandidatesInput,
    options: DiscoverPublicationCandidatesOptions = {}
): Promise<PublicationCandidateDraft[]> {
    const delayMs = options.delayMs ?? DEFAULT_EUTILS_DELAY_MS;
    const { refId, trialId, ctgPmids, existingRefs, email, secondaryTrialIds } = input;

    const collected = await collectRawCandidatesForTrialId(refId, trialId, ctgPmids, email, delayMs);

    // ゲート: 主IDの3戦略が生の候補を1件も出さなかったときだけ副登録番号で二巡目を回す。
    // 判定は dedupe/filterAlreadyImported を通す前の件数で行う（このJSDoc「ゲート」参照）。
    if (collected.length === 0 && secondaryTrialIds && secondaryTrialIds.length > 0) {
        for (const secondaryTrialId of secondaryTrialIds) {
            const secondaryCtgPmids = /^NCT\d{8}$/.test(secondaryTrialId) && options.fetchCtgPmids
                ? await options.fetchCtgPmids(secondaryTrialId)
                : [];
            collected.push(...await collectRawCandidatesForTrialId(
                refId, secondaryTrialId, secondaryCtgPmids, email, delayMs
            ));
        }
    }

    return filterAlreadyImportedCandidates(dedupePublicationCandidates(collected), existingRefs);
}
