// ツアー assignment-setup（分担の設定）: 「セットを作成」を押さず、「押さずに次へ」だけで最後まで進む経路。
// 作成しなかったので、担当者の保存・再シャッフルの手順は飛ばされ、担当セットの手順も飛ばされて完了する。

import { ACTION_TIMEOUT } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectDialogWaiting } from '../lib/checks.mjs';

/** run.click はアプリのダイアログを先に閉じてしまう（ウィザードも閉じる）ので、ダイアログの中の操作はこちらで押す。 */
async function clickKeepModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

/** カードの「次へ」（optional な手順では「押さずに次へ」）を、ダイアログを閉じずに押す。 */
function clickNextKeepModal(run, stepLabel) {
    return clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', stepLabel, 'カードの「次へ」');
}

export default defineScenario({
    name: 'assignment-setup-skip',
    title: 'ツアー assignment-setup（押さずに次へ進む経路）',
    defaultRun: true,
    async run(run) {
        const T = 'assignment-setup';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');

        await run.click('[data-tour="tour-list"]:visible', 'start', '❓ ボタン');
        await run.click('.guide-popover [data-guide-action="tour-list"]', 'start', '吹き出しの「操作ツアーの一覧」ボタン');
        await run.waitVisible('#guide-tour-list', 'start', 'ツアー一覧パネル');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'assignment-setup の開始ボタン');

        await run.waitStep(T, 'open-settings');
        await run.click('#settings-btn-screening', 'open-settings', '⚙️ ボタン');
        await run.waitStep(T, 'banner');
        await run.click('#assignment-banner-open-btn', 'banner', '「今すぐ文献を分割する」ボタン');
        await run.waitStep(T, 'wizard-numbers');
        await clickNextKeepModal(run, 'wizard-numbers');
        await run.waitStep(T, 'wizard-reviewers');
        await clickNextKeepModal(run, 'wizard-reviewers');

        // 作成を押さずに次へ。ウィザードが開いたままなので、次の手順（設定画面を閉じる）はダイアログ待ちになる
        await run.waitStep(T, 'wizard-create');
        await clickNextKeepModal(run, 'wizard-create');
        await run.waitStep(T, 'close-settings');
        await expectDialogWaiting(run, 'close-settings');
        await run.closeModal();
        // この手順は「閉じる」を押して進む手順（「次へ」は無い）なので、待機の印が消えたことだけを見る
        await run.page.waitForFunction(() => {
            const card = document.getElementById('guide-tour-card');
            return card !== null && card.getAttribute('data-guide-waiting') === null;
        }, null, { timeout: 5000 });

        // 作成していないので、保存・再シャッフル・担当セットの手順は出ない
        const status = await run.page.evaluate(() => document.getElementById('assignment-settings-status')?.textContent ?? '');
        if (status.trim() !== '') throw new Error(`作成していないのに担当セットの状態が出ています: ${status}`);
        await run.click('#close-settings-btn', 'close-settings', '設定の「閉じる」ボタン');

        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: assignment-setup が done（作成せず）');
    },
});
