// ツアー assignment-setup（分担の設定）: 新規プロジェクトの取り込み直後にウィザードが自動で開く経路。
// 取り込み前にツアーを始めておくと、ウィザードが開いた時点で「設定を開く」「案内カード」の手順が飛ばされて
// ウィザードの手順から続く。最後は「今回は分割しない」を押して進む（assignment-dismissed）。

import { existsSync } from 'node:fs';
import { ACTION_TIMEOUT, NBIB_FILE } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';

/** run.click はダイアログを先に閉じてしまうので、ウィザードの中の操作はこちらで押す。 */
async function clickKeepModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

export default defineScenario({
    name: 'assignment-setup-auto',
    title: 'ツアー assignment-setup（取り込み直後の自動表示・今回は分割しない）',
    defaultRun: true,
    async run(run) {
        const T = 'assignment-setup';
        await run.openAndLogin();
        await run.click('#create-btn', 'setup', '新規作成ボタン');
        await run.waitVisible('#import-btn', 'setup', '取り込みボタン');

        // 取り込み前に、❓ の一覧からこのツアーを始める（設定画面を開く手順から）
        await run.click('[data-tour="tour-list"]:visible', 'start', '❓ ボタン');
        await run.click('.guide-popover [data-guide-action="tour-list"]', 'start', '吹き出しの「操作ツアーの一覧」ボタン');
        await run.waitVisible('#guide-tour-list', 'start', 'ツアー一覧パネル');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'assignment-setup の開始ボタン');
        await run.waitStep(T, 'open-settings');

        // 取り込むと、ウィザードが自動で開く。開く手順は飛ばされ、ウィザードの手順になる
        if (!existsSync(NBIB_FILE)) throw new Error(`取り込み用ファイルがありません: ${NBIB_FILE}`);
        await run.page.locator('#ris-file').setInputFiles(NBIB_FILE);
        await run.waitStep(T, 'wizard-numbers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-numbers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-reviewers');
        await clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', 'wizard-reviewers', 'カードの「次へ」');
        await run.waitStep(T, 'wizard-create');

        // 「今回は分割しない」で進む。手動タブにいるので、設定・担当セットの手順は出ずに完了へ
        await clickKeepModal(run, '#modal-footer .btn-outline', 'wizard-create', '「今回は分割しない」ボタン');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: assignment-setup が done（自動表示・今回は分割しない）');
    },
});
