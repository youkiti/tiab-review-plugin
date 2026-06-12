// fulltext-retriever.ts
// フリーのOAフルテキストURLを取得するウォーターフォール実装
// fulltext-retriever (https://github.com/youkiti/fulltext-retriever) の
// Tier 1 open-access 取得ロジックを TypeScript へ移植

export type OaSource = 'pmc_oa' | 'europe_pmc' | 'unpaywall' | 'openalex';

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

/**
 * 無料OAソースからフルテキストURLを取得する（ウォーターフォール）
 *
 * 取得順: PMC OA → Europe PMC → Unpaywall → OpenAlex
 * 各ステップで最初に見つかった URL を返す。すべて失敗した場合は null。
 *
 * @param ref   doi / pmid を持つ文献情報
 * @param email Unpaywall / OpenAlex の polite pool 用メールアドレス
 */
export async function retrieveFulltextUrl(
    ref: { doi?: string; pmid?: string },
    email: string
): Promise<FulltextCandidate | null> {
    const { doi, pmid } = ref;

    // NCBI ID コンバーターで PMCID / PMID / DOI を補完
    const enriched = await enrichNcbiIds(pmid, doi, email);
    const pmcid = enriched.pmcid;
    const resolvedPmid = pmid || enriched.pmid;
    const resolvedDoi = doi || enriched.doi;

    const seen = new Set<string>();

    // 1. PMC OA Service (PMCID が必要)
    if (pmcid) {
        const url = await pmcOaUrl(pmcid);
        if (url && !seen.has(url)) {
            seen.add(url);
            return { url, source: 'pmc_oa' };
        }
    }

    // 2. Europe PMC (PMID が必要; DOI のみの文献も idconv で補完した PMID を使う)
    if (resolvedPmid) {
        const url = await europePmcUrl(resolvedPmid);
        if (url && !seen.has(url)) {
            seen.add(url);
            return { url, source: 'europe_pmc' };
        }
    }

    // 3. Unpaywall (DOI が必要)
    if (resolvedDoi) {
        for await (const url of unpaywallCandidates(resolvedDoi, email)) {
            if (!seen.has(url)) {
                seen.add(url);
                return { url, source: 'unpaywall' };
            }
        }
    }

    // 4. OpenAlex (DOI が必要)
    if (resolvedDoi) {
        for await (const url of openalexCandidates(resolvedDoi, email)) {
            if (!seen.has(url)) {
                seen.add(url);
                return { url, source: 'openalex' };
            }
        }
    }

    return null;
}
