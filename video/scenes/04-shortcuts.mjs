// シーン04: キーボードショートカット
//
// 全3キュー。判定キー（i/m）と移動キー（矢印）だけでテンポよく操作する様子を見せる。
// 'e'（Exclude）は手動タブでは理由入力欄（メモ欄）へのフォーカス誘導が入り、
// リズムが崩れるためこのシーンでは使わない（ストーリーボードの指示どおり）。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('04-shortcuts');

export default {
    id: '04',
    slug: 'shortcuts',
    title: 'キーボードショートカット',
    narration: '04-shortcuts',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        // キーボードショートカットが確実に効くよう、入力欄以外にフォーカスを置く
        await ctx.page.locator('#ref-title').click();
        await ctx.sleep(800);

        // --- cue 1: iキーでInclude ---
        const t1 = Date.now();
        ctx.cue(1);
        await ctx.page.keyboard.press('i');
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 矢印キーで前後の文献に移動 ---
        const t2 = Date.now();
        ctx.cue(2);
        await ctx.page.keyboard.press('ArrowRight');
        await ctx.sleep(900);
        await ctx.page.keyboard.press('ArrowLeft');
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: i / m / 矢印キーをテンポよく連続操作 ---
        const t3 = Date.now();
        ctx.cue(3);
        const combo = ['i', 'ArrowRight', 'm', 'ArrowRight', 'i', 'ArrowLeft', 'ArrowLeft', 'm', 'ArrowRight', 'ArrowRight'];
        for (const key of combo) {
            await ctx.page.keyboard.press(key);
            await ctx.sleep(900);
        }
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
