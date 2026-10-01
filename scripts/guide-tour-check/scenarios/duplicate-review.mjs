// ツアー duplicate-review（重複の確認）: 候補が無い既定のデモ、候補のあるデモ（?demoGuide=duplicates）で
// 実際に押して統合する経路と、押さずに次へ進む経路を通す
//
// 比較画面（アプリのダイアログ）の中の要素はカードの対象にしない（ダイアログの背面にカードが隠れるため）。
// 比較画面を開いている間は、ランナーの「ダイアログ待ち」の表示（open-review のあとの after-review）になる。

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import {
    expectCardClearOfTarget,
    expectDialogWaiting,
    expectDialogWaitingEnded,
    expectTourListDone,
} from '../lib/checks.mjs';

const T = 'duplicate-review';
const SECTION = '#duplicate-review-section';

/** セクションが持つ未確認件数（data-pending）が expected になるのを待つ。 */
async function waitPending(run, expected, stepLabel) {
    try {
        await run.page.waitForFunction(
            (value) => document.querySelector('#duplicate-review-section')?.dataset.pending === value,
            String(expected),
            { timeout: 10000 },
        );
    } catch (err) {
        await run.fail(stepLabel, `${SECTION} の data-pending が "${expected}" になること`, err);
    }
}

/** デモを開き直して（ログイン済みなら即プロジェクト選択画面）、デモのシートへ接続する。 */
async function reopen(run, query) {
    await run.page.goto(run.sidepanelUrl(query));
    const needLogin = await run.page.locator('#login-btn').waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
    if (needLogin) await run.click('#login-btn', 'reopen', 'ログインボタン');
    await run.waitVisible('#project-section', 'reopen', 'プロジェクト選択画面');
    await run.connectToDemoSheet('reopen');
}

/** セクションの「?」から「この画面のツアーを始める」を押す。 */
async function startFromSectionHelp(run) {
    await run.waitVisible(`${SECTION} .guide-help-btn`, 'start', 'セクションの「?」');
    // 吹き出しはスクロールで閉じるので、先にセクションを画面内へ寄せてから押す
    await run.page.locator(SECTION).scrollIntoViewIfNeeded();
    await sleep(500);
    await run.click(`${SECTION} .guide-help-btn`, 'start', 'セクションの「?」');
    await run.waitVisible('.guide-popover [data-guide-action="tour"]', 'start', '吹き出しの「この画面のツアーを始める」');
    await run.shot('help-popover');
    await run.click('.guide-popover [data-guide-action="tour"]', 'start', '吹き出しの「この画面のツアーを始める」');
}

/** 最後の finish を「完了」で閉じて、済みになったことを確かめる。 */
async function finishTour(run) {
    await run.waitStep(T, 'finish');
    await run.clickNext('finish');
    await run.waitCardGone('finish');
    await run.waitTourStatus(T, 'done', 'finish');
}

/** 横スクロールが出ていないこと（ページとモーダル）。 */
async function expectNoHorizontalScroll(run, stepLabel) {
    const overflow = await run.page.evaluate(() => {
        const doc = document.documentElement;
        const content = document.querySelector('#modal-backdrop:not(.hidden) .modal-content');
        return {
            page: doc.scrollWidth > doc.clientWidth,
            modal: content ? content.scrollWidth > content.clientWidth : false,
        };
    });
    if (overflow.page || overflow.modal) {
        await run.fail(stepLabel, `横スクロールが出ないこと（page=${overflow.page} modal=${overflow.modal}）`);
    }
}

/** 比較画面の中の要素を押す（run.click は押す前にダイアログを閉じてしまうので使わない）。 */
async function clickInModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: 10000 });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

/** 比較画面の「閉じる」（フッターの最後のボタン）を押して閉じる。 */
async function closeReviewModal(run, stepLabel) {
    await clickInModal(run, '#modal-footer button:last-child', stepLabel, '比較画面の「閉じる」');
    await run.page.locator('#modal-backdrop.hidden').waitFor({ state: 'attached', timeout: 5000 });
}

/**
 * 比較画面を開いたまま画面を低くしても、カードがフッターのボタン（一括適用・あとで・閉じる）を覆わず、
 * 「閉じる」を押せること。終わったら画面を元に戻す（比較画面は閉じる）。
 */
async function expectFooterClickableInLowViewport(run, stepLabel) {
    const original = run.page.viewportSize();
    await run.page.setViewportSize({ width: 400, height: 480 });
    try {
        await sleep(700);
        const compact = await run.page.locator('#guide-tour-card').getAttribute('data-guide-compact');
        run.log(compact === 'true' ? '低い画面: カードが小さい表示になった' : '低い画面でもカードは通常表示のまま');
        await run.shot(`${stepLabel}-modal-low`);
        await closeReviewModal(run, stepLabel);
        run.log('低い画面で、フッターの「閉じる」を押せた');
    } finally {
        if (original) await run.page.setViewportSize(original);
    }
}

export default defineScenario({
    name: 'duplicate-review',
    title: 'ツアー duplicate-review（重複の確認）',
    defaultRun: true,
    async run(run) {
        // ---------- 経路1: 既定のデモ（候補が無い） ----------
        run.log('経路1: 既定のデモ（重複候補 0 件）');
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');
        await run.waitVisible(SECTION, 'setup', '重複の確認セクション');
        await waitPending(run, 0, 'setup');
        await startFromSectionHelp(run);

        // 手動タブを開いているので open-tab は飛ばされる
        await run.waitStep(T, 'section');
        await expectCardClearOfTarget(run, 'section', SECTION, '重複の確認セクション');
        await run.clickNext('section');

        // 再スキャン: 既定のデモは候補が見つからず、候補が無いときの案内に進む
        await run.waitStep(T, 'rescan');
        await expectCardClearOfTarget(run, 'rescan', '[data-tour="duplicate-rescan"]', '「重複を再スキャン」ボタン');
        await run.click('[data-tour="duplicate-rescan"]', 'rescan', '「重複を再スキャン」');
        await run.waitStep(T, 'no-candidates');
        const pendingAfterRescan = await run.page.locator(SECTION).getAttribute('data-pending');
        run.log(`既定のデモで再スキャンした後の未確認件数: ${pendingAfterRescan}`);
        if (pendingAfterRescan !== '0') {
            await run.fail('no-candidates', `既定のデモの再スキャンで候補が見つからないこと（実際: ${pendingAfterRescan} 件）`);
        }
        await expectCardClearOfTarget(run, 'no-candidates', SECTION, '重複の確認セクション');
        await run.clickNext('no-candidates');
        // 候補が無いので、比較画面以降の手順は全部飛ばされて finish へ
        await finishTour(run);
        run.log('経路1: 候補 0 件のまま finish まで到達');
        await expectTourListDone(run, T);

        // ---------- 経路2a: 候補のあるデモで、実際に押して統合する ----------
        run.log('経路2a: 候補のあるデモ（?demoGuide=duplicates）で実際に押す');
        await reopen(run, '?demoGuide=duplicates');
        await waitPending(run, 2, 'setup-dup');
        await startFromSectionHelp(run);

        await run.waitStep(T, 'section');
        await run.clickNext('section');

        // 再スキャンで、候補に未登録の組（PMID 一致）が新しく見つかる（2 -> 3）
        await run.waitStep(T, 'rescan');
        await run.click('[data-tour="duplicate-rescan"]', 'rescan', '「重複を再スキャン」');
        await run.waitStep(T, 'compare-info');
        await waitPending(run, 3, 'rescan');
        run.log('再スキャンで未確認が 2 -> 3 件になった');
        for (const id of ['compare-info', 'choose-info', 'bulk-info']) {
            await run.waitStep(T, id);
            await expectCardClearOfTarget(run, id, '[data-tour="duplicate-open"]', '「重複を確認」ボタン');
            await run.clickNext(id);
        }

        // 比較画面を開く。開いている間は、カードがダイアログ待ちの表示になる
        await run.waitStep(T, 'open-review');
        await expectCardClearOfTarget(run, 'open-review', '[data-tour="duplicate-open"]', '「重複を確認」ボタン');
        await run.click('[data-tour="duplicate-open"]', 'open-review', '「重複を確認」');
        await run.waitStep(T, 'after-review');
        const waited = await expectDialogWaiting(run, 'after-review');
        if (!waited) await run.fail('after-review', '比較画面が開いている間は、カードがダイアログ待ちになること');
        await expectNoHorizontalScroll(run, 'after-review');

        // 1組目（DOI 一致）で「左を残す」を実際に押す（人の判定が付いていないので確認は出ない）
        await clickInModal(run, '#modal-body .dup-review-pair:first-child .dup-review-pair-actions button:first-child', 'after-review', '「左を残す」');
        await waitPending(run, 2, 'after-review');
        run.log('「左を残す」で未確認が 3 -> 2 件になった');
        await closeReviewModal(run, 'after-review');
        await expectDialogWaitingEnded(run, 'after-review');
        await expectCardClearOfTarget(run, 'after-review', SECTION, '重複の確認セクション');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2a: 実際に統合して finish まで到達');

        // ---------- 経路2b: 比較画面は開くが、判定は押さずに閉じる ----------
        run.log('経路2b: 比較画面を開き、判定を押さずに閉じる');
        await reopen(run, '?demoGuide=duplicates');
        await waitPending(run, 2, 'setup-skip');
        await startFromSectionHelp(run);
        await run.waitStep(T, 'section');
        await run.clickNext('section');
        await run.waitStep(T, 'rescan');
        await run.clickNext('rescan'); // 再スキャンも押さずに次へ
        for (const id of ['compare-info', 'choose-info', 'bulk-info']) {
            await run.waitStep(T, id);
            await run.clickNext(id);
        }
        await run.waitStep(T, 'open-review');
        await run.click('[data-tour="duplicate-open"]', 'open-review', '「重複を確認」');
        await run.waitStep(T, 'after-review');
        await expectDialogWaiting(run, 'after-review');
        await expectFooterClickableInLowViewport(run, 'after-review'); // 低い画面でフッターが押せて、閉じる
        await expectDialogWaitingEnded(run, 'after-review');
        await waitPending(run, 2, 'after-review-skip');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2b: 判定を押さずに finish まで到達（未確認 2 件のまま）');

        // ---------- 経路2c: 比較画面も開かずに次へ ----------
        run.log('経路2c: 比較画面を開かずに次へ');
        await reopen(run, '?demoGuide=duplicates');
        await waitPending(run, 2, 'setup-hint');
        await startFromSectionHelp(run);
        await run.waitStep(T, 'section');
        await run.clickNext('section');
        await run.waitStep(T, 'rescan');
        await run.clickNext('rescan');
        for (const id of ['compare-info', 'choose-info', 'bulk-info']) {
            await run.waitStep(T, id);
            await run.clickNext(id);
        }
        await run.waitStep(T, 'open-review');
        await run.clickNext('open-review'); // 比較画面は開かない
        await run.waitStep(T, 'after-review');
        await expectCardClearOfTarget(run, 'after-review', SECTION, '重複の確認セクション');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2c: 比較画面を開かずに finish まで到達');
    },
});
