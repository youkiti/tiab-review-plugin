/**
 * ツアー「fulltext-setup」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/fulltext-setup.ts の FulltextSetupCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { FulltextSetupCondition } from '../../../../lib/guide/tours/fulltext-setup';
import { state } from '../../../state';
import { getState } from '../../../store';

export function computeFulltextSetupConditions(): Record<FulltextSetupCondition, boolean> {
    const onScreening = getState().ui.view === 'screening';
    // 候補カードの有無は、描画済みの DOM（features/fulltext/tab.ts が data-tour を付ける）で見る。
    // 候補一覧は表示（候補リスト/AI判定/判定後レビュー）に関わらず描画され、非表示にされるだけなので、
    // 非表示でも「候補はある」と数える（見えているかで数えると、候補があるのに「候補がありません」と案内してしまう）
    const hasCards = document.querySelector('[data-tour="fulltext-card"]') !== null;
    return {
        'on-fulltext-tab': onScreening && state.currentTab === 'fulltext',
        'on-fulltext-list': document.getElementById('fulltext-mode-list')?.classList.contains('active') === true,
        'key-opened': state.isKeyOpened,
        'key-unopened': !state.isKeyOpened,
        'has-fulltext-cards': hasCards,
        'no-fulltext-cards': !hasCards,
    };
}
