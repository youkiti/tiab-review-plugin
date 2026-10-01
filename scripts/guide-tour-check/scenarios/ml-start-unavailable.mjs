// ツアー ml-start（ML の開始）: 文献が 1,000 件未満のプロジェクト（デモの既定データ 10 件）では、❓ の一覧に
// ML のツアーが出ない（ML タブが開けないので、ML 画面の「?」は確認不要）。1,100 件のデモでは出る。

import { defineScenario } from '../lib/scenario.mjs';
import { openTourList } from '../lib/checks.mjs';

const ITEM = '[data-guide-tour-item="ml-start"]';

export default defineScenario({
    name: 'ml-start-unavailable',
    title: 'ツアー ml-start（1,000 件未満では一覧に出ない）',
    defaultRun: true,
    async run(run) {
        // 10 件: 一覧に ML のツアーが無い（ほかのツアーは出ている）
        await run.openAndLogin();
        await run.connectToDemoSheet();
        await openTourList(run);
        await run.waitVisible('#guide-tour-list [data-guide-tour-item]', 'list', '一覧のほかのツアー');
        const small = await run.page.locator(`#guide-tour-list ${ITEM}`).count();
        if (small !== 0) await run.fail('list', '10 件のプロジェクトの一覧に ml-start が出ないこと');
        run.log('10 件のプロジェクトでは、一覧に ml-start が出ない');
        await run.shot('list-small');

        // 1,100 件: 一覧に出る
        await run.page.goto(run.sidepanelUrl('?demoProfile=ml'));
        // サインイン済みの状態が保存されているので、そのままプロジェクト選択画面になる
        await run.waitVisible('#project-section', 'login', 'プロジェクト選択画面');
        await run.connectToDemoSheet();
        await openTourList(run);
        await run.waitVisible(`#guide-tour-list ${ITEM}`, 'list', '1,100 件のプロジェクトの一覧の ml-start');
        run.log('1,100 件のプロジェクトでは、一覧に ml-start が出る');
        await run.shot('list-large');
    },
});
