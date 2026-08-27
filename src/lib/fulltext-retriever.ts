// fulltext-retriever.ts
// フリーのOAフルテキストURLを取得するウォーターフォール実装
// fulltext-retriever (https://github.com/youkiti/fulltext-retriever) の
// Tier 1 open-access 取得ロジックを TypeScript へ移植

import { uploadPdfToDrive, buildPdfFileName, uploadHtmlToDrive } from './drive-api';
import { isRegistrationRecord, extractTrialId, parseRegistryFieldsFromAbstract, buildRegistrySnapshotHtml, buildRegistrySnapshotFileName, isSafeHttpUrl } from './registry-record';
import { fetchCtgStudy } from './registry-api';
import type { ReferenceRecordType } from './types';

// 'registry' は registration 行（Issue #118 チャンク1）専用のソース。OAウォーターフォール
// （iterateFulltextCandidates）には一切乗らないため、後述の FALLBACK_PRIORITY には含めない
// （理由はFALLBACK_PRIORITY定義側のコメント参照）。
export type OaSource = 'pmc_oa' | 'europe_pmc' | 'unpaywall' | 'openalex' | 'publisher' | 'landing_meta' | 'registry';

export interface FulltextCandidate {
    url: string;
    source: OaSource;
}

interface NcbiIds {
    pmcid?: string;
    pmid?: string;
    doi?: string;
}

// NCBI ID コンバーター: 既知の PMID/DOI から PMCID 等を補完
// 旧 www.ncbi.nlm.nih.gov/pmc/utils/idconv は pmc.ncbi.nlm.nih.gov へ 301 移転済み
async function enrichNcbiIds(pmid?: string, doi?: string, email?: string): Promise<NcbiIds> {
    const known = pmid || doi;
    if (!known) return {};

    const params = new URLSearchParams({ ids: known, format: 'json' });
    params.set('tool', 'tiab-review-plugin');
    if (email) params.set('email', email);
    try {
        const resp = await fetch(
            `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?${params}`
        );
        if (!resp.ok) return {};
        const data = await resp.json() as {
            // pmid は数値で返ることがある
            records?: Array<{ pmcid?: string; pmid?: string | number; doi?: string; status?: string }>;
        };
        const records = data.records ?? [];
        if (!records.length || records[0].status === 'error') return {};
        const rec = records[0];
        return {
            pmcid: rec.pmcid,
            pmid: rec.pmid != null ? String(rec.pmid) : pmid,
            doi: rec.doi || doi,
        };
    } catch {
        return {};
    }
}

// PMC OA Service: PMCID から直接 PDF URL を取得、失敗時は PMC の記事 PDF URL にフォールバック
// OA Service は PMC 収載でも OA サブセット外の記事 (例: ハイブリッド誌 CC-BY) には
// idDoesNotExist を返すため、その場合もブラウザで開ける PMC 記事 PDF URL を返す
async function pmcOaUrl(pmcid: string): Promise<string> {
    try {
        const params = new URLSearchParams({ id: pmcid, format: 'pdf' });
        const resp = await fetch(
            `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?${params}`
        );
        if (resp.ok) {
            const xml = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(xml, 'text/xml');
            for (const link of Array.from(doc.querySelectorAll('link'))) {
                const fmt = link.getAttribute('format');
                const href = link.getAttribute('href');
                if (fmt === 'pdf' && href) {
                    return href.startsWith('ftp://')
                        ? href.replace('ftp://', 'https://')
                        : href;
                }
            }
        }
    } catch {
        // フォールバックへ
    }
    return `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`;
}

// Europe PMC: PMID で OA PDF URL を検索
async function europePmcUrl(pmid: string): Promise<string | null> {
    try {
        const params = new URLSearchParams({
            query: `EXT_ID:${pmid} SRC:MED`,
            format: 'json',
            resultType: 'core',
        });
        const resp = await fetch(
            `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`
        );
        if (!resp.ok) return null;
        const data = await resp.json() as {
            resultList?: {
                result?: Array<{
                    fullTextUrlList?: {
                        fullTextUrl?: Array<{
                            documentStyle: string;
                            availability: string;
                            url: string;
                        }>;
                    };
                }>;
            };
        };
        const results = data.resultList?.result ?? [];
        if (!results.length) return null;
        const urls = results[0].fullTextUrlList?.fullTextUrl ?? [];
        for (const u of urls) {
            if (u.documentStyle === 'pdf' && u.availability === 'Open access') {
                return u.url;
            }
        }
        return null;
    } catch {
        return null;
    }
}

// Unpaywall: DOI から OA 候補 URL を列挙
async function* unpaywallCandidates(doi: string, email: string): AsyncGenerator<string> {
    try {
        const params = new URLSearchParams({ email });
        const resp = await fetch(
            `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?${params}`
        );
        if (!resp.ok) return;
        const data = await resp.json() as {
            best_oa_location?: { url_for_pdf?: string; url?: string };
            oa_locations?: Array<{ url_for_pdf?: string; url?: string }>;
        };
        const seen = new Set<string>();
        const locations: Array<{ url_for_pdf?: string; url?: string }> = [];
        if (data.best_oa_location) locations.push(data.best_oa_location);
        locations.push(...(data.oa_locations ?? []));
        for (const loc of locations) {
            for (const key of ['url_for_pdf', 'url'] as const) {
                const cand = loc?.[key];
                if (cand && !seen.has(cand)) {
                    seen.add(cand);
                    yield cand;
                }
            }
        }
    } catch {
        // ignore
    }
}

// OpenAlex: DOI から OA 候補 URL を列挙
async function* openalexCandidates(doi: string, email: string): AsyncGenerator<string> {
    try {
        const params = new URLSearchParams({ mailto: email });
        const resp = await fetch(
            `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?${params}`
        );
        if (!resp.ok) return;
        const data = await resp.json() as {
            best_oa_location?: { pdf_url?: string };
            locations?: Array<{ pdf_url?: string }>;
        };
        const seen = new Set<string>();
        const locations: Array<{ pdf_url?: string }> = [];
        if (data.best_oa_location) locations.push(data.best_oa_location);
        locations.push(...(data.locations ?? []));
        for (const loc of locations) {
            const cand = loc?.pdf_url;
            if (cand && !seen.has(cand)) {
                seen.add(cand);
                yield cand;
            }
        }
    } catch {
        // ignore
    }
}

// 出版社直リンク: link.springer.com 配信の論文は content/pdf エンドポイントで
// PDF を直接返す。NCBI/Europe PMC がまだPDFをミラーしていない新着論文でも
// 出版社には実体があることが多いため、フォールバック候補に加える。
// 対象は link.springer.com でホストされる Springer 本体 (10.1007/) と
// BMC (10.1186/)。OA論文なら実PDFが取れて Drive キャッシュされ、購読/ハイブリッド
// 誌の有料記事でも、ブラウザ（所属機関アクセスのCookie付き）で開けば記事HTMLページ
// ではなく直接PDFが開く「publisher優先」リンクとして記録できる。実PDFか否かは
// マジックバイト検証で判定するため、有料記事を誤ってPDFキャッシュする心配はない。
// スラッシュはパスとして扱うので encode しない。
const SPRINGER_LINK_PREFIXES = ['10.1007/', '10.1186/'];
function springerDirectUrl(doi: string): string | null {
    if (!SPRINGER_LINK_PREFIXES.some((p) => doi.startsWith(p))) return null;
    return `https://link.springer.com/content/pdf/${doi}.pdf`;
}

// 最小限のHTMLエンティティデコード（citation_pdf_url の content に現れる &amp; 等）
function decodeHtmlEntities(s: string): string {
    return s
        .replace(/&amp;/gi, '&')
        .replace(/&#38;/g, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'");
}

// ランディングページHTMLから <meta name="citation_pdf_url" content="..."> を抽出する。
// Highwire互換のこのメタタグは Google Scholar 収載のためほぼ全ての主要出版社
// （Springer / Wiley / Oxford / Taylor&Francis / SAGE / Elsevier 等）が埋め込むため、
// 出版社ごとのURLパターンを個別に持たずに汎用的にPDF直リンクを得られる。
// 属性順・引用符の有無のばらつきに対応するため <head> 内を正規表現で走査する
// （DOMParserでの全文構築を避け軽量化）。
function extractCitationPdfUrl(html: string): string | null {
    const headEnd = html.search(/<\/head>/i);
    const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
    const metaTags = head.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
        if (!/\bname\s*=\s*["']?citation_pdf_url["']?/i.test(tag)) continue;
        const m = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
        if (m && m[1].trim()) return decodeHtmlEntities(m[1].trim());
    }
    return null;
}

// 汎用フォールバック: ランディングページを取得し citation_pdf_url からPDF直リンクを得る。
// doi.org から出版社ページへ解決し、HTMLに宣言されたPDF URLを抽出する。
// 取得には任意HTTPSサイトへの実行時権限が要る（呼び出し側で要求済み）。
// 未許可ホストはCORSで本文を読めず null を返すが、その場合も既存OAソースの
// 結果は維持されるため副作用はない。
async function landingPagePdfUrl(landingUrl: string): Promise<string | null> {
    try {
        const resp = await fetch(landingUrl, { credentials: 'omit' });
        if (!resp.ok) return null;
        const ct = resp.headers.get('content-type') ?? '';
        if (ct && !/html|xml/i.test(ct)) return null;
        const html = await resp.text();
        const pdfUrl = extractCitationPdfUrl(html);
        if (!pdfUrl) return null;
        // 相対URLは最終到達URL（resp.url）基準で絶対化する
        return new URL(pdfUrl, resp.url || landingUrl).href;
    } catch {
        return null;
    }
}

/**
 * 無料OA/出版社ソースからフルテキスト候補URLを列挙する（ウォーターフォール）
 *
 * 取得順: PMC OA → Europe PMC → 出版社直リンク → Unpaywall → OpenAlex
 * 各ソースの候補を重複排除しつつ順に yield する。呼び出し側は
 * 実際にPDFが取れるまで各候補を検証して進める（retrieveAndCacheFulltext 参照）。
 *
 * @param ref   doi / pmid を持つ文献情報
 * @param email Unpaywall / OpenAlex の polite pool 用メールアドレス
 */
export async function* iterateFulltextCandidates(
    ref: { doi?: string; pmid?: string },
    email: string
): AsyncGenerator<FulltextCandidate> {
    const { doi, pmid } = ref;

    // NCBI ID コンバーターで PMCID / PMID / DOI を補完
    const enriched = await enrichNcbiIds(pmid, doi, email);
    const pmcid = enriched.pmcid;
    const resolvedPmid = pmid || enriched.pmid;
    const resolvedDoi = doi || enriched.doi;

    const seen = new Set<string>();
    const emit = function* (url: string | null, source: OaSource): Generator<FulltextCandidate> {
        if (url && !seen.has(url)) {
            seen.add(url);
            return yield { url, source };
        }
    };

    // 1. PMC OA Service (PMCID が必要)
    if (pmcid) {
        yield* emit(await pmcOaUrl(pmcid), 'pmc_oa');
        // PMC記事PDFページ（実PDFが取れない時の人間向けフォールバック導線）
        yield* emit(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/`, 'pmc_oa');
    }

    // 2. Europe PMC (PMID が必要; DOI のみの文献も idconv で補完した PMID を使う)
    if (resolvedPmid) {
        yield* emit(await europePmcUrl(resolvedPmid), 'europe_pmc');
    }

    // 3. 出版社直リンク (Springer / BMC)
    if (resolvedDoi) {
        yield* emit(springerDirectUrl(resolvedDoi), 'publisher');
    }

    // 4. Unpaywall (DOI が必要)
    if (resolvedDoi) {
        for await (const url of unpaywallCandidates(resolvedDoi, email)) {
            yield* emit(url, 'unpaywall');
        }
    }

    // 5. OpenAlex (DOI が必要)
    if (resolvedDoi) {
        for await (const url of openalexCandidates(resolvedDoi, email)) {
            yield* emit(url, 'openalex');
        }
    }

    // 6. 汎用フォールバック: ランディングページの citation_pdf_url からPDF直リンクを抽出
    //    （Springer以外の任意出版社にも対応）。上流のOAソースで実PDFが取れた場合は
    //    ジェネレータがここまで進まないため、HTML取得は本当に必要な時だけ走る。
    if (resolvedDoi) {
        yield* emit(await landingPagePdfUrl(`https://doi.org/${resolvedDoi}`), 'landing_meta');
    }
}

// ---------------------------------------------------------------------------
// PDFダウンロード → Drive保存パイプライン
// ---------------------------------------------------------------------------

/**
 * フルテキスト取得の結果
 * - cached:  PDF を Drive に保存済み（url は Drive の閲覧リンク）
 * - linked:  URL は見つかったが PDF を取得できなかった（外部直リンクを記録）
 * - none:    どの無料OAソースにも見つからなかった
 *
 * registryPmids は registration行（source:'registry'）専用の任意フィールド（Issue #118
 * チャンク2 パスB）。CTGov の referencesModule 由来PMID（fetchCtgStudy() の pmids）を
 * retrieveRegistrationSnapshot() がここに載せ、呼び出し側（fulltext-tab.ts）が
 * discoverPublicationCandidates() の ctgPmids にそのまま渡せるようにする。CTG API を
 * スナップショット取得と論文候補探索で2回叩かないための配線。既存のconsumerは
 * kind/url/source しか見ていないため後方互換（none には付けない）。
 */
export type FulltextFetchOutcome =
    | { kind: 'cached'; url: string; source: OaSource; registryPmids?: string[] }
    | { kind: 'linked'; url: string; source: OaSource; registryPmids?: string[] }
    | { kind: 'none' };

/**
 * URLへのPDF取得を試み、結果を分類する。
 * - pdf:      実PDFバイトを取得できた（Drive保存対象）
 * - openable: URLは生きているがPDFバイトは取れなかった
 *             （HTMLランディングページ or host permission未許可によるCORS/ネットワークエラー）。
 *             ブラウザ（ユーザーのセッション）なら開ける可能性が高いのでリンク記録の候補にする。
 * - dead:     HTTPエラー（404/500等）。URL自体が無効なのでフォールバックに使わない。
 */
type PdfFetchResult =
    | { kind: 'pdf'; blob: Blob }
    | { kind: 'openable' }
    | { kind: 'dead' };

export async function fetchPdfResult(url: string): Promise<PdfFetchResult> {
    let resp: Response;
    try {
        resp = await fetch(url, { credentials: 'omit' });
    } catch {
        // CORS / ネットワークエラー: 権限未許可でも実体は存在しうる
        return { kind: 'openable' };
    }
    if (!resp.ok) return { kind: 'dead' };
    try {
        const blob = await resp.blob();
        // マジックナンバーで PDF か検証（Content-Type は信用できないサーバが多い）
        const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
        if (String.fromCharCode(...head).startsWith('%PDF')) {
            return { kind: 'pdf', blob };
        }
    } catch {
        // 読み取り失敗は openable 扱い
    }
    return { kind: 'openable' };
}

// リンクのみフォールバック時、どのソースのURLを優先して人間に提示するか。
// 出版社直リンクが最も「ブラウザで開けば実PDF」に近いので最優先。
//
// 'registry' はここに含めない: retrieveAndCacheFulltext() は isRegistrationRecord(ref) が
// true の場合、iterateFulltextCandidates による OA ウォーターフォールへ進む前に
// retrieveRegistrationSnapshot() へ分岐して return するため、source:'registry' の
// FulltextCandidate が openables 配列（このソート対象）に積まれることはない。
// 仮に将来 'registry' を持つ候補がこの配列に紛れ込んだ場合、indexOf() が -1 を返し
// 配列先頭（最優先）に来てしまうため、含めない方が「未知ソースは事故で紛れ込んだもの」
// として自然に見分けられる（誤って最優先扱いにならない）。
const FALLBACK_PRIORITY: OaSource[] = [
    // landing_meta と publisher は「ブラウザで開けば実PDF」に最も近い直リンク。
    // citation_pdf_url は出版社が宣言した正規のPDF URLなので最優先。
    'landing_meta', 'publisher', 'unpaywall', 'openalex', 'europe_pmc', 'pmc_oa',
];

/**
 * retrieveAndCacheFulltext() が受け取る文献情報。
 * 通常論文（record_type='article'相当）の取得には doi/pmid のみ使うが、registration行の
 * 判定（isRegistrationRecord）・試験ID抽出（extractTrialId）・スナップショット生成
 * （retrieveRegistrationSnapshot）には journal/source/record_type/url/abstract/year も
 * 必要なため、Issue #118 チャンク2で型を widen した。呼び出し側（fulltext-tab.ts /
 * fulltext.ts）は Reference 相当のオブジェクトをそのまま渡しているため、この widen だけで
 * 呼び出し側の変更は不要。
 */
export interface FulltextRetrievalRef {
    ref_id: string;
    title?: string;
    doi?: string;
    pmid?: string;
    journal?: string;
    source?: string;
    record_type?: ReferenceRecordType;
    url?: string;
    abstract?: string;
    year?: number;
}

/**
 * registration 行（CTG/ICTRP由来の試験登録レコード）向けの取得経路。
 *
 * CTG/ICTRP由来の行は試験ID（NCT/JPRN等）が pmid 列に入っており、pmid/doiを前提とする
 * OAウォーターフォールへ入れても必ず unavailable で行き止まりになる。そのためこの経路は
 * iterateFulltextCandidates を一切呼ばず、レジストリの内容を自己完結HTMLスナップショット
 * として組み立てDriveへ保存する。
 *
 * 1. NCT番号なら ClinicalTrials.gov API v2（fetchCtgStudy）を試す。
 * 2. 取得できなかった場合（API失敗、または元々NCT以外のレジストリでAPI対象外）は、
 *    References に保存済みのフィールド（title / abstractをparseRegistryFieldsFromAbstractで
 *    分解したもの / journal をレジストリ名として / url を原簿URLとして / year）だけで
 *    スナップショットを組み立てる。この経路はネットワーク不要。
 * 3. Drive保存に失敗した場合は例外を外に投げず、原簿URL（ref.url）が isSafeHttpUrl() を
 *    通れば linked、通らなければ（javascript:/data:等の危険なスキームや相対URL・不正な値）
 *    または url自体が無ければ none にフォールバックする（一括ループを止めないため。OA経路の
 *    catch → console.warn の作法に倣う）。
 */
async function retrieveRegistrationSnapshot(
    ref: FulltextRetrievalRef,
    ensureFolder: () => Promise<string>
): Promise<FulltextFetchOutcome> {
    const trial = extractTrialId(ref);
    const retrievedAt = new Date().toISOString();

    const ctgResult = trial?.kind === 'nct' ? await fetchCtgStudy(trial.id) : null;

    const title = ctgResult?.title || ref.title || trial?.id || ref.ref_id;
    const registryName = ctgResult ? 'ClinicalTrials.gov' : (ref.journal || 'レジストリ');
    const fields = ctgResult
        ? ctgResult.fields
        : parseRegistryFieldsFromAbstract(ref.abstract);
    if (!ctgResult && ref.year != null) {
        fields.push({ label: '登録年', value: String(ref.year) });
    }

    const html = buildRegistrySnapshotHtml({
        trialId: trial?.id,
        title,
        registryName,
        sourceUrl: ref.url,
        retrievedAt,
        fields,
    });

    // CTGov referencesModule 由来PMID。呼び出し側（fulltext-tab.ts）がパスBの論文候補探索
    // （discoverPublicationCandidates の ctgPmids）にそのまま渡せるよう outcome に載せる。
    // CTG API をスナップショット取得と論文候補探索で2回叩かないための配線。
    const registryPmids = ctgResult?.pmids;

    try {
        const folderId = await ensureFolder();
        const file = await uploadHtmlToDrive(folderId, buildRegistrySnapshotFileName(ref), html);
        return { kind: 'cached', url: file.webViewLink, source: 'registry', registryPmids };
    } catch (err) {
        console.warn('[fulltext-retriever] レジストリスナップショットのDrive保存に失敗、リンクのみ記録:', err);
        // ref.url は References の url 列（ユーザーが直接編集できるセル）由来のため、
        // javascript:/data: 等の危険なスキームや相対URLが入りうる。isSafeHttpUrl() を通った
        // http/https のURLだけを linked として返す（この値はサイドパネルの buildLinkBtn() を
        // 経由して chrome.tabs.create({ url }) にそのまま渡るため、無検証で通してはいけない）。
        // 安全でなければ値ごと捨てて none にフォールバックする（例外は投げず一括ループを止めない）。
        return ref.url && isSafeHttpUrl(ref.url)
            ? { kind: 'linked', url: ref.url, source: 'registry', registryPmids }
            : { kind: 'none' };
    }
}

/**
 * OA候補URLを順に検証し、PDFが取れたものをDriveに保存する。
 *
 * 各候補を実際にダウンロード検証し、最初に実PDFが取れたものをキャッシュする。
 * どれもPDFにならない場合は、ブラウザで開けそうなURL（openable）のうち
 * 最も信頼できるソースのものを「リンクのみ」記録としてフォールバックする。
 * Driveフォルダは PDF が実際に取得できた時に初めて作成したいので、
 * 呼び出し側から ensureFolder（メモ化推奨）を受け取る。
 *
 * registration行（isRegistrationRecord(ref) が true）はOAウォーターフォールに一切入らず、
 * retrieveRegistrationSnapshot() へ分岐する（Issue #118 チャンク2）。通常の論文行の挙動は
 * この分岐追加前と変わらない。
 */
export async function retrieveAndCacheFulltext(
    ref: FulltextRetrievalRef,
    email: string,
    ensureFolder: () => Promise<string>
): Promise<FulltextFetchOutcome> {
    if (isRegistrationRecord(ref)) {
        return retrieveRegistrationSnapshot(ref, ensureFolder);
    }

    const openables: FulltextCandidate[] = [];

    for await (const cand of iterateFulltextCandidates(ref, email)) {
        const res = await fetchPdfResult(cand.url);
        if (res.kind === 'pdf') {
            try {
                const folderId = await ensureFolder();
                const file = await uploadPdfToDrive(folderId, buildPdfFileName(ref), res.blob);
                return { kind: 'cached', url: file.webViewLink, source: cand.source };
            } catch (err) {
                // Drive側の問題: 他候補も保存できない。実PDFが取れたURLが最良のリンク記録
                console.warn('[fulltext-retriever] Drive保存に失敗、リンクのみ記録:', err);
                return { kind: 'linked', url: cand.url, source: cand.source };
            }
        } else if (res.kind === 'openable') {
            openables.push(cand);
        }
        // dead はスキップ
    }

    if (openables.length === 0) return { kind: 'none' };
    const best = openables.slice().sort(
        (a, b) => FALLBACK_PRIORITY.indexOf(a.source) - FALLBACK_PRIORITY.indexOf(b.source)
    )[0];
    return { kind: 'linked', url: best.url, source: best.source };
}
