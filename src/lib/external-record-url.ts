// external-record-url.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3b: PMID/DOIから外部の書誌ページURLを
// 組み立てる純関数（UI非依存・fetch非依存）。
//
// 文献カード（fulltext/tab.ts）のDOI・PubMedボタンと、候補パネル（fulltext/publication-candidates.ts）
// のPubMed・DOIリンクが、同じ組み立て規則を使えるよう、URL文字列の組み立てだけをここへ置く。
// Google Scholar の検索URLも同じ理由でここに置く（文献カードと PDF判定画面で共有する）。

/** `https://doi.org/{doi}` 形式のURLを組み立てる */
export function buildDoiUrl(doi: string): string {
    return `https://doi.org/${encodeURIComponent(doi)}`;
}

/** `https://pubmed.ncbi.nlm.nih.gov/{pmid}/` 形式のURLを組み立てる */
export function buildPubmedUrl(pmid: string): string {
    return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}

/**
 * Google Scholar の検索結果ページのURLを組み立てる。
 * DOI（前後空白を除いて空でないもの）があればDOIで検索し、無ければタイトルの完全一致
 * （ダブルクォートで囲む）で検索する。どちらも空なら null。
 * タイトル中のダブルクォート（半角・全角）は、完全一致の囲みを壊すので取り除く。
 */
export function buildGoogleScholarUrl(ref: { doi?: string; title?: string }): string | null {
    const base = 'https://scholar.google.com/scholar?q=';
    const doi = (ref.doi ?? '').trim();
    if (doi) return base + encodeURIComponent(doi);
    const title = (ref.title ?? '').replace(/["\u201C\u201D]/g, '').replace(/\s+/g, ' ').trim();
    if (title) return base + encodeURIComponent(`"${title}"`);
    return null;
}
