/**
 * ツアー「fulltext-page」固有の条件（手順の skipIf）の、サイドパネル側の値。
 * このツアーは全文の判定ページでだけ動く（サイドパネルのランナーは page が 'fulltext' のツアーを始めも再開もしない）ので、
 * 実際の条件は src/fulltext/guide-conditions.ts が画面から計算し、この値がツアーの進行に使われることは無い。
 * ここは、全ツアーの条件の型を網羅するための形だけの実装（条件名を網羅していないとコンパイルが通らない）で、全部偽を返す。
 * 遅延チャンク `guide-feature` に入る。
 */
import type { FulltextPageCondition } from '../../../../lib/guide/tours/fulltext-page';

export function computeFulltextPageConditions(): Record<FulltextPageCondition, boolean> {
    return { 'reason-select-shown': false, 'reason-select-hidden': false };
}
