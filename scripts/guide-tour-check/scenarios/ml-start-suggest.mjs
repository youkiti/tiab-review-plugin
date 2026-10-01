// ツアー ml-start（ML の開始）: ML タブを初めて開いたときの提案の帯から始め、「押さずに次へ」だけで最後まで進む経路。
// 停止基準のダイアログと提案の帯が同時に出る間の見え方（帯がダイアログの下に隠れていないか）も撮る。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget } from '../lib/checks.mjs';

export default defineScenario({
    name: 'ml-start-suggest',
    title: 'ツアー ml-start（提案の帯から・押さずに次へ）',
    defaultRun: true,
    async run(run) {
        const T = 'ml-start';
        await run.openAndLogin('?demoProfile=ml');
        await run.connectToDemoSheet();

        // ML タブを開く。停止基準のダイアログと、提案の帯（#guide-tab-suggest）が同時に出る
        await run.click('#tab-ml', 'tab-opened', 'ML タブ');
        await run.waitVisible('#modal-backdrop:not(.hidden)', 'tab-opened', '停止基準のダイアログ');
        await run.page.locator('#guide-tab-suggest').waitFor({ state: 'attached', timeout: 10000 })
            .catch(() => run.fail('tab-opened', '#guide-tab-suggest が ML タブに付くこと'));
        const covered = await run.page.evaluate(() => {
            const band = document.getElementById('guide-tab-suggest');
            const start = band?.querySelector('[data-guide-action="start"]');
            if (!start) return 'no-start-button';
            const r = start.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return start.contains(top) ? 'visible-on-top' : `covered-by:${top?.id || top?.className || top?.tagName}`;
        });
        run.log(`ダイアログが開いている間の提案の帯の「ツアーで進める」: ${covered}`);
        await run.shot('band-with-dialog');

        // ダイアログを確定すると帯が見える
        // run.click はモーダルを閉じてしまうので、ダイアログの中のボタンは直接押す
        await run.page.locator('[data-tour="ml-stopping-confirm"]').click({ timeout: 10000 });
        await run.waitVisible('#guide-tab-suggest', 'band', '提案の帯');
        await run.shot('band');
        await run.click('#guide-tab-suggest [data-guide-action="start"]', 'band', '帯の「ツアーで進める」');

        // ML タブは開いていて、停止基準も設定済みなので、判定の手順から始まる（押さずに次へで進む）
        await run.waitStep(T, 'decide');
        await expectCardClearOfTarget(run, 'decide', '[data-tour="ml-decision-buttons"]', '判定ボタン');
        await run.clickNext('decide');
        for (const step of ['learning-state', 'stopping-progress', 'stopping-reached']) {
            await run.waitStep(T, step);
            await run.clickNext(step);
        }
        await run.waitStep(T, 'finish-ml');
        await run.clickNext('finish-ml');
        await run.waitCardGone('finish-ml');
        await run.waitTourStatus(T, 'done', 'finish-ml');
        run.log('guide_progress: ml-start が done');
    },
});
