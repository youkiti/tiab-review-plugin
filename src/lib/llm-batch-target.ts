/**
 * LLM バッチ処理の対象（どの Run に、どの文献を投げるか）を決める純粋ロジック
 *
 * 設計の要点:
 *
 * 1. AI は「独立した判定者」として扱う。人間（自分を含む）が既に判定した文献であっても
 *    AI 判定は必要なので、人間の判定状況では対象を絞らない。
 *
 * 2. 対象の絞り込みは **Run 単位** で行う。「これから実行する Run で既に判定済みの文献」
 *    だけを除外する。これにより:
 *    - 同じ設定で再開 → 残りだけ処理（中断からの続き）
 *    - 別モデル・別プロンプト → 別 Run なので全文献が対象になり、Run 同士を比較できる
 *    - 「新規にやり直す」→ 新しい Run を作るので、既存 Run の判定を消さずに全件やり直せる
 *
 *    グローバルに「AI 判定済みか」で絞ると、最初の Run が全件を判定した時点で
 *    2 つ目以降の Run が常に 0 件になり、Run の採用選択機能が機能しなくなる。
 */

import type { LlmRun } from './types';

export interface BatchEligibleRef {
    /** この文献を判定した LLM バッチの reviewer_id 一覧（Run/active を問わず全て） */
    llmBatchIds?: string[];
}

/** バッチ実行上限セレクトの「すべて」を表す値 */
export const BATCH_MAX_COUNT_ALL = 'all';

/** 実行上限セレクトの値が不正だった場合のフォールバック */
const DEFAULT_BATCH_LIMIT = 100;

/**
 * LLM バッチの対象となる文献かどうか判定
 *
 * @param judgedBatchIds これから実行する Run に属する Batch ID の集合。
 *   新規 Run（＝まだ 1 件も判定していない）の場合は空集合を渡す。
 */
export function isBatchEligible(ref: BatchEligibleRef, judgedBatchIds: ReadonlySet<string>): boolean {
    if (judgedBatchIds.size === 0) return true;
    const batchIds = ref.llmBatchIds;
    if (!batchIds || batchIds.length === 0) return true;
    return !batchIds.some(id => judgedBatchIds.has(id));
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
export function selectBatchTargets<T extends BatchEligibleRef>(
    refs: readonly T[],
    maxCountRaw: string,
    judgedBatchIds: ReadonlySet<string>
): T[] {
    const eligible = refs.filter(ref => isBatchEligible(ref, judgedBatchIds));
    const limit = resolveBatchLimit(maxCountRaw);
    return limit === null ? eligible : eligible.slice(0, limit);
}

/**
 * config_hash から「これから実行する Run」を選ぶ
 *
 * 「新規にやり直す」導線では、既存 Run の判定を残したまま同一設定の Run をもう 1 つ作る。
 * そのため同じ config_hash の Run が複数存在しうる。中断からの再開は常に
 * **最後に作った Run** の続きであるべきなので created_at の新しい方を優先する。
 * created_at が同一のときのみ、確定済み Run を優先する（閾値を再利用できるため）。
 */
export function pickRunByConfigHash(runs: readonly LlmRun[], configHash: string): LlmRun | null {
    const matched = runs.filter(r => r.config_hash === configHash);
    if (matched.length === 0) return null;

    const rank = (run: LlmRun): number => {
        if (run.is_active && run.status === 'confirmed') return 2;
        if (run.status === 'confirmed') return 1;
        return 0;
    };

    return [...matched].sort((a, b) => {
        const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        if (diff !== 0) return diff;
        return rank(b) - rank(a);
    })[0];
}

/**
 * legacy 移行（run_id 空の Batch 行の集約）で、同一 config_hash の Run が複数ある場合の受け皿を選ぶ
 *
 * legacy バッチは「やり直し」より前に実行されたものなので、最も古い Run に属させる。
 */
export function pickLegacyRunByConfigHash(runs: readonly LlmRun[], configHash: string): LlmRun | null {
    const matched = runs.filter(r => r.config_hash === configHash);
    if (matched.length === 0) return null;
    return [...matched].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    )[0];
}
