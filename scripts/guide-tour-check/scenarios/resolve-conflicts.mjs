// ツアー resolve-conflicts（キー開封済み・不一致あり）: Blind の説明（押せない）→ 不一致フィルター → 他の人の判定 →
// 合議モード → 判定し直し（実際に押して進む経路）→ 完了。?demoGuide=conflicts は src/demo/guide-conflicts-fixtures.ts。

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, expectTourListDone, openTourList } from '../lib/checks.mjs';

/** Blind の手順: スイッチを押しても checked が変わらない（覆いに遮られて押せない場合も合格）。 */
async function expectBlindSwitchBlocked(run) {
    await run.waitVisible('#key-section', 'blind', 'Blind のスイッチ領域');
    const readChecked = () => run.page.locator('#key-toggle-input').isChecked();
    const before = await readChecked();
    let verdict;
    try {
        await run.page.locator('#key-section .slider').click({ timeout: 3000 });
        verdict = 'クリックは通ったが状態を確かめる';
    } catch {
        verdict = 'クリックが覆いに遮られて押せなかった';
    }
    await sleep(500);
    const after = await readChecked();
    if (after !== before) {
        await run.fail('blind', `Blind のスイッチの checked が変わらないこと（${before} -> ${after}。${verdict}）`);
    }
    run.log(`Blind のスイッチは変わらず（${verdict}、checked=${after}）`);
}

export default defineScenario({
    name: 'resolve-conflicts',
    title: 'ツアー resolve-conflicts（キー開封済み。実際に押す経路）',
    defaultRun: true,
    async run(run) {
        const T = 'resolve-conflicts';
        await run.openAndLogin('?demoGuide=conflicts');
        await run.connectToDemoSheet('setup');
        await run.waitVisible('#key-section', 'setup', 'Blind のスイッチ領域（管理者）');
        if (!(await run.page.locator('#key-toggle-input').isChecked())) {
            await run.fail('setup', '?demoGuide=conflicts でキー開封済みになっていること');
        }

        // ❓ → ツアー一覧 → このツアーを始める
        await openTourList(run, 'start');
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', '一覧のこのツアーの開始ボタン');

        // Blind の説明: 押せない
        await run.waitStep(T, 'blind');
        await expectCardClearOfTarget(run, 'blind', '#key-section', 'Blind のスイッチ行');
        await expectBlindSwitchBlocked(run);
        await run.clickNext('blind');

        // 開封済みなので key-closed は飛ばされ、フィルターへ
        await run.waitStep(T, 'filter');
        await run.page.locator('#status-filter').selectOption('conflict');

        // 不一致の文献が出て、他の人の判定の一覧がある
        await run.waitStep(T, 'others');
        await expectCardClearOfTarget(run, 'others', '#all-decisions', '全レビュアーの判定の一覧');
        if (!(await run.page.locator('#conflict-banner').isVisible())) {
            await run.fail('others', '不一致の警告バナーが見えていること');
        }
        await run.clickNext('others');

        // 合議モード: 実際にオンにする
        await run.waitStep(T, 'consensus');
        await expectCardClearOfTarget(run, 'consensus', '#consensus-mode-container', '合議モードのスイッチ');
        await run.page.locator('#consensus-mode-checkbox').check();

        // 判定し直し: 実際に押す
        await run.waitStep(T, 'redecide');
        await expectCardClearOfTarget(run, 'redecide', '.decision-buttons', '判定ボタン');
        await run.click('#btn-include', 'redecide', '判定ボタン（Include）');

        await run.waitStep(T, 'finish');
        // 後片づけ: 合議モードを戻す（オフに戻せること）
        await run.page.locator('#consensus-mode-checkbox').uncheck();
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: resolve-conflicts が done');
        await expectTourListDone(run, T);
    },
});
