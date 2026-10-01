// ツアー assignment-setup（分担の設定）: 手動タブ以外（AI タブ）の「?」の一覧から始める経路。
// 最初に「手動タブを開く」手順が出て、押すと「設定を開く」手順へ進む。

import { ACTION_TIMEOUT } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

/** run.click はダイアログを先に閉じてしまうので、ウィザードの中の操作はこちらで押す。 */
async function clickKeepModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

export default defineScenario({
    name: 'assignment-setup-from-tab',
    title: 'ツアー assignment-setup（AI タブから始める）',
    defaultRun: true,
    async run(run) {
        const T = 'assignment-setup';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');

        // AI タブを開き、その画面の「?」から一覧を開いて始める
        await run.click('#tab-llm', 'start', 'AI タブ');
        await openTourList(run, 'start');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'assignment-setup の開始ボタン');

        // 手動タブを開く手順。対象のタブが見えていて、カードが重ならない
        await run.waitStep(T, 'open-manual-tab');
        await expectCardClearOfTarget(run, 'open-manual-tab', '#tab-screening', '「手動」タブ');
        await run.click('#tab-screening', 'open-manual-tab', '「手動」タブ');

        await run.waitStep(T, 'open-settings');
        await run.click('#settings-btn-screening', 'open-settings', '⚙️ ボタン');
        await run.waitStep(T, 'banner');
        await run.click('#assignment-banner-open-btn', 'banner', '「今すぐ文献を分割する」ボタン');
        await run.waitStep(T, 'wizard-numbers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-numbers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-reviewers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-reviewers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-create');
        await clickKeepModal(run, '#modal-footer .btn-outline', 'wizard-create', '「今回は分割しない」ボタン');

        // 設定画面にいるので閉じる。手動タブにいるので、手動タブへ戻る手順は出ずに完了へ
        await run.waitStep(T, 'close-settings');
        await run.click('#close-settings-btn', 'close-settings', '設定の「閉じる」ボタン');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitTourStatus(T, 'done', 'finish');
    },
});
