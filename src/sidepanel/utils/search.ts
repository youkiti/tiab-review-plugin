/**
 * 検索クエリ処理ユーティリティ
 */

import { createSmartMatcher } from './text';
import type { Reference } from '../../lib/types';

export type SearchMode = 'and' | 'or';

export type ParsedSearch = {
    terms: string[];
    mode: SearchMode;
};

/**
 * 絞り込み対象文献の最小構造。ReferenceWithStatus 全体ではなく、
 * 検索・タームフィルターが実際に見る title / abstract のみを要求する。
 */
export type SearchableReference = Pick<Reference, 'title' | 'abstract'>;

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

/**
 * 文献の絞り込み対象テキストを作る（タイトル + 抄録）。
 * filters.ts / selectors.ts の検索フィルター・タームフィルターが従来使っていた
 * `${r.title} ${r.abstract || ''}` とバイト単位で同じ文字列を返す
 * （Issue #152（#150 工程1）で純関数として切り出した）。
 */
export function buildReferenceSearchText(ref: SearchableReference): string {
    return `${ref.title} ${ref.abstract || ''}`;
}

/**
 * 検索ターム文字列の配列から、絞り込み用マッチャー（g無し）をまとめて作る。
 * 文献配列の filter() コールバックの外で一度だけ呼ぶことで、正規表現の生成回数を
 * ターム数だけに抑える（文献数には比例させない。Issue #152（#150 工程1））。
 */
export function compileSearchMatchers(terms: string[]): RegExp[] {
    return terms.map(createSmartMatcher);
}

/**
 * タームフィルター（{ term, type }）の配列から絞り込み用マッチャーをまとめて作る。
 * type（include/exclude）はタグの見た目（addTermFilter 時の色分け）にのみ使う値で、
 * 絞り込みそのものでは現行仕様どおり見ない（Issue #152（#150 工程1）で純関数として
 * 切り出す際もこの挙動は変えていない）。
 */
export function compileTermFilterMatchers(termFilters: { term: string }[]): RegExp[] {
    return termFilters.map(f => createSmartMatcher(f.term));
}

/**
 * テキストが matchers を AND / OR で満たすか判定する。
 * mode が 'and' ならすべてのマッチャー、それ以外はいずれか1つがマッチすれば真。
 * matchers は g 無し（createSmartMatcher() 由来）を想定しており本来 lastIndex の
 * リセットは不要だが、将来 g 付きの正規表現が渡されても壊れないよう、判定前に
 * 念のため lastIndex を 0 に戻しておく（Issue #152（#150 工程1））。
 */
export function matchesSearchTerms(text: string, matchers: RegExp[], mode: SearchMode): boolean {
    const test = (matcher: RegExp): boolean => {
        matcher.lastIndex = 0;
        return matcher.test(text);
    };
    return mode === 'and' ? matchers.every(test) : matchers.some(test);
}

/**
 * 検索フィルターとタームフィルターの適用をまとめた純関数。
 * filters.ts / selectors.ts の getFilteredReferences() が二重に持っていた
 * 「検索フィルター → タームフィルター」の2ブロックを1本に集約したもの
 * （Issue #152（#150 工程1））。DOM / state には一切依存しない。
 *
 * 順序は変えないこと: 検索フィルターを先に適用し、その結果に対して
 * タームフィルターを重ねる（AND的に絞り込みが積み重なる）。
 *
 * 早期リターンのガードは必須:
 * - rawSearch.trim() が空なら検索フィルターは適用しない（全件通す）。
 * - termFilters.length === 0 ならタームフィルターは適用しない（全件通す）。
 *   ここを飛ばして matchesSearchTerms(..., [], 'or') を通すと、空配列の
 *   some() は false になり全件が消えてしまう。
 *
 * 正規表現の生成は各フィルターにつき filter() の外で1回だけ行う（生成回数が
 * ターム数のみに比例し、文献数には比例しない）。タームフィルターのAND経路は
 * g無しマッチャー（createSmartMatcher 由来）を使うことで、g付き正規表現の
 * lastIndex 使い回しによる偽陰性を避けている。
 */
export function applyTextFilters<T extends SearchableReference>(
    refs: T[],
    rawSearch: string,
    termFilters: { term: string }[],
    useAnd: boolean,
): T[] {
    let filtered = refs;

    if (rawSearch.trim()) {
        const { terms, mode } = parseSearchQuery(rawSearch, useAnd);
        const matchers = compileSearchMatchers(terms);
        filtered = filtered.filter(r => matchesSearchTerms(buildReferenceSearchText(r), matchers, mode));
    }

    if (termFilters.length > 0) {
        const matchers = compileTermFilterMatchers(termFilters);
        const mode: SearchMode = useAnd ? 'and' : 'or';
        filtered = filtered.filter(r => matchesSearchTerms(buildReferenceSearchText(r), matchers, mode));
    }

    return filtered;
}
