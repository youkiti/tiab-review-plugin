// screening-position.ts - TiAb 表示位置の記憶・復元（Issue #140）
//
// キー開封中に「最後に表示した文献」をプロジェクトごとにローカル保存し、次回読み込み時に
// ステータスフィルターごと復元するための純関数。ストレージへの読み書きは src/lib/storage.ts、
// 保存点・復元点の呼び出しは src/sidepanel 側（render.ts / project.ts）が担当する。

/**
 * ステータスフィルターの許可リスト。
 * src/sidepanel/sidepanel.html の #status-filter の <option value> と一致させること。
 */
export const SCREENING_STATUS_FILTERS = [
    'pending',
    'all',
    'include',
    'exclude',
    'maybe',
    'conflict',
    'fulltext_candidates',
] as const;

export type ScreeningStatusFilter = typeof SCREENING_STATUS_FILTERS[number];

export interface ScreeningPosition {
    filter: ScreeningStatusFilter;
    refId: string;
    index: number;
}

/**
 * 値がステータスフィルターの許可リストに含まれるかどうかを判定する型ガード
 */
export function isScreeningStatusFilter(value: unknown): value is ScreeningStatusFilter {
    return typeof value === 'string'
        && (SCREENING_STATUS_FILTERS as readonly string[]).includes(value);
}

/**
 * chrome.storage から読んだ生の値を ScreeningPosition として検証する。
 * filter が許可リスト外、refId が非空文字列でない、index が 0 以上の整数でない、
 * のいずれかであれば壊れた値とみなして null を返す。
 */
export function parseScreeningPosition(raw: unknown): ScreeningPosition | null {
    if (!raw || typeof raw !== 'object') return null;

    const { filter, refId, index } = raw as Record<string, unknown>;

    if (!isScreeningStatusFilter(filter)) return null;
    if (typeof refId !== 'string' || refId.length === 0) return null;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;

    return { filter, refId, index };
}

/**
 * 保存された表示位置を、現在の絞り込み結果に対して解決する。
 * - refId が絞り込み結果に見つかればそのインデックスを返す
 * - 見つからない場合（保存後にその文献がフィルターから抜けた等）は、保存していた index を
 *   [0, filteredRefIds.length - 1] にクランプする。これにより「同じ位置に居た次の文献」が
 *   代わりに表示される
 * - 絞り込み結果が空配列なら 0 を返す
 */
export function resolveRestoredIndex(filteredRefIds: readonly string[], saved: ScreeningPosition): number {
    const foundIndex = filteredRefIds.indexOf(saved.refId);
    if (foundIndex !== -1) return foundIndex;

    if (filteredRefIds.length === 0) return 0;
    return Math.max(0, Math.min(saved.index, filteredRefIds.length - 1));
}
