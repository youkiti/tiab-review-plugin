// ツアー assignment-setup（分担の設定）: 実際に「セットを作成」を押して最後まで進む経路。
// デモの既定データ（10件・担当セット未設定）に接続し、設定画面 → 案内カード → ウィザード → 作成 →
// 担当者の保存 → 再シャッフル（押せない）→ 手動タブの担当セット → 完了、まで通す。
// 作成するとデモのシートに担当セットが書かれる（デモのストアはページを開き直すと元に戻る）。

import { ACTION_TIMEOUT, sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, expectTourListDone } from '../lib/checks.mjs';

/** run.click はアプリのダイアログを先に閉じてしまう（ウィザードも閉じる）ので、ダイアログの中の操作はこちらで押す。 */
async function clickKeepModal(run, selector, stepLabel, what) {
    try {
        await run.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail(stepLabel, `${what}（${selector}）を押せること`, err);
    }
}

/** カードの「次へ」（optional な手順では「押さずに次へ」）を、ダイアログを閉じずに押す。 */
function clickNextKeepModal(run, stepLabel) {
    return clickKeepModal(run, '#guide-tour-card [data-guide-action="next"]', stepLabel, 'カードの「次へ」');
}

/** カードが、指定した要素（ウィザードの入力欄・ボタンなど）のどれとも重ならないこと。要素が無い・見えないものは数えない。 */
async function expectCardClearOf(run, stepLabel, selectors) {
    await sleep(700); // 位置合わせ（400ms 間隔の補助を含む）を待つ
    const overlaps = await run.page.evaluate((list) => {
        const card = document.getElementById('guide-tour-card');
        if (!card) return ['カードが無い'];
        const c = card.getBoundingClientRect();
        const found = [];
        for (const sel of list) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top) {
                    found.push(`${sel} ${JSON.stringify(r)} card=${JSON.stringify(c)}`);
                }
            }
        }
        return found;
    }, selectors);
    if (overlaps.length > 0) {
        await run.fail(stepLabel, `カードが ${selectors.join(', ')} に重ならないこと（重なり: ${overlaps.join(' / ')}）`);
    }
    run.log(`カードは ${selectors.join(', ')} に重ならない`);
}

/** 横スクロールが出ていないこと。 */
async function expectNoHorizontalScroll(run, stepLabel) {
    const over = await run.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) await run.fail(stepLabel, `横スクロールが出ないこと（はみ出し ${over}px）`);
}

export default defineScenario({
    name: 'assignment-setup',
    title: 'ツアー assignment-setup（作成する経路）',
    defaultRun: true,
    async run(run) {
        const T = 'assignment-setup';
        await run.openAndLogin();
        await run.connectToDemoSheet('setup');

        // ❓ → 操作ツアーの一覧 → 分担の設定を始める
        await run.click('[data-tour="tour-list"]:visible', 'start', '❓ ボタン');
        await run.click('.guide-popover [data-guide-action="tour-list"]', 'start', '吹き出しの「操作ツアーの一覧」ボタン');
        await run.waitVisible('#guide-tour-list', 'start', 'ツアー一覧パネル');
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'assignment-setup の開始ボタン');

        // 設定画面を開く
        await run.waitStep(T, 'open-settings');
        await run.click('#settings-btn-screening', 'open-settings', '⚙️ ボタン');

        // 案内カード → 「今すぐ文献を分割する」
        await run.waitStep(T, 'banner');
        await expectCardClearOfTarget(run, 'banner', '#assignment-banner-open-btn', '「今すぐ文献を分割する」ボタン');
        await run.click('#assignment-banner-open-btn', 'banner', '「今すぐ文献を分割する」ボタン');

        // ウィザード: 件数とチーム数・プレビュー
        await run.waitStep(T, 'wizard-numbers');
        await expectCardClearOf(run, 'wizard-numbers', ['#assignment-calibration-size', '#assignment-group-count']);
        await expectNoHorizontalScroll(run, 'wizard-numbers');
        await run.page.locator('#assignment-calibration-size').fill('3');
        await run.page.locator('#assignment-group-count').fill('2');
        await clickNextKeepModal(run, 'wizard-numbers');

        // ウィザード: 担当者
        await run.waitStep(T, 'wizard-reviewers');
        await expectCardClearOf(run, 'wizard-reviewers', ['.assignment-group-grid input']);
        await run.page.locator('#assignment-wizard-reviewers-group-1').fill('a@example.com, b@example.com');
        await run.page.locator('#assignment-wizard-reviewers-group-2').fill('c@example.com, d@example.com');
        await clickNextKeepModal(run, 'wizard-reviewers');

        // ウィザード: 作成（実際に押す）
        await run.waitStep(T, 'wizard-create');
        await expectCardClearOfTarget(run, 'wizard-create', '#modal-footer .btn-primary', '「セットを作成」ボタン');
        await expectCardClearOf(run, 'wizard-create', ['#modal-footer button']);
        await expectNoHorizontalScroll(run, 'wizard-create');
        await clickKeepModal(run, '#modal-footer .btn-primary', 'wizard-create', '「セットを作成」ボタン');

        // 作成後は手動タブへ戻るので、もう一度設定画面を開く
        await run.waitStep(T, 'reopen-settings');
        await run.click('#settings-btn-screening', 'reopen-settings', '⚙️ ボタン');

        // 担当者の保存（実際に押す）
        await run.waitStep(T, 'save-map');
        await expectCardClearOfTarget(run, 'save-map', '#assignment-save-btn', '「担当者設定を保存」ボタン');
        await expectCardClearOf(run, 'save-map', ['#assignment-reviewer-map input']);
        const savedValue = await run.page.locator('#assignment-reviewers-group-1').inputValue();
        if (!savedValue.includes('a@example.com')) throw new Error(`作成したウィザードの担当者が設定画面に出ていません: ${savedValue}`);
        await run.click('#assignment-save-btn', 'save-map', '「担当者設定を保存」ボタン');

        // 再分割は押せない（確認ダイアログが開く＝ウィザードが開く、ということが起きない）
        await run.waitStep(T, 'reshuffle');
        await expectCardClearOfTarget(run, 'reshuffle', '#assignment-reshuffle-btn', '「再分割してやり直す」ボタン');
        try {
            await run.page.locator('#assignment-reshuffle-btn').click({ timeout: 3000 });
        } catch {
            run.log('再分割ボタンのクリックは覆いに遮られて押せなかった');
        }
        await sleep(600);
        const wizardOpened = await run.page.locator('#modal-backdrop:not(.hidden) .assignment-wizard').count();
        if (wizardOpened > 0) await run.fail('reshuffle', '再分割ボタンを押してもウィザードが開かないこと（開いてしまった）');
        run.log('再分割ボタンは押せず、ウィザードは開かなかった');
        await run.shot('reshuffle-blocked');
        await run.clickNext('reshuffle');

        // 閉じて手動タブへ → 担当セット
        await run.waitStep(T, 'close-settings');
        await run.click('#close-settings-btn', 'close-settings', '設定の「閉じる」ボタン');
        await run.waitStep(T, 'sets');
        await expectCardClearOf(run, 'sets', ['#assignment-set-list input']);
        const setCount = await run.page.locator('#assignment-set-list input[type="checkbox"]').count();
        if (setCount < 3) throw new Error(`担当セットのチェックボックスが ${setCount} 個しかありません（calibration と 2 グループで 3 個以上のはず）`);
        run.log(`担当セットのチェックボックス: ${setCount} 個`);
        await run.clickNext('sets');

        // 完了
        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: assignment-setup が done');
        await expectTourListDone(run, T);
    },
});
