// シーン09: Web版（インストール不要）
//
// 全3キュー。公開中の Web 版はログイン前の画面しか映せず、実アカウントを収録に
// 使わないため、ローカル配信した Web 版デモビルドでログインから判定画面まで映す。
// 最後はヘルプページで拡張版との機能差を案内する。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, DIST_WEB_DEMO_DIR } from '../scripts/config.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSequence, hoverSlow } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';
import { startStaticServer } from './lib/static-server.mjs';

const DUR = loadCueDurations('09-web-app');
const HELP_URL = pathToFileURL(path.join(REPO_ROOT, 'docs', 'help.html')).href + '?lang=ja';
/** 抄録が映っているとみなす最小の文字数（「(抄録なし)」は数文字しかない） */
const MIN_ABSTRACT_CHARS = 200;
/** 抄録のある文献を探して「次へ」を押す回数の上限 */
const MAX_NEXT_FOR_ABSTRACT = 6;

/** ヘルプへの遷移が一時的に失敗した場合に再試行する。 */
async function gotoWithRetry(page, url, attempts = 2) {
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
        if (!existsSync(path.join(DIST_WEB_DEMO_DIR, 'index.html'))) {
            throw new Error('Web 版デモビルドがありません。npm run build:web:demo を実行してください。');
        }
        const server = await startStaticServer(DIST_WEB_DEMO_DIR);
        try {
            await ctx.page.goto(server.url);
            await ctx.page.locator('#login-btn').waitFor({ state: 'visible' });
            await ctx.sleep(800);

            // ログイン画面から、レビュー専用のプロジェクト選択画面へ進む。
            const t1 = Date.now();
            ctx.cue(1);
            await ctx.sleep(DUR['01'] * 1000 * 0.4);
            await ctx.page.locator('#login-btn').click();
            await ctx.page.locator('#recent-sheets').waitFor({ state: 'visible' });
            await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

            // 判定を保存せず、ボタン・メモ・チーム進捗の位置を見せる。
            const t2 = Date.now();
            ctx.cue(2);
            await connectDemoProject(ctx.page);
            // 最初の未判定は抄録の無い文献のことがある。抄録とハイライトが映る文献まで進める。
            for (let i = 0; i < MAX_NEXT_FOR_ABSTRACT; i += 1) {
                const abstract = (await ctx.page.locator('#ref-abstract').innerText().catch(() => '')).trim();
                if (abstract.length >= MIN_ABSTRACT_CHARS) break;
                await ctx.page.locator('#btn-next').click();
                await ctx.sleep(300);
            }
            // 原稿の順（判定 → メモ → キーワードハイライト → チーム進捗）に指していく。
            await hoverSequence(
                ctx.page,
                ['#btn-include', '#btn-maybe', '#btn-exclude'].map((selector) => ctx.page.locator(selector)),
                { holdMs: 300, moveMs: 400 },
            );
            await hoverSlow(ctx.page, ctx.page.locator('#note'), { durationMs: 500 });
            await hoverSlow(ctx.page, ctx.page.locator('#include-keywords-list'), { durationMs: 500 });
            await hoverSlow(ctx.page, ctx.page.locator('#team-progress-host'), { durationMs: 500 });
            await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

            // ヘルプページの「できないこと（Chrome拡張機能版のみ）」まで表示する。
            const t3 = Date.now();
            ctx.cue(3);
            await gotoWithRetry(ctx.page, HELP_URL);
            await ctx.page.locator('#web-version').scrollIntoViewIfNeeded();
            const limitHeading = ctx.page.getByText('できないこと（Chrome拡張機能版のみの機能）', { exact: false }).first();
            await limitHeading.scrollIntoViewIfNeeded();
            await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

            await ctx.sleep(1500);
        } finally {
            await server.close();
        }
    },
};
