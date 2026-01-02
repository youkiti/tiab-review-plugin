/**
 * 検索クエリ処理ユーティリティ
 */

export type SearchMode = 'and' | 'or';

export type ParsedSearch = {
    terms: string[];
    mode: SearchMode;
};

/**
 * 検索クエリを解析してタームとモードを返す
 * @param raw 生の検索クエリ文字列
 * @param defaultUseAnd AND検索をデフォルトにするかどうか
 */
export function parseSearchQuery(raw: string, defaultUseAnd: boolean): ParsedSearch {
    const trimmed = raw.trim();
    const fallbackMode: SearchMode = defaultUseAnd ? 'and' : 'or';

    if (!trimmed) {
        return { terms: [], mode: fallbackMode };
    }

    // OR検索の判定 (e.g. "term1 OR term2")
    const orSplit = trimmed.split(/\s+OR\s+/i).filter(Boolean);
    if (orSplit.length > 1) {
        return { terms: orSplit, mode: 'or' };
    }

    // AND検索の判定 (e.g. "term1 AND term2")
    const andSplit = trimmed.split(/\s+AND\s+/i).filter(Boolean);
    if (andSplit.length > 1) {
        return { terms: andSplit, mode: 'and' };
    }

    // 空白区切り
    const terms = trimmed.split(/\s+/).filter(Boolean);
    return { terms, mode: fallbackMode };
}
