// シーン10: 設定オプション
//
// 全4キュー。設定画面（settings-section）内のチェックボックスをオン/オフし、
// 最後に設定を閉じてスクリーニング画面へ戻る。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('10-settings');

export default {
    id: '10',
    slug: 'settings',
    title: '設定オプション',
    narration: '10-settings',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: ツールバーの歯車ボタンをクリックして設定画面を開く ---
        const t1 = Date.now();
        ctx.cue(1);
        await hoverSlow(ctx.page, ctx.page.locator('#settings-btn-screening'), { durationMs: 500 });
        await ctx.page.locator('#settings-btn-screening').click();
        await ctx.page.locator('#auto-navigate-checkbox').waitFor({ state: 'visible', timeout: 8000 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 「判断後に自動的に次の文献に遷移する」をオフ→オン ---
        const t2 = Date.now();
        ctx.cue(2);
        await hoverSlow(ctx.page, ctx.page.locator('#auto-navigate-checkbox'), { durationMs: 500 });
        await ctx.page.locator('#auto-navigate-checkbox').click();
        await ctx.sleep(1500);
        await ctx.page.locator('#auto-navigate-checkbox').click();
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: 「進捗表示を下部に表示」をオフ→オン ---
        const t3 = Date.now();
        ctx.cue(3);
        await hoverSlow(ctx.page, ctx.page.locator('#show-record-count-checkbox'), { durationMs: 500 });
        await ctx.page.locator('#show-record-count-checkbox').click();
        await ctx.sleep(1500);
        await ctx.page.locator('#show-record-count-checkbox').click();
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: 残りの設定をスクロールして見せ、閉じてスクリーニング画面に戻る ---
        const t4 = Date.now();
        ctx.cue(4);
        await smoothWheel(ctx.page, 420, { steps: 10, stepDelayMs: 100 });
        await ctx.sleep(600);
        await ctx.page.locator('#close-settings-btn').click();
        await ctx.page.locator('#btn-include').waitFor({ state: 'visible', timeout: 8000 });
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
