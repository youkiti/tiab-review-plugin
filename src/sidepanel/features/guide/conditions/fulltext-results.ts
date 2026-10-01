/**
 * ツアー「fulltext-results」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/fulltext-results.ts の FulltextResultsCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 * 条件はツアー間で Object.assign で合成されるので、条件名には `results-` を付けて衝突を避ける。
 */
import type { FulltextResultsCondition } from '../../../../lib/guide/tours/fulltext-results';
import { state } from '../../../state';
import { getState } from '../../../store';

/** 要素が画面にあり、`hidden` クラスが付いていない */
function isShown(element: HTMLElement | null): boolean {
    return element !== null && !element.classList.contains('hidden');
}

export function computeFulltextResultsConditions(): Record<FulltextResultsCondition, boolean> {
    const onScreening = getState().ui.view === 'screening';
    const keyOpened = state.isKeyOpened;
    // 不一致の欄は、キー開封後にだけ表示される（features/fulltext/results.ts の renderConflicts）。
    // 未解消の項目には、描画のときに data-tour="fulltext-conflict-item" が付く
    const hasUnresolved = isShown(document.getElementById('fulltext-conflicts'))
        && document.querySelector('#fulltext-conflicts-list [data-tour="fulltext-conflict-item"]') !== null;
    return {
        'results-on-fulltext-tab': onScreening && state.currentTab === 'fulltext',
        'results-shown': document.getElementById('fulltext-mode-results')?.classList.contains('active') === true,
        'results-key-opened': keyOpened,
        'results-conflict-or-key-closed': !keyOpened || hasUnresolved,
        'results-no-conflict': !hasUnresolved,
    };
}
