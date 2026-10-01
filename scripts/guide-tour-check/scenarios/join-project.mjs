// ツアー2（join-project）: URL の貼り付け・接続・Picker の許可（?demoPickerRequired=1）・読む・判定・完了まで

import { DEMO_SHEET_URL, POLL_STEP_TIMEOUT } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget } from '../lib/checks.mjs';

export default defineScenario({
    name: 'join-project',
    title: 'ツアー2 join-project',
    defaultRun: true,
    async run(run) {
        const T = 'join-project';
        await run.openAndLogin('?demoPickerRequired=1');
        await run.startFromBanner('start-join-project');

        // URL 欄に貼り付け
        await run.waitStep(T, 'paste-url');
        await run.page.locator('#spreadsheet-input').fill(DEMO_SHEET_URL);

        // 接続（Picker の許可が要るので、案内が出る）
        await run.waitStep(T, 'connect');
        await run.click('#connect-btn', 'connect', '接続ボタン');

        // 許可
        await run.waitStep(T, 'allow');
        await run.click('[data-tour="picker-open"]', 'allow', 'Picker 案内の「Googleで許可する」ボタン');

        // 3秒ごとのポーリングで自動的に接続し直す。担当の手順は出ても飛ばされてもよい。
        const reached = await run.waitStep(T, ['assignment', 'read'], POLL_STEP_TIMEOUT);
        if (reached === 'assignment') {
            run.log('assignment の手順が出ました（「次へ」で進めます）');
            await run.clickNext('assignment');
            await run.waitStep(T, 'read');
        } else {
            run.log('assignment の手順は飛ばされました（担当セットが無い）');
        }

        // 読む → 「次へ」で判定へ
        await expectCardClearOfTarget(run, 'read', '#ref-title', '文献のタイトル');
        await run.clickNext('read');
        await run.waitStep(T, 'decide');
        await expectCardClearOfTarget(run, 'decide', '.decision-buttons', '判定ボタン');

        await run.click('#btn-include', 'decide', '判定ボタン（Include）');

        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: join-project が done');
    },
});
