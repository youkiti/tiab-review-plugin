// シーン03: TiAbスクリーニング（手動タブ）
//
// 全8キュー。cue2 は本来「インポートメニューを開いて閉じる」という構成だが、
// 現行UIでは #import-btn クリックが直接ネイティブのファイル選択ダイアログ
// （hidden #ris-file への click() 委譲）を開く実装になっており、メニューは
// 存在しない。ダイアログが開くと録画がフリーズする危険があるため、ここでは
// クリックせずツールバーのインポート/エクスポートボタンをゆっくりホバーする
// だけに留める（意図的なストーリーボードからの逸脱）。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, hoverSequence, smoothWheel } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('03-tiab-screening');

export default {
    id: '03',
    slug: 'tiab-screening',
    title: 'TiAbスクリーニング（手動タブ）',
    narration: '03-tiab-screening',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: 手動タブの全景（文献カードをゆっくりスクロール） ---
        const t1 = Date.now();
        ctx.cue(1);
        await smoothWheel(ctx.page, 260, { steps: 8, stepDelayMs: 110 });
        await ctx.sleep(400);
        await smoothWheel(ctx.page, -260, { steps: 8, stepDelayMs: 110 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: インポートボタンをホバー（クリックはしない。上記コメント参照） ---
        const t2 = Date.now();
        ctx.cue(2);
        await hoverSlow(ctx.page, ctx.page.locator('#import-btn'), { durationMs: 600 });
        await ctx.sleep(1200);
        await hoverSlow(ctx.page, ctx.page.locator('#export-btn'), { durationMs: 600 });
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: 判定ボタンを順にホバー→実際にIncludeで1件判定 ---
        const t3 = Date.now();
        ctx.cue(3);
        await hoverSequence(ctx.page, [
            ctx.page.locator('#btn-include'),
            ctx.page.locator('#btn-maybe'),
            ctx.page.locator('#btn-exclude'),
        ], { holdMs: 500, moveMs: 500 });
        await ctx.page.locator('#ref-title').click(); // フォーカスをキーボードショートカットが効く場所に戻す
        await ctx.page.keyboard.press('i');
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: メモに除外理由を入力してからExclude（キー 'e'）で判定 ---
        const t4 = Date.now();
        ctx.cue(4);
        await ctx.page.locator('#note').fill('症例報告のため除外');
        await ctx.page.locator('#note').blur();
        await ctx.page.keyboard.press('e');
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: ハイライト設定までスクロールし、緑（組み入れ）/赤（除外）のチップをホバー ---
        const t5 = Date.now();
        ctx.cue(5);
        await smoothWheel(ctx.page, 520, { steps: 10, stepDelayMs: 100 });
        await ctx.page.locator('#config-settings').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        const includeChips = ctx.page.locator('#include-keywords-list .keyword-tag');
        const excludeChips = ctx.page.locator('#exclude-keywords-list .keyword-tag');
        if (await includeChips.first().isVisible().catch(() => false)) {
            await hoverSlow(ctx.page, includeChips.first(), { durationMs: 500 });
            await ctx.sleep(600);
        }
        if (await excludeChips.first().isVisible().catch(() => false)) {
            await hoverSlow(ctx.page, excludeChips.first(), { durationMs: 500 });
        }
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        // --- cue 6: メモ欄に短いメモを入力し、クリックして外す ---
        const t6 = Date.now();
        ctx.cue(6);
        await ctx.page.locator('#note').click();
        await ctx.page.locator('#note').fill('図表を要確認');
        await ctx.page.locator('#ref-title').click();
        await sleepRemainder(ctx, t6, DUR['06'] * 1000 + 500);

        // --- cue 7: ステータスフィルターを切り替え（未判定→Include→すべて） ---
        const t7 = Date.now();
        ctx.cue(7);
        await smoothWheel(ctx.page, -520, { steps: 10, stepDelayMs: 80 });
        await ctx.page.locator('#status-filter').selectOption('pending');
        await ctx.sleep(1200);
        await ctx.page.locator('#status-filter').selectOption('include');
        await ctx.sleep(1200);
        await ctx.page.locator('#status-filter').selectOption('all');
        await sleepRemainder(ctx, t7, DUR['07'] * 1000 + 500);

        // --- cue 8: 進捗表示をハイライトし、先頭までスクロール ---
        const t8 = Date.now();
        ctx.cue(8);
        await hoverSlow(ctx.page, ctx.page.locator('#progress-text'), { durationMs: 600 });
        await ctx.sleep(800);
        await ctx.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
        await sleepRemainder(ctx, t8, DUR['08'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
