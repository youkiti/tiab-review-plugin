// 複数のシナリオで使う確認（配置・ダイアログ待ち・再開・ツアー一覧）。いずれも失敗したら run.fail で例外にする。

import { ACTION_TIMEOUT, sleep } from './constants.mjs';

/** ❓ の吹き出しの「操作ツアーの一覧」からツアー一覧を開く（表示中の ❓ は画面ごとに1つ）。 */
export async function openTourList(run, stepLabel = 'tour-list') {
    await run.click('[data-tour="tour-list"]:visible', stepLabel, '❓ ボタン');
    await run.waitVisible('.guide-popover [data-guide-action="tour-list"]', stepLabel, '吹き出しの「操作ツアーの一覧」ボタン');
    await run.shot('tour-list-popover');
    await run.click('.guide-popover [data-guide-action="tour-list"]', stepLabel, '吹き出しの「操作ツアーの一覧」ボタン');
    await run.waitVisible('#guide-tour-list', stepLabel, 'ツアー一覧パネル');
}

/** ❓ の吹き出しの「操作ツアーの一覧」からツアー一覧を開き、tourId の行が済みになっていることを確かめて閉じる。 */
export async function expectTourListDone(run, tourId) {
    await openTourList(run);
    try {
        await run.page.locator(`[data-guide-tour-item="${tourId}"][data-guide-done="true"]`).waitFor({ state: 'attached', timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail('tour-list', `一覧の ${tourId} の行に data-guide-done="true" が付くこと`, err);
    }
    await run.shot('tour-list-done');
    await run.click('#guide-tour-list [data-guide-action="close-list"]', 'tour-list', '一覧を閉じるボタン');
}

/**
 * 取り込み後に開くダイアログ（担当セットの作成など）の間は、カードが data-guide-waiting-reason="modal" で出て
 * 「次へ」が隠れていること。ダイアログが出なかったときは、その旨をログに出して先へ進む（失敗にしない）。
 */
export async function expectDialogWaiting(run, stepLabel) {
    const opened = await run.page.locator('#modal-backdrop:not(.hidden)')
        .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    if (!opened) {
        run.log('取り込み後にダイアログは開かなかったため、ダイアログ待ちの確認を省略');
        return false;
    }
    try {
        await run.page.waitForFunction(() => {
            const card = document.getElementById('guide-tour-card');
            if (!card) return false;
            const next = card.querySelector('[data-guide-action="next"]');
            return card.getAttribute('data-guide-waiting-reason') === 'modal'
                && card.getAttribute('data-guide-waiting') === 'true'
                && next !== null && getComputedStyle(next).display === 'none';
        }, null, { timeout: 5000 });
    } catch (err) {
        await run.fail(stepLabel, 'ダイアログが開いている間、カードが data-guide-waiting-reason="modal" で「次へ」が隠れていること', err);
    }
    await sleep(300);
    await run.shot(`${stepLabel}-modal`);
    run.log('ダイアログ待ちの表示を確認');
    return true;
}

/**
 * 画面が低くてカードがダイアログの上下に収まらないときは、カードが小さい表示（data-guide-compact）になり、
 * ダイアログのフッターのボタンを実際に押せること。確認のため画面を一時的に低くし、終わったら元に戻す
 * （この確認でダイアログは閉じる）。
 */
export async function expectDialogButtonClickableInLowViewport(run, stepLabel) {
    const original = run.page.viewportSize();
    await run.page.setViewportSize({ width: 400, height: 480 });
    try {
        const compact = await run.page.waitForFunction(
            () => document.getElementById('guide-tour-card')?.getAttribute('data-guide-compact') === 'true',
            null, { timeout: 4000 },
        ).then(() => true, () => false);
        run.log(compact ? '低い画面: カードが小さい表示になった' : '低い画面でもカードは通常表示のまま（ダイアログの上下に収まった）');
        await sleep(300);
        await run.shot(`${stepLabel}-modal-low`);
        try {
            await run.page.locator('#modal-footer button').first().click({ timeout: 3000 });
        } catch (err) {
            await run.fail(stepLabel, '低い画面で、ダイアログのフッターのボタンがカードに覆われず押せること', err);
        }
        await run.page.locator('#modal-backdrop.hidden').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
        run.log('低い画面でダイアログのボタンを押せた');
    } finally {
        if (original) await run.page.setViewportSize(original);
    }
}

/**
 * 手順に入った直後の、カードと文献カードの位置関係を確かめる。
 * read: 文献カードのタイトル（#ref-title）が画面内に見え、カードがタイトルと重ならない。
 * decide: 判定ボタン（.decision-buttons）が画面内に見え、カードが判定ボタンと重ならない。
 */
export async function expectCardClearOfTarget(run, stepLabel, selector, what) {
    await sleep(700); // スクロールと位置合わせ（400ms 間隔の補助を含む）を待つ
    const check = await run.page.evaluate((sel) => {
        const card = document.getElementById('guide-tour-card');
        const el = document.querySelector(sel);
        if (!card || !el) return { ok: false, reason: 'カードまたは対象の要素が無い' };
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const c = card.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const visible = r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw && r.height > 0;
        const overlap = c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top;
        return {
            ok: visible && !overlap,
            reason: `${visible ? '' : '対象が画面内に見えない '}${overlap ? 'カードが対象に重なっている ' : ''}` +
                `card=${JSON.stringify(c)} target=${JSON.stringify(r)} viewport=${vw}x${vh}`,
        };
    }, selector);
    if (!check.ok) {
        await run.fail(stepLabel, `${what}（${selector}）が画面内に見え、カードが重ならないこと（${check.reason}）`);
    }
    run.log(`${what}が画面内に見え、カードと重ならないことを確認`);
    await run.shot(`${stepLabel}-placement`);
}

/** ページをスクロールしても、カードと「ツアーを終える」ボタンが常に画面内にあること。 */
export async function expectCardStaysInViewportWhileScrolling(run, stepLabel) {
    for (const y of [0, 600, 2000, 100000, 0]) {
        await run.page.evaluate((top) => window.scrollTo(0, top), y);
        await sleep(700); // 位置合わせ（400ms 間隔の補助を含む）を待つ
        const check = await run.page.evaluate(() => {
            const card = document.getElementById('guide-tour-card');
            const end = card?.querySelector('[data-guide-action="end"]');
            if (!card || !end) return { ok: false, reason: 'カードまたは「ツアーを終える」が無い' };
            const vw = document.documentElement.clientWidth;
            const vh = window.innerHeight;
            const inside = (r) => r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
            const c = card.getBoundingClientRect();
            const e = end.getBoundingClientRect();
            return { ok: inside(c) && inside(e), reason: `card=${JSON.stringify(c)} viewport=${vw}x${vh}` };
        });
        if (!check.ok) {
            await run.shot(`${stepLabel}-scroll-${y}`);
            await run.fail(stepLabel, `スクロール位置 ${y} でカードと「ツアーを終える」が画面内にあること（${check.reason}）`);
        }
    }
    await run.shot(`${stepLabel}-scrolled`);
    run.log('スクロールしてもカードが画面内にあることを確認');
}

/** ダイアログを閉じたあと、カードが通常の表示（待機の印なし・「次へ」あり）に戻ること。 */
export async function expectDialogWaitingEnded(run, stepLabel) {
    try {
        await run.page.waitForFunction(() => {
            const card = document.getElementById('guide-tour-card');
            if (!card) return false;
            const next = card.querySelector('[data-guide-action="next"]');
            return card.getAttribute('data-guide-waiting-reason') === null
                && card.getAttribute('data-guide-waiting') === null
                && next !== null && getComputedStyle(next).display !== 'none';
        }, null, { timeout: 5000 });
    } catch (err) {
        await run.fail(stepLabel, 'ダイアログを閉じると、カードが通常の表示（待機の印なし・「次へ」あり）に戻ること', err);
    }
}

/** ページを再読み込みし、同じ手順（stepId）のカードから再開することを確かめる。 */
export async function reloadAndExpectResume(run, tourId, stepId) {
    run.log(`手順 ${stepId} でページを再読み込みします`);
    await run.page.reload();
    // 再読み込み後にプロジェクト選択画面へ戻る実装なら、最近のシートから入り直す（ベストエフォート）
    const onScreening = await run.page.locator('#btn-include').waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
    if (!onScreening) {
        const hasRecent = await run.page.locator('#recent-sheets option').count().catch(() => 0);
        if (hasRecent > 1) {
            run.log('再読み込み後にプロジェクト選択画面へ戻ったため、#recent-sheets の index 1 で接続し直します');
            await run.page.locator('#recent-sheets').selectOption({ index: 1 });
        }
    }
    await run.waitStep(tourId, stepId);
    run.log(`再読み込み後も手順 ${stepId} から再開しました`);
}
