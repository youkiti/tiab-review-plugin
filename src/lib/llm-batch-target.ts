/**
 * LLM バッチ処理の対象文献を決める純粋ロジック
 *
 * AI は「独立した判定者」として扱う。人間（自分を含む）が既に判定した文献であっても
 * AI 判定は必要なので、対象からは除外しない。
 * 除外するのは「既に AI が判定済みの文献」だけで、これは同一文献を別バッチで
 * 再処理して API 呼び出しが無駄になるのを防ぐためである。
 */

export interface BatchEligibleRef {
    /** LLM バッチで判定済みか（pending/confirmed/inactive を問わず） */
    hasAnyLlmDecision?: boolean;
}

/** バッチ実行上限セレクトの「すべて」を表す値 */
export const BATCH_MAX_COUNT_ALL = 'all';

/** 実行上限セレクトの値が不正だった場合のフォールバック */
const DEFAULT_BATCH_LIMIT = 100;

/**
 * LLM バッチの対象となる文献かどうか判定
 *
 * 人間の判定状況（`status`）は条件に含めない。含めてしまうと
 * 「自分が手動判定した分だけ AI の対象件数が減る」という、
 * ログインユーザーによって AI の判定範囲が変わる非対称な挙動になる。
 */
export function isBatchEligible(ref: BatchEligibleRef): boolean {
    return !ref.hasAnyLlmDecision;
}

/**
 * 実行上限セレクトの値を件数に変換する
 * @returns 「すべて」の場合は null（上限なし）
 */
export function resolveBatchLimit(maxCountRaw: string): number | null {
    if (maxCountRaw === BATCH_MAX_COUNT_ALL) return null;
    return Math.max(parseInt(maxCountRaw, 10) || DEFAULT_BATCH_LIMIT, 1);
}

/**
 * 対象文献のうち、今回のバッチで実際に処理する分を切り出す
 */
export function selectBatchTargets<T extends BatchEligibleRef>(refs: T[], maxCountRaw: string): T[] {
    const eligible = refs.filter(isBatchEligible);
    const limit = resolveBatchLimit(maxCountRaw);
    return limit === null ? eligible : eligible.slice(0, limit);
}
