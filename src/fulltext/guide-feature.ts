// guide-feature.ts - 全文の判定ページのツアーの本体。遅延チャンク `fulltext-guide` に入る（入口は ./guide.ts）。
//
// ランナー・提案の帯・保存は src/guide-ui/ にあり、サイドパネルと共通。ここでは、このページの画面の状態
// （条件の計算・ダイアログ #ft-criteria-backdrop・プラットフォーム）を渡してランナーを組み立て、
// 初めて開いたときの提案の帯と、画面側のイベントの受け口を持つ。

import { platform } from '../platform';
import { dismissTour, tourToSuggestOnPage } from '../lib/guide/tour-progress';
import type { GuideEventName } from '../lib/guide/tours';
import { buildTourSuggestBand } from '../guide-ui/suggest-band';
import { createTourRunner } from '../guide-ui/tour-runner';
import { loadGuideProgress, updateGuideProgress } from '../guide-ui/tour-store';
import { computeFulltextGuideConditions } from './guide-conditions';

const BAND_ID = 'guide-page-suggest';
const TOUR_ID = 'fulltext-page';

function platformContext(): { platform: 'extension'; capabilities: { createProject: boolean } } {
    return { platform: 'extension', capabilities: { createProject: platform().capabilities.createProject } };
}

const runner = createTourRunner({
    page: 'fulltext',
    computeConditions: computeFulltextGuideConditions,
    platformContext,
    modal: { backdropId: 'ft-criteria-backdrop', contentSelector: '.ft-criteria-content', footerSelector: '.ft-criteria-footer' },
    // 幅が広いので、縦に長い対象（除外理由の欄など）は下にも上にも収まらないとき、横に置いて覆わない
    cardSideFallback: true,
});

let initialized = false;
let resumed: Promise<void> | null = null;

/** 保存済みの実行中ツアーを一度だけ再開する。イベント処理はこの完了を待つ。 */
export function resumeFulltextGuide(): Promise<void> {
    initFulltextGuide();
    if (!resumed) resumed = runner.resume();
    return resumed;
}

/** 画面側のイベントの受け口を付ける（何度呼んでも1回だけ）。 */
function initFulltextGuide(): void {
    if (initialized) return;
    initialized = true;
    document.addEventListener('tiab-guide', event => {
        const name = (event as CustomEvent<GuideEventName>).detail;
        resumeFulltextGuide()
            .then(() => runner.handleEvent(name))
            .catch(error => console.warn('[fulltext] ツアーのイベント処理に失敗:', error));
    });
}

function removeSuggestion(): void {
    document.getElementById(BAND_ID)?.remove();
}

/** このページのツアーを始める（実行中のツアーがあれば置き換える）。 */
export async function startFulltextTour(): Promise<void> {
    initFulltextGuide();
    removeSuggestion();
    await runner.start(TOUR_ID);
}

/** 初めて開いたとき、ページ上部（ヘッダーの下）に提案の帯を出す。出すかどうかは保存値で決める。 */
export async function showFulltextSuggestion(): Promise<void> {
    initFulltextGuide();
    const progress = await loadGuideProgress();
    removeSuggestion();
    const tour = tourToSuggestOnPage(progress, 'fulltext', platformContext());
    if (!tour) return;
    const header = document.querySelector('.ft-header');
    if (!header) return;
    header.after(buildTourSuggestBand({
        id: BAND_ID,
        tour,
        onDismiss: () => {
            updateGuideProgress(current => dismissTour(current, tour.id, new Date().toISOString()));
            removeSuggestion();
        },
        onStart: () => { void startFulltextTour(); },
    }));
}
