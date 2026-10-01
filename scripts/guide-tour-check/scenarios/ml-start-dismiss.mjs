// ツアー ml-start（ML の開始）: 停止基準の確認を確定せずに閉じても行き止まりにならない。
// 閉じる（✕）→ 開き直しの案内 → 別のタブへ移って ML タブを押し直す → 確認がまた出る → 確定して判定の手順へ。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'ml-start-dismiss',
    title: 'ツアー ml-start（確認を確定せずに閉じた場合）',
    defaultRun: true,
    async run(run) {
        const T = 'ml-start';
        await run.openAndLogin('?demoProfile=ml');
        await run.connectToDemoSheet();
        await openTourList(run);
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ml-start の「始める」');
        await run.waitStep(T, 'open-tab');
        await run.click('#tab-ml', 'open-tab', 'ML タブ');
        await run.waitStep(T, 'stopping-dialog');

        // 確定せずに閉じる（✕。run.click はモーダルを閉じる動作を含むので、直接押す）
        // 幅が狭いとカードが ✕ に重なって実際のクリックは遮られるため、要素の click() で閉じる（閉じる処理は同じ）
        await run.page.locator('#modal-close-btn').evaluate((el) => el.click());
        await run.waitStep(T, 'stopping-reopen');
        await expectCardClearOfTarget(run, 'stopping-reopen', '#tab-ml', 'ML タブ');

        // 別のタブへ移って、ML タブを押し直す → 確認がまた出る
        await run.click('#tab-screening', 'stopping-reopen', '手動タブ');
        await run.click('#tab-ml', 'stopping-reopen', 'ML タブ');
        await run.waitVisible('#modal-backdrop:not(.hidden) [data-tour="ml-stopping-confirm"]', 'stopping-reopen', 'もう一度出た確認ダイアログ');
        await run.shot('reopened');
        await run.page.locator('[data-tour="ml-stopping-confirm"]').click({ timeout: 10000 });

        await run.waitStep(T, 'decide');
    },
});
