/**
 * ツアー「ai-first-run」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/ai-first-run.ts の AiFirstRunCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { AiFirstRunCondition } from '../../../../lib/guide/tours/ai-first-run';

export function computeAiFirstRunConditions(): Record<AiFirstRunCondition, boolean> {
    return {};
}
