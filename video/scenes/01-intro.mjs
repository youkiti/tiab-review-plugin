// シーン01: イントロ（ツール概要）
//
// タイトルカード→サイドパネル全景→4タブのゆっくりホバー、という3キュー構成。
// ログイン済み状態（storageSeed）から始め、cue2 でデモプロジェクトへ接続して
// スクリーニング画面へ遷移する。

import { REPO_ROOT } from '../scripts/config.mjs';
import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSequence } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';
import { readPkgVersion } from './lib/pkg.mjs';

const DUR = loadCueDurations('01-intro');

export default {
    id: '01',
    slug: 'intro',
    title: 'イントロ（ツール概要）',
    narration: '01-intro',
    // サイドパネルを開いた時点でログイン済み（プロジェクト選択画面）にしておく。
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // --- cue 1: タイトルカード ---
        const version = readPkgVersion();
        await ctx.page.goto(`file://${REPO_ROOT}/video/assets/title-card.html?version=${version}`);
        await ctx.sleep(800);

        const t1 = Date.now();
        ctx.cue(1);
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: サイドパネル全景（スクリーニング画面）を表示 ---
        const t2 = Date.now();
        ctx.cue(2);
        await ctx.page.goto(`chrome-extension://${ctx.extId}/sidepanel/sidepanel.html`);
        await connectDemoProject(ctx.page);
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: タブ（手動/ML/AI/全文）をゆっくりホバー ---
        const t3 = Date.now();
        ctx.cue(3);
        await hoverSequence(ctx.page, [
            ctx.page.locator('#tab-screening'),
            ctx.page.locator('#tab-ml'),
            ctx.page.locator('#tab-llm'),
            ctx.page.locator('#tab-fulltext'),
        ], { holdMs: 700, moveMs: 500 });
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
