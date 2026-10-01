/**
 * ツアー「resolve-conflicts」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/resolve-conflicts.ts の ResolveConflictsCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { ResolveConflictsCondition } from '../../../../lib/guide/tours/resolve-conflicts';

export function computeResolveConflictsConditions(): Record<ResolveConflictsCondition, boolean> {
    return {};
}
