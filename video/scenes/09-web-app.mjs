// シーン09: Web版（インストール不要）
//
// 全3キュー。実際のWeb版URLへの接続をまず試み、収録環境が外部ネットワークに
// 到達できない場合はストーリーボードの指示どおり file:// のヘルプページ
// 「Web版」章にフォールバックする（実測: このコンテナのプロキシ経由では
// github.io への接続が ERR_TUNNEL_CONNECTION_FAILED になる）。
//
// 重要: 失敗したhttps:ナビゲーションの直後に file: へ goto すると、ブラウザ内部の
// エラーページ遷移処理と競合し、後続のナビゲーションが数秒〜十数秒ブロックされる
// ことを収録時に確認した。そのため接続判定・フォールバックは ctx.cue(1) を打つ
// 「前」に済ませておき、cue(1) が発声される時点では既に正しい画面
// （実際のWeb版 or フォールバックのヘルプページ）が表示された状態にする。

import { REPO_ROOT } from '../scripts/config.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { smoothWheel } from './lib/gestures.mjs';

const DUR = loadCueDurations('09-web-app');
const WEB_APP_URL = 'https://youkiti.github.io/tiab-review-plugin/app/';
const HELP_URL = `file://${REPO_ROOT}/docs/help.html?lang=ja`;

/**
 * page.goto() を数回リトライする（ネットワーク不通直後は内部状態が落ち着くまで
 * ナビゲーションが失敗/遅延することがあるための保険）。
 */
async function gotoWithRetry(page, url, attempts = 4) {
    let lastErr;
    for (let i = 0; i < attempts; i += 1) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
            return;
        } catch (err) {
            lastErr = err;
            await page.waitForTimeout(500);
        }
    }
    throw lastErr;
}

export default {
    id: '09',
    slug: 'web-app',
    title: 'Web版（インストール不要）',
    narration: '09-web-app',

    async run(ctx) {
        // --- cue 1 の前に接続を試み、必要ならフォールバックまで済ませておく ---
        let usedFallback = false;
        try {
            await ctx.page.goto(WEB_APP_URL, { timeout: 5000, waitUntil: 'domcontentloaded' });
            const bodyText = await ctx.page.locator('body').innerText({ timeout: 3000 });
            if (!bodyText || bodyText.trim().length < 20) {
                throw new Error('Web版ページが空/壊れているように見えるためフォールバックします');
            }
        } catch (err) {
            console.warn(`[09-web-app] Web版URLへの接続に失敗したためフォールバックします: ${err.message}`);
            usedFallback = true;
            await gotoWithRetry(ctx.page, HELP_URL);
            await ctx.page.locator('#web-version').scrollIntoViewIfNeeded();
        }
        await ctx.sleep(800);

        // --- cue 1: Web版のURL（またはフォールバック先）を表示 ---
        const t1 = Date.now();
        ctx.cue(1);
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 画面にとどまり、内容をスクロールして見せる ---
        const t2 = Date.now();
        ctx.cue(2);
        if (usedFallback) {
            await smoothWheel(ctx.page, 260, { steps: 8, stepDelayMs: 110 });
        } else {
            await smoothWheel(ctx.page, 260, { steps: 8, stepDelayMs: 110 });
            await ctx.sleep(600);
            await smoothWheel(ctx.page, -260, { steps: 8, stepDelayMs: 110 });
        }
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: ヘルプページの「できないこと（Chrome拡張機能版のみ）」まで表示 ---
        const t3 = Date.now();
        ctx.cue(3);
        await gotoWithRetry(ctx.page, HELP_URL);
        await ctx.page.locator('#web-version').scrollIntoViewIfNeeded();
        const limitHeading = ctx.page.getByText('できないこと（Chrome拡張機能版のみの機能）', { exact: false }).first();
        await limitHeading.scrollIntoViewIfNeeded();
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
