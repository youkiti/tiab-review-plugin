/**
 * ツアー「fulltext-page」固有の条件（手順の skipIf）の、サイドパネル側の値。
 * このツアーは全文の判定ページで動き、条件は src/fulltext/guide-conditions.ts が画面から計算する。
 * サイドパネルでは評価されないので、条件名を網羅するだけで全部偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { FulltextPageCondition } from '../../../../lib/guide/tours/fulltext-page';

export function computeFulltextPageConditions(): Record<FulltextPageCondition, boolean> {
    return { 'reason-select-shown': false, 'reason-select-hidden': false };
}
