// ツアー resolve-conflicts（キー開封済み・不一致あり）: 全部「押さずに次へ」で最後まで進む経路。
// 不一致でない文献を表示したまま進むので、no-conflict の手順が出て、others は飛ばされる。

import { defineScenario } from '../lib/scenario.mjs';
import { openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'resolve-conflicts-skip',
    title: 'ツアー resolve-conflicts（押さずに次へ）',
    defaultRun: true,
    async run(run) {
        const T = 'resolve-conflicts';
        await run.openAndLogin('?demoGuide=conflicts');
        await run.connectToDemoSheet('setup');
        await openTourList(run, 'start');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');

        await run.waitStep(T, 'blind');
        await run.clickNext('blind');
        await run.waitStep(T, 'filter');
        await run.clickNext('filter'); // 「押さずに次へ」
        await run.waitStep(T, 'no-conflict'); // 不一致でない文献のまま
        await run.clickNext('no-conflict');
        // others は飛ばされて consensus へ
        await run.waitStep(T, 'consensus');
        await run.clickNext('consensus');
        await run.waitStep(T, 'redecide');
        await run.clickNext('redecide');
        await run.waitStep(T, 'finish');
        const consensusOn = await run.page.locator('#consensus-mode-checkbox').isChecked();
        if (consensusOn) await run.fail('finish', '押さずに進んだので合議モードがオフのままであること');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: resolve-conflicts が done（押さずに次へ）');
    },
});
