// ツアー ml-start（ML の開始）: ❓ の一覧から始め、ダイアログが出た状態で停止基準の手順になり、確定して進み、
// 以降を「押さずに次へ」で最後まで進む経路。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'ml-start-skip',
    title: 'ツアー ml-start（一覧から・確定してから押さずに次へ）',
    defaultRun: true,
    async run(run) {
        const T = 'ml-start';
        await run.openAndLogin('?demoProfile=ml');
        await run.connectToDemoSheet();
        await openTourList(run);
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ml-start の「始める」');

        await run.waitStep(T, 'open-tab');
        await run.click('#tab-ml', 'open-tab', 'ML タブ');

        // ダイアログが開いた状態。本文が読め、「押さずに次へ」は出ない（確定で進む手順）
        await run.waitStep(T, 'stopping-dialog');
        await expectCardClearOfTarget(run, 'stopping-dialog', '[data-tour="ml-stopping-confirm"]', 'ダイアログの「この設定で開始」');
        const skipShown = await run.page.locator('#guide-tour-card [data-guide-action="next"]').isVisible();
        if (skipShown) await run.fail('stopping-dialog', '確定で進む手順に「押さずに次へ」が出ないこと');
        await run.page.locator('[data-tour="ml-stopping-confirm"]').click({ timeout: 10000 });

        // 以降は押さずに次へ
        await run.waitStep(T, 'decide');
        await run.clickNext('decide');
        for (const step of ['learning-state', 'stopping-progress', 'stopping-reached']) {
            await run.waitStep(T, step);
            await run.clickNext(step);
        }
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
    },
});
