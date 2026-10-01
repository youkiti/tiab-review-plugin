// ツアー resolve-conflicts（既定のデモ = キー未開封）: Blind の説明 → 「開封したらもう一度」の案内 → 完了。
// 何も見えないまま終わらず、key-closed の手順が出て、不一致の手順（filter 以降）は出ない。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'resolve-conflicts-blind',
    title: 'ツアー resolve-conflicts（キー未開封）',
    defaultRun: true,
    async run(run) {
        const T = 'resolve-conflicts';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');
        await openTourList(run, 'start');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');

        await run.waitStep(T, 'blind');
        await run.clickNext('blind');
        await run.waitStep(T, 'key-closed');
        await expectCardClearOfTarget(run, 'key-closed', '#status-filter', 'ステータスフィルター');
        await run.clickNext('key-closed');
        // filter 以降は飛ばされて finish へ
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: resolve-conflicts が done（キー未開封）');
    },
});
