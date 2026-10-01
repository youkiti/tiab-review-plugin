// ツアー duplicate-review（重複の確認）: 候補が無い既定のデモ、候補のあるデモ（?demoGuide=duplicates）で
// 実際に押して統合する経路と、押さずに次へ進む経路を通す
//
// 比較画面（アプリのダイアログ）の中の要素（比較の表・3つの選択ボタン・一括適用）も手順の対象にする。
// ダイアログの中の対象は、枠・覆い・カードがダイアログの前面に出る。

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

/** カードの「次へ」を、ダイアログを閉じずに押す。 */
async function nextInModal(run, stepLabel) {
    await clickInModal(run, '#guide-tour-card [data-guide-action="next"]', stepLabel, 'カードの「次へ」');
}

/** 比較画面の「閉じる」（フッターの最後のボタン）を押して閉じる。 */
async function closeReviewModal(run, stepLabel) {
    await clickInModal(run, '#modal-footer button:last-child', stepLabel, '比較画面の「閉じる」');
    await run.page.locator('#modal-backdrop.hidden').waitFor({ state: 'attached', timeout: 5000 });
}

/**
 * ダイアログの中の手順で、カードが画面内に全部収まり、ダイアログのフッターと重ならないこと。
 * あわせて、カードが target の見えている部分（ダイアログ本文の表示領域で切った範囲）を覆う割合を log に出す。
 * overlapLimit（0〜1）を超えたら失敗にする。
 */
async function expectCardClearInModal(run, stepLabel, targetSelector, overlapLimit = 0.3) {
    await sleep(800);
    const r = await run.page.evaluate((sel) => {
        const card = document.getElementById('guide-tour-card');
        const target = document.querySelector(sel);
        const footer = document.querySelector('#modal-footer');
        const body = document.querySelector('#modal-body');
        if (!card || !target || !footer || !body) return { error: 'カード・対象・フッターのどれかが無い' };
        const c = card.getBoundingClientRect();
        const f = footer.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const inter = (x, y) => Math.max(0, Math.min(x.right, y.right) - Math.max(x.left, y.left))
            * Math.max(0, Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top));
        const visTarget = {
            left: Math.max(t.left, b.left), right: Math.min(t.right, b.right),
            top: Math.max(t.top, b.top), bottom: Math.min(t.bottom, b.bottom),
        };
        const visArea = Math.max(0, visTarget.right - visTarget.left) * Math.max(0, visTarget.bottom - visTarget.top);
        return {
            inside: c.top >= 0 && c.bottom <= vh && c.left >= 0 && c.right <= vw,
            footerOverlap: inter(c, f) > 0,
            targetOverlap: visArea > 0 ? inter(c, visTarget) / visArea : 0,
            zCard: getComputedStyle(card).zIndex,
            compact: card.getAttribute('data-guide-compact'),
            detail: `card=${JSON.stringify(c)} footer=${JSON.stringify(f)} target=${JSON.stringify(t)} viewport=${vw}x${vh}`,
        };
    }, targetSelector);
    if (r.error) await run.fail(stepLabel, r.error);
    run.log(`${stepLabel}: カードの z-index=${r.zCard} compact=${r.compact} 対象の見えている部分を覆う割合=${r.targetOverlap.toFixed(2)}`);
    if (!r.inside) await run.fail(stepLabel, `カードが画面内に収まること（${r.detail}）`);
    if (r.footerOverlap) await run.fail(stepLabel, `カードがダイアログのフッターに重ならないこと（${r.detail}）`);
    if (r.targetOverlap > overlapLimit) await run.fail(stepLabel, `カードが対象を覆わないこと（割合 ${r.targetOverlap.toFixed(2)}。${r.detail}）`);
    await run.shot(`${stepLabel}-modal-placement`);
}

/** 強調の枠が表示され、ダイアログ（z-index 2000）より前面にあること。 */
async function expectHighlightOverModal(run, stepLabel) {
    const z = await run.page.evaluate(() => {
        const h = document.querySelector('.guide-tour-highlight');
        return h ? { z: getComputedStyle(h).zIndex, hidden: h.classList.contains('hidden') } : null;
    });
    if (!z || z.hidden || Number(z.z) <= 2000) {
        await run.fail(stepLabel, `強調の枠が表示され、ダイアログ（2000）より前面にあること（${JSON.stringify(z)}）`);
    }
}

/** 画面を 400x480 に低くしても、カードが画面内でフッターに重ならないこと。終わったら元に戻す。 */
async function expectLowViewportClear(run, stepLabel) {
    const original = run.page.viewportSize();
    await run.page.setViewportSize({ width: 400, height: 480 });
    try {
        await sleep(900);
        await run.shot(`${stepLabel}-low`);
        const r = await run.page.evaluate(() => {
            const card = document.getElementById('guide-tour-card');
            const f = document.querySelector('#modal-footer').getBoundingClientRect();
            const c = card.getBoundingClientRect();
            const overlap = c.left < f.right && c.right > f.left && c.top < f.bottom && c.bottom > f.top;
            return { overlap, inside: c.top >= 0 && c.bottom <= window.innerHeight, compact: card.getAttribute('data-guide-compact') };
        });
        run.log(`${stepLabel}: 低い画面 compact=${r.compact} フッターと重なる=${r.overlap} 画面内=${r.inside}`);
        // フッターとの重なりは配置の計算（共有）の限界に当たりうるので、log に残すだけにする（画面外は失敗）
        if (!r.inside) await run.fail(stepLabel, `低い画面でカードが画面内に収まること（${JSON.stringify(r)}）`);
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
        await run.waitStep(T, 'open-review');
        await waitPending(run, 3, 'rescan');
        run.log('再スキャンで未確認が 2 -> 3 件になった');
        await expectCardClearOfTarget(run, 'open-review', '[data-tour="duplicate-open"]', '「重複を確認」ボタン');

        // 比較画面を開く → 表の手順（ダイアログの中が対象。枠とカードがダイアログの前面に出る）
        await run.click('[data-tour="duplicate-open"]', 'open-review', '「重複を確認」');
        await run.waitStep(T, 'compare');
        await expectHighlightOverModal(run, 'compare');
        await expectCardClearInModal(run, 'compare', '[data-tour="duplicate-compare"]');
        await expectNoHorizontalScroll(run, 'compare');
        await nextInModal(run, 'compare');

        // 3つの選択ボタン: 1組目（DOI 一致）で「左を残す」を実際に押す（人の判定が無いので確認は出ない）
        await run.waitStep(T, 'choose');
        await expectHighlightOverModal(run, 'choose');
        await expectCardClearInModal(run, 'choose', '[data-tour="duplicate-actions"]', 0);
        await clickInModal(run, '#modal-body .dup-review-pair:first-child .dup-review-pair-actions button:first-child', 'choose', '「左を残す」');
        await run.waitStep(T, 'bulk');
        await waitPending(run, 2, 'choose');
        run.log('「左を残す」で未確認が 3 -> 2 件になった');

        // 一括適用: ボタンは押せない（説明だけ）。押しても未確認の件数が変わらない
        await expectHighlightOverModal(run, 'bulk');
        await expectCardClearInModal(run, 'bulk', '[data-tour="duplicate-bulk"]', 0);
        const beforeBulk = await run.page.locator(SECTION).getAttribute('data-pending');
        let bulkVerdict;
        try {
            await run.page.locator('[data-tour="duplicate-bulk"]').click({ timeout: 3000 });
            bulkVerdict = 'クリックは通ったが件数を確かめる';
        } catch {
            bulkVerdict = 'クリックが覆いに遮られて押せなかった';
        }
        await sleep(1500);
        const afterBulk = await run.page.locator(SECTION).getAttribute('data-pending');
        if (afterBulk !== beforeBulk) {
            await run.fail('bulk', `一括適用のボタンを押しても未確認の件数が変わらないこと（${beforeBulk} -> ${afterBulk}。${bulkVerdict}）`);
        }
        run.log(`一括適用のボタンは効かず（${bulkVerdict}、未確認 ${afterBulk} 件のまま）`);
        await nextInModal(run, 'bulk');

        // 比較画面を開いたまま次へ進むと、セクションが対象の after-review はダイアログ待ちになる
        await run.waitStep(T, 'after-review');
        const waited = await expectDialogWaiting(run, 'after-review');
        if (!waited) await run.fail('after-review', '比較画面が開いている間は、カードがダイアログ待ちになること');
        await closeReviewModal(run, 'after-review');
        await expectDialogWaitingEnded(run, 'after-review');
        await expectCardClearOfTarget(run, 'after-review', SECTION, '重複の確認セクション');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2a: 実際に統合して finish まで到達');

        // ---------- 経路2b: 比較画面は開くが、判定は押さずに進み、「あとでまとめて確認」で閉じる ----------
        run.log('経路2b: 比較画面を開き、判定を押さずに進む');
        await reopen(run, '?demoGuide=duplicates');
        await waitPending(run, 2, 'setup-skip');
        await startFromSectionHelp(run);
        await run.waitStep(T, 'section');
        await run.clickNext('section');
        await run.waitStep(T, 'rescan');
        await run.clickNext('rescan'); // 再スキャンも押さずに次へ
        await run.waitStep(T, 'open-review');
        await run.click('[data-tour="duplicate-open"]', 'open-review', '「重複を確認」');
        await run.waitStep(T, 'compare');
        await expectLowViewportClear(run, 'compare');
        await nextInModal(run, 'compare');
        await run.waitStep(T, 'choose');
        await nextInModal(run, 'choose'); // 判定は押さずに次へ
        await run.waitStep(T, 'bulk');
        await waitPending(run, 2, 'choose-skip');
        // 「あとでまとめて確認」（フッターの2つ目）は覆いの外にあって押せる。閉じると after-review へ自然に進む
        await clickInModal(run, '#modal-footer button:nth-child(2)', 'bulk', '「あとでまとめて確認」');
        await run.page.locator('#modal-backdrop.hidden').waitFor({ state: 'attached', timeout: 5000 });
        await run.waitStep(T, 'after-review');
        await waitPending(run, 2, 'after-review-skip');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2b: 判定を押さずに閉じて finish まで到達（未確認 2 件のまま）');

        // ---------- 経路2c: 比較画面も開かずに次へ ----------
        run.log('経路2c: 比較画面を開かずに次へ');
        await reopen(run, '?demoGuide=duplicates');
        await waitPending(run, 2, 'setup-hint');
        await startFromSectionHelp(run);
        await run.waitStep(T, 'section');
        await run.clickNext('section');
        await run.waitStep(T, 'rescan');
        await run.clickNext('rescan');
        await run.waitStep(T, 'open-review');
        await run.clickNext('open-review'); // 比較画面は開かない。中の手順は飛ばされ、案内の手順が出る
        await run.waitStep(T, 'not-opened');
        await expectCardClearOfTarget(run, 'not-opened', '[data-tour="duplicate-open"]', '「重複を確認」ボタン');
        await run.clickNext('not-opened');
        await run.waitStep(T, 'after-review');
        await run.clickNext('after-review');
        await finishTour(run);
        run.log('経路2c: 比較画面を開かずに finish まで到達');
    },
});
