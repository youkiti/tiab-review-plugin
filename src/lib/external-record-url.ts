// external-record-url.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3b: PMID/DOIから外部の書誌ページURLを
// 組み立てる純関数（UI非依存・fetch非依存）。
//
// 元は src/sidepanel/features/fulltext-tab.ts の recordPageUrl()（文献カードのDOI/PubMed
// ボタン用。doi優先・1本のURLだけを返す）にインライン実装されていたものを、候補パネル
// （fulltext-publication-candidates.ts。PubMed・DOIを別々のリンクとして両方出したい）でも
// 同じ組み立て規則を使えるよう、URL文字列の組み立てそのものだけをここへ切り出した。
// recordPageUrl() 自身はこの2関数を呼ぶ薄いラッパーに変更済みで、組み立て規則・返り値は
// 変わっていない（重複実装を避けるための一般化）。

/** `https://doi.org/{doi}` 形式のURLを組み立てる */
export function buildDoiUrl(doi: string): string {
    return `https://doi.org/${encodeURIComponent(doi)}`;
}

/** `https://pubmed.ncbi.nlm.nih.gov/{pmid}/` 形式のURLを組み立てる */
export function buildPubmedUrl(pmid: string): string {
    return `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/`;
}
