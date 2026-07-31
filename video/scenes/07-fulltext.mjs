// シーン07: フルテキストスクリーニング
//
// 全7キュー。cue4 で候補カードをクリックすると新規タブ（fulltext.html）が開くため、
// ctx.newSegment() で録画対象をそのタブへ切り替える。cue7 では、そのタブを
// そのままサイドパネルへ goto しなおして「判定後レビュー」ビューを見せる
// （ストーリーボード指定どおり）。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, hoverSequence, smoothWheel } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('07-fulltext');

export default {
    id: '07',
    slug: 'fulltext',
    title: 'フルテキストスクリーニング',
    narration: '07-fulltext',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: 全文タブを開き、候補リストを表示 ---
        const t1 = Date.now();
        ctx.cue(1);
        await hoverSlow(ctx.page, ctx.page.locator('#tab-fulltext'), { durationMs: 500 });
        await ctx.page.locator('#tab-fulltext').click();
        await ctx.page.locator('.fulltext-card').first().waitFor({ state: 'visible', timeout: 10000 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 候補リストの取得状況（ステータスバッジ）をハイライト ---
        const t2 = Date.now();
        ctx.cue(2);
        const badges = ctx.page.locator('.fulltext-card-status');
        await hoverSequence(ctx.page, [badges.nth(0), badges.nth(1)], { holdMs: 900, moveMs: 500 });
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: 「フリー全文を一括検索」ボタンをハイライト（クリックしない） ---
        const t3 = Date.now();
        ctx.cue(3);
        await hoverSlow(ctx.page, ctx.page.locator('#fulltext-fetch-btn'), { durationMs: 600 });
        await ctx.sleep(1200);
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: 候補カードをクリック→新規タブでフルテキストページが開く ---
        const t4 = Date.now();
        ctx.cue(4);
        const [ftPage] = await Promise.all([
            ctx.page.context().waitForEvent('page'),
            ctx.page.locator('.fulltext-card').first().click(),
        ]);
        await ftPage.waitForLoadState('domcontentloaded');
        ctx.newSegment(ftPage);
        await ctx.page.locator('#ft-pdf-canvas-container').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: PDFをスクロールし、Include/Exclude/Maybeをホバー ---
        const t5 = Date.now();
        ctx.cue(5);
        await smoothWheel(ctx.page, 260, { steps: 8, stepDelayMs: 100 });
        await hoverSequence(ctx.page, [
            ctx.page.locator('#ft-btn-include'),
            ctx.page.locator('#ft-btn-maybe'),
            ctx.page.locator('#ft-btn-exclude'),
        ], { holdMs: 500, moveMs: 400 });
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        // --- cue 6: Excludeを選び、理由（PICO等）を選択して保存 ---
        // 除外理由の確定は「クリックで選ぶと保存して次へ進む」という特殊な挙動
        // （src/fulltext/fulltext.ts の pointerdown/pointerup 判定）なので、
        // Playwright の selectOption() ではなく <option> への実クリックを使う
        // （selectOption だと change イベントのみで「次へ」まで進まない）。
        const t6 = Date.now();
        ctx.cue(6);
        await ctx.page.locator('#ft-btn-exclude').click();
        await ctx.page.locator('#ft-reason-area').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await ctx.sleep(600);
        await ctx.page.locator('#ft-reason-select option').first().click();
        await sleepRemainder(ctx, t6, DUR['06'] * 1000 + 500);

        // --- cue 7: 同じタブでサイドパネルへ→再接続→全文タブ→判定後レビュー ---
        const t7 = Date.now();
        ctx.cue(7);
        await ctx.page.goto(`chrome-extension://${ctx.extId}/sidepanel/sidepanel.html`);
        await connectDemoProject(ctx.page);
        await ctx.page.locator('#tab-fulltext').click();
        await ctx.page.locator('.fulltext-card').first().waitFor({ state: 'visible', timeout: 10000 });
        await ctx.page.locator('#fulltext-mode-results').click();
        await ctx.page.locator('#fulltext-prisma').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('#fulltext-prisma'), { durationMs: 500 });
        await ctx.sleep(800);
        await hoverSlow(ctx.page, ctx.page.locator('#fulltext-export-csv-btn'), { durationMs: 500 });
        await sleepRemainder(ctx, t7, DUR['07'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
