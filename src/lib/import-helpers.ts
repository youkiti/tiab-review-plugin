// インポート共通ヘルパー関数
// ris-parser.ts, ctg-parser.ts, ictrp-parser.ts で共有

/**
 * 著者リストを最大10人に制限（11人以上の場合は "et al." を追加）
 */
export function truncateAuthors(authors: string[]): string {
    if (authors.length <= 10) {
        return authors.join('; ');
    }
    return authors.slice(0, 10).join('; ') + '; et al.';
}

/**
 * Abstract を 15,000 文字に切り詰め
 */
export function truncateAbstract(abstract?: string): string | undefined {
    if (!abstract) return undefined;
    if (abstract.length <= 15000) return abstract;
    return abstract.substring(0, 15000) + '...';
}

/**
 * 文字列を50,000文字に制限（Google Sheetsのセル制限対策）
 */
export function truncateField(value: string | undefined, maxLength = 50000): string | undefined {
    if (!value) return undefined;
    if (value.length <= maxLength) return value;
    return value.substring(0, maxLength - 3) + '...';
}

/**
 * 重複検出用にタイトルを正規化
 * - 小文字化
 * - 前後の [] を削除
 * - すべての記号（.,;:!?()[]"'）を削除
 * - 空白を正規化
 */
export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/^\s*\[.*?\]\s*/g, '')  // 先頭の [xxx] を削除
        .replace(/\s*\[.*?\]\s*$/g, '')  // 末尾の [xxx] を削除
        .replace(/[.,;:!?()\[\]"'\-–—]/g, '') // 記号を削除
        .replace(/\s+/g, ' ')            // 複数空白を単一に
        .trim();
}

/**
 * 重複検出キーを生成
 * 優先順位: PMID > DOI > 正規化タイトル
 */
export function generateDedupeKey(title?: string, pmid?: string, doi?: string): string {
    if (pmid) return `pmid:${pmid}`;
    if (doi) return `doi:${doi.toLowerCase()}`;
    return normalizeTitle(title || '');
}
