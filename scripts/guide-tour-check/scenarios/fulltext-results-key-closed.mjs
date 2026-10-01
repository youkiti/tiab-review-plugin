// ツアー fulltext-results（既定のデモ = キー未開封）: 判定者 → PRISMA → 「開封したらもう一度」の案内 → エクスポート → 完了。
// 何も見えないまま終わらず、key-closed の手順が出て、不一致の手順（conflicts 以降の裁定）は出ない。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'fulltext-results-key-closed',
    title: 'ツアー fulltext-results（キー未開封）',
    defaultRun: true,
    async run(run) {
        const T = 'fulltext-results';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');

        // 全文タブで判定後レビューを表示してから始める（open-tab・open-results は飛ばされる）
        await run.click('#tab-fulltext', 'setup', '全文タブ');
        await run.click('#fulltext-mode-results', 'setup', '「判定後レビュー」のボタン');
        await run.waitVisible('#fulltext-results', 'setup', '判定後レビューの表示');
        await openTourList(run, 'start');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');

        await run.waitStep(T, 'judges');
        await run.clickNext('judges');
        await run.waitStep(T, 'prisma');
        await run.clickNext('prisma');
        await run.waitStep(T, 'key-closed');
        await expectCardClearOfTarget(run, 'key-closed', '#fulltext-prisma', 'PRISMA の集計');
        await run.clickNext('key-closed');
        // no-conflict・conflicts・open-item・adjudicate は飛ばされて export へ
        await run.waitStep(T, 'export');
        await run.clickNext('export');
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: fulltext-results が done（キー未開封）');
    },
});
