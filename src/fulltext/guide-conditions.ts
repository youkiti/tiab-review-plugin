/**
 * 全文の判定ページのツアーが、手順の飛ばし判定（skipIf）に使う条件の計算。
 * 画面（DOM）の今の状態だけを見る。共通の条件（サイドパネルの画面の状態）はこのページでは使わない。
 * 遅延チャンク `fulltext-guide` に入る（入口は ./guide.ts）。
 */
import type { FulltextPageCondition } from '../lib/guide/tours/fulltext-page';

function isShown(id: string): boolean {
    const element = document.getElementById(id);
    return element !== null && element.getClientRects().length > 0;
}

export function computeFulltextGuideConditions(): Record<FulltextPageCondition, boolean> {
    // 除外理由の選択肢は、Exclude を選んだときだけ理由の欄ごと出る（保留ではメモ欄だけが出る）
    const reasonSelectShown = isShown('ft-reason-select');
    return {
        'reason-select-shown': reasonSelectShown,
        'reason-select-hidden': !reasonSelectShown,
    };
}
