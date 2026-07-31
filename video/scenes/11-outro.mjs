// シーン11: アウトロ（ヘルプページ・問い合わせ先の案内）
//
// 全2キュー。ヘルプページの目次をゆっくりスクロールしたあと、エンドカードへ。

import { REPO_ROOT } from '../scripts/config.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { smoothWheel } from './lib/gestures.mjs';
import { readPkgVersion } from './lib/pkg.mjs';

const DUR = loadCueDurations('11-outro');

export default {
    id: '11',
    slug: 'outro',
    title: 'アウトロ（ヘルプページ・問い合わせ先の案内）',
    narration: '11-outro',

    async run(ctx) {
        // --- cue 1 の前準備: ヘルプページを開いておく ---
        await ctx.page.goto(`file://${REPO_ROOT}/docs/help.html?lang=ja`);
        await ctx.page.locator('.help-toc').scrollIntoViewIfNeeded();
        await ctx.sleep(800);

        // --- cue 1: ヘルプページの目次をゆっくりスクロール ---
        const t1 = Date.now();
        ctx.cue(1);
        await smoothWheel(ctx.page, 500, { steps: 12, stepDelayMs: 130 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: エンドカードを表示して保持 ---
        const t2 = Date.now();
        ctx.cue(2);
        const version = readPkgVersion();
        await ctx.page.goto(`file://${REPO_ROOT}/video/assets/end-card.html?version=${version}`);
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
