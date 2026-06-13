// fulltext-retriever.ts
// フリーのOAフルテキストURLを取得するウォーターフォール実装
// fulltext-retriever (https://github.com/youkiti/fulltext-retriever) の
// Tier 1 open-access 取得ロジックを TypeScript へ移植

import { uploadPdfToDrive, buildPdfFileName } from './drive-api';

export type OaSource = 'pmc_oa' | 'europe_pmc' | 'unpaywall' | 'openalex' | 'publisher';

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

// 出版社直リンク: Springer / BMC は content/pdf エンドポイントで
// OA論文の実PDFを直接返す。NCBI/Europe PMC がまだPDFをミラーしていない
// 新着論文でも出版社には実体があることが多いため、フォールバック候補に加える。
// gold OA の BMC (DOI 10.1186/) のみ対象（ハイブリッド誌の有料記事を
// 誤って候補化しないように）。スラッシュはパスとして扱うので encode しない。
function springerDirectUrl(doi: string): string | null {
    if (!doi.startsWith('10.1186/')) return null;
    return `https://link.springer.com/content/pdf/${doi}.pdf`;
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
}

// ---------------------------------------------------------------------------
// PDFダウンロード → Drive保存パイプライン
// ---------------------------------------------------------------------------

/**
 * フルテキスト取得の結果
 * - cached:  PDF を Drive に保存済み（url は Drive の閲覧リンク）
 * - linked:  URL は見つかったが PDF を取得できなかった（外部直リンクを記録）
 * - none:    どの無料OAソースにも見つからなかった
 */
export type FulltextFetchOutcome =
    | { kind: 'cached'; url: string; source: OaSource }
    | { kind: 'linked'; url: string; source: OaSource }
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

async function fetchPdfResult(url: string): Promise<PdfFetchResult> {
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
const FALLBACK_PRIORITY: OaSource[] = [
    'publisher', 'unpaywall', 'openalex', 'europe_pmc', 'pmc_oa',
];

/**
 * OA候補URLを順に検証し、PDFが取れたものをDriveに保存する。
 *
 * 各候補を実際にダウンロード検証し、最初に実PDFが取れたものをキャッシュする。
 * どれもPDFにならない場合は、ブラウザで開けそうなURL（openable）のうち
 * 最も信頼できるソースのものを「リンクのみ」記録としてフォールバックする。
 * Driveフォルダは PDF が実際に取得できた時に初めて作成したいので、
 * 呼び出し側から ensureFolder（メモ化推奨）を受け取る。
 */
export async function retrieveAndCacheFulltext(
    ref: { ref_id: string; title?: string; doi?: string; pmid?: string },
    email: string,
    ensureFolder: () => Promise<string>
): Promise<FulltextFetchOutcome> {
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
