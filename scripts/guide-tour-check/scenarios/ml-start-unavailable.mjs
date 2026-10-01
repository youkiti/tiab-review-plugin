// ツアー ml-start（ML の開始）: 文献が 1,000 件未満のプロジェクト（デモの既定データ 10 件）で始めると、
// ML タブの手順を飛ばして「使えない」と伝える手順だけを見せ、finish で終わる。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'ml-start-unavailable',
    title: 'ツアー ml-start（1,000 件未満では使えないと伝える）',
    defaultRun: true,
    async run(run) {
        const T = 'ml-start';
        await run.openAndLogin();
        await run.connectToDemoSheet();

        await openTourList(run);
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ml-start の「始める」');

        // 最初の手順は「使えない」の説明（ML タブを指す）。ほかの手順は飛ばされる
        await run.waitStep(T, 'unavailable');
        await expectCardClearOfTarget(run, 'unavailable', '#tab-ml', 'ML タブ');
        await run.clickNext('unavailable');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: ml-start が done');
    },
});
