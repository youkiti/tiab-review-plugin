// ツアー fulltext-results（判定後レビュー。キー開封済み・不一致あり）: 全文タブ → 判定後レビュー → 判定者 → PRISMA →
// 不一致の解消 → 未解消の項目を開く → 裁定メモを書いて実際に「組み入れで確定」を押す → エクスポート → 完了。
// ?demoGuide=fulltext-conflicts は src/demo/guide-fulltext-conflicts-fixtures.ts。

import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, expectTourListDone, openTourList } from '../lib/checks.mjs';

const T = 'fulltext-results';
const MEMO = 'ツアー検証: 全文で対象集団の条件を満たすため組み入れ';

export default defineScenario({
    name: 'fulltext-results',
    title: 'ツアー fulltext-results（キー開封済み。実際に裁定する経路）',
    defaultRun: true,
    async run(run) {
        await run.openAndLogin('?demoGuide=fulltext-conflicts');
        await run.connectToDemoSheet('setup');

        // ❓ → ツアー一覧 → このツアーを始める（手動タブにいるので、全文タブを開く手順から）
        await openTourList(run, 'start');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');

        await run.waitStep(T, 'open-tab');
        await run.click('[data-tour="tab-fulltext"]', 'open-tab', '全文タブのボタン');

        await run.waitStep(T, 'open-results');
        await expectCardClearOfTarget(run, 'open-results', '#fulltext-mode-results', '「判定後レビュー」のボタン');
        await run.click('#fulltext-mode-results', 'open-results', '「判定後レビュー」のボタン');

        await run.waitStep(T, 'judges');
        await expectCardClearOfTarget(run, 'judges', '.fulltext-results-judges', '判定者の選択');
        await run.clickNext('judges');

        await run.waitStep(T, 'prisma');
        await expectCardClearOfTarget(run, 'prisma', '#fulltext-prisma', 'PRISMA の集計');
        const prismaText = await run.page.locator('#fulltext-prisma').innerText();
        if (!/未解消の不一致|Unresolved/.test(prismaText)) {
            await run.fail('prisma', `PRISMA の集計に未解消の不一致の件数が出ていること（実際: ${prismaText.replace(/\s+/g, ' ').slice(0, 120)}）`);
        }
        await run.clickNext('prisma');

        // キー開封済み・不一致ありなので、key-closed と no-conflict は飛ばされる
        await run.waitStep(T, 'conflicts');
        await expectCardClearOfTarget(run, 'conflicts', '#fulltext-conflicts-summary', '不一致の解消の要約');
        const itemCount = await run.page.locator('[data-tour="fulltext-conflict-item"]').count();
        if (itemCount !== 2) await run.fail('conflicts', `未解消の不一致が2件（判定不一致・理由不一致）出ていること（実際: ${itemCount}件）`);
        await run.clickNext('conflicts');

        // 未解消の項目を1つ開く（開かないと次の手順へ進まない）
        await run.waitStep(T, 'open-item');
        await run.click('[data-tour="fulltext-conflict-item"] summary', 'open-item', '未解消の項目');

        // 裁定: 裁定メモを書いてから、実際に「組み入れで確定」を押す
        await run.waitStep(T, 'adjudicate');
        await run.page.locator('[data-tour="fulltext-adjudication"] .fulltext-conflict-memo-input').first().fill(MEMO);
        await run.shot('adjudicate-memo-filled');
        await run.click('[data-tour="fulltext-adjudication"] .btn-include', 'adjudicate', '「組み入れで確定」');

        // 保存後、裁定済みの項目に「裁定メモ」が表示される（項目は再描画で閉じているので、文字は DOM から読む）
        await run.waitStep(T, 'export');
        try {
            await run.page.waitForFunction((memo) => {
                const el = document.querySelector('#fulltext-conflicts-list .fulltext-conflict-adjudicated-memo');
                return el !== null && (el.textContent || '').includes(memo);
            }, MEMO, { timeout: 10000 });
        } catch (err) {
            await run.fail('adjudicate', '保存後に、裁定済みの項目へ「裁定メモ」と入力した文が表示されること', err);
        }
        run.log('保存後に「裁定メモ」の表示を確認');
        await expectCardClearOfTarget(run, 'export', '.fulltext-results-export', 'エクスポートのボタン');
        await run.clickNext('export');

        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: fulltext-results が done');
        await expectTourListDone(run, T);
    },
});
