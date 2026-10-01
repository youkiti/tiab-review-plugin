// ツアー assignment-setup（分担の設定）: AI タブから始め、AI タブの ⚙️ で設定を開いて進める経路。
// 設定を開くと「手動タブを開く」「設定を開く」は飛ばされ、閉じたあとは AI タブへ戻るので、
// 「手動タブを開く」手順（back-to-manual-tab）が出る。

import { ACTION_TIMEOUT } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

async function clickKeepModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

export default defineScenario({
    name: 'assignment-setup-from-ai-settings',
    title: 'ツアー assignment-setup（AI タブの設定から進める）',
    defaultRun: true,
    async run(run) {
        const T = 'assignment-setup';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');
        await run.click('#tab-llm', 'start', 'AI タブ');
        await openTourList(run, 'start');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'assignment-setup の開始ボタン');
        await run.waitStep(T, 'open-manual-tab');

        // 手動タブを開かず、AI タブの ⚙️ から設定を開く → 案内カードの手順へ
        await run.click('#llm-settings-btn', 'open-manual-tab', 'AI タブの ⚙️ ボタン');
        await run.waitStep(T, 'banner');
        await run.click('#assignment-banner-open-btn', 'banner', '「今すぐ文献を分割する」ボタン');
        await run.waitStep(T, 'wizard-numbers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-numbers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-reviewers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-reviewers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-create');
        await clickKeepModal(run, '#modal-footer .btn-outline', 'wizard-create', '「今回は分割しない」ボタン');

        // 設定を閉じると AI タブに戻る。手動タブを開く手順が出る
        await run.waitStep(T, 'close-settings');
        await run.click('#close-settings-btn', 'close-settings', '設定の「閉じる」ボタン');
        await run.waitStep(T, 'back-to-manual-tab');
        await expectCardClearOfTarget(run, 'back-to-manual-tab', '#tab-screening', '「手動」タブ');
        await run.click('#tab-screening', 'back-to-manual-tab', '「手動」タブ');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitTourStatus(T, 'done', 'finish');
    },
});
