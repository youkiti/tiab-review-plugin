// ツアー1（first-project）: 新規作成から取り込み・判定・やり直し・Blind の説明・完了まで

import { existsSync } from 'node:fs';
import { NBIB_FILE, sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import {
    expectCardClearOfTarget,
    expectCardStaysInViewportWhileScrolling,
    expectDialogButtonClickableInLowViewport,
    expectDialogWaiting,
    expectDialogWaitingEnded,
    expectTourListDone,
    reloadAndExpectResume,
} from '../lib/checks.mjs';

/** Blind の手順: #key-section のスイッチを押しても checked が変わらない。覆いに遮られて押せない場合も合格。 */
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
    await run.shot('blind-switch-blocked');
}

export default defineScenario({
    name: 'first-project',
    title: 'ツアー1 first-project',
    defaultRun: true,
    async run(run) {
        const T = 'first-project';
        await run.openAndLogin();
        await run.startFromBanner('start-first-project');

        // 作成（prompt は dialog ハンドラが承諾する）
        await run.waitStep(T, 'project-create');
        await run.click('#create-btn', 'project-create', '新規作成ボタン');

        // 取り込み
        await run.waitStep(T, 'import');
        if (!existsSync(NBIB_FILE)) throw new Error(`取り込み用ファイルがありません: ${NBIB_FILE}`);
        await run.page.locator('#ris-file').setInputFiles(NBIB_FILE);

        await run.waitStep(T, 'read');
        const dialogShown = await expectDialogWaiting(run, 'read'); // 取り込み後のダイアログが開いている間は「ダイアログ待ち」
        if (dialogShown) await expectDialogButtonClickableInLowViewport(run, 'read');
        await run.closeModal(); // 取り込み後の確認・案内が出ていれば閉じる
        await expectDialogWaitingEnded(run, 'read');
        await expectCardClearOfTarget(run, 'read', '#ref-title', '文献のタイトル');
        await run.clickNext('read');

        // 判定 → ここで1回リロードし、同じ手順から再開することを確かめる
        await run.waitStep(T, 'decide');
        await expectCardClearOfTarget(run, 'decide', '.decision-buttons', '判定ボタン');
        await expectCardStaysInViewportWhileScrolling(run, 'decide');
        await reloadAndExpectResume(run, T, 'decide');
        await run.click('#btn-include', 'decide', '判定ボタン（Include）');

        // 前へ → 判定し直し
        await run.waitStep(T, 'go-back');
        await run.click('[data-tour="prev"]', 'go-back', '「前へ」ボタン');
        await run.waitStep(T, 'redecide');
        await run.click('#btn-exclude', 'redecide', '判定ボタン（Exclude）');

        // Blind: スイッチが押せないこと
        await run.waitStep(T, 'blind');
        await expectBlindSwitchBlocked(run);
        await run.clickNext('blind');

        // 完了
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: first-project が done');

        // プロジェクト選択画面へ戻ってもバナーが出ない
        await run.click('#back-btn', 'after-finish', '戻るボタン');
        await run.waitVisible('#project-section', 'after-finish', 'プロジェクト選択画面');
        await run.expectAbsent('#guide-suggest-banner', 'after-finish', '自動提案のバナー');
        await run.shot('project-no-banner');

        await expectTourListDone(run, T);
    },
});
