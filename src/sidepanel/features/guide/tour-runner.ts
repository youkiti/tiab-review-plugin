/**
 * サイドパネルのツアーの実行。実体は src/guide-ui/tour-runner.ts で、ここでは
 * サイドパネルの画面の状態（条件の計算・プラットフォーム・アプリのダイアログ #modal-backdrop）を渡して組み立てる。
 * 遅延チャンク `guide-feature` に入る。
 */
import type { GuideEventName } from '../../../lib/guide/tours';
import type { GuideTourId } from '../../../lib/guide/topics';
import { createTourRunner } from '../../../guide-ui/tour-runner';
import { computeGuideConditions, currentGuidePlatform } from './tour-conditions';

const runner = createTourRunner({
    page: 'sidepanel',
    computeConditions: computeGuideConditions,
    platformContext: currentGuidePlatform,
    modal: { backdropId: 'modal-backdrop', contentSelector: '.modal-content', footerSelector: '.modal-footer' },
});

/** ツアーを始める。実行中のツアーがあれば置き換える。fromStepId を渡すとその手順から始める。 */
export function startGuideTour(tourId: GuideTourId, fromStepId?: string): Promise<void> {
    return runner.start(tourId, fromStepId);
}

/** 保存されている実行中のツアーを、パネルを開き直したあとに続きから再開する。 */
export function resumeGuideTour(): Promise<void> {
    return runner.resume();
}

/** 画面側のイベントを受ける。今の手順を進めるイベントなら次へ進む。 */
export function handleTourEvent(name: GuideEventName): void {
    runner.handleEvent(name);
}
