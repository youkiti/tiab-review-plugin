// シーン05: MLスクリーニング（機械学習支援）
//
// ?demoProfile=ml（1,100件）でサインイン・接続済みの状態から、MLタブを開いて
// 初回停止基準（CMH）ダイアログを確認・確定し、ML判定を数件行う。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, hoverSequence, smoothWheel } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('05-ml-screening');

export default {
    id: '05',
    slug: 'ml-screening',
    title: 'MLスクリーニング（機械学習支援）',
    narration: '05-ml-screening',
    storageSeed: { demo_signed_in: true },
    pageQuery: 'demoProfile=ml',

    async run(ctx) {
        // --- 収録前準備: サインイン済み状態からデモプロジェクト（1,100件）へ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: MLタブをクリックして開く ---
        const t1 = Date.now();
        ctx.cue(1);
        await hoverSlow(ctx.page, ctx.page.locator('#tab-ml'), { durationMs: 500 });
        await ctx.page.locator('#tab-ml').click();
        await ctx.page.locator('#modal-backdrop:not(.hidden)').waitFor({ state: 'visible', timeout: 10000 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 初回停止基準（CMH）ダイアログの内容を確認（少しスクロール） ---
        const t2 = Date.now();
        ctx.cue(2);
        await hoverSlow(ctx.page, ctx.page.locator('#modal-body'), { durationMs: 500 });
        await smoothWheel(ctx.page, 120, { steps: 6, stepDelayMs: 120 });
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: ダイアログを確定→ML判定を2〜3件 ---
        const t3 = Date.now();
        ctx.cue(3);
        await ctx.page.getByText('この設定で開始', { exact: false }).first().click();
        await ctx.page.locator('#ml-btn-include').waitFor({ state: 'visible', timeout: 10000 });
        await ctx.sleep(600);
        const mlDecisions1 = ['include', 'exclude', 'include'];
        for (const d of mlDecisions1) {
            const btn = d === 'include' ? '#ml-btn-include' : '#ml-btn-exclude';
            await hoverSlow(ctx.page, ctx.page.locator(btn), { durationMs: 400 });
            await ctx.page.locator(btn).click();
            await ctx.sleep(700);
        }
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: さらに3〜4件判定し、順位・ステータス表示をホバー ---
        const t4 = Date.now();
        ctx.cue(4);
        const mlDecisions2 = ['exclude', 'include', 'exclude', 'include'];
        for (const d of mlDecisions2) {
            const btn = d === 'include' ? '#ml-btn-include' : '#ml-btn-exclude';
            await ctx.page.locator(btn).click();
            await ctx.sleep(650);
        }
        await hoverSlow(ctx.page, ctx.page.locator('#ml-status-badge'), { durationMs: 500 });
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: 停止基準の進捗表示をホバー ---
        const t5 = Date.now();
        ctx.cue(5);
        await hoverSequence(ctx.page, [
            ctx.page.locator('.stopping-rule-container'),
            ctx.page.locator('#ml-count-remaining'),
        ], { holdMs: 700, moveMs: 500 });
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
