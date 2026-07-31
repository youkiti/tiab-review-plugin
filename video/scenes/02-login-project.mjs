// シーン02: ログインとプロジェクト作成・接続
//
// ログアウト状態から開始し、ログイン→プロジェクト選択画面の紹介→新規作成ボタン
// （クリックしない）→最近のシート/URL入力欄（選択しない）→実際に選択して接続、
// という6キュー構成。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow } from './lib/gestures.mjs';

const DUR = loadCueDurations('02-login-project');

export default {
    id: '02',
    slug: 'login-project',
    title: 'ログインとプロジェクト作成・接続',
    narration: '02-login-project',
    // storageSeed 無し: ログアウト状態（ログイン画面）から開始する。

    async run(ctx) {
        // --- cue 1: ログイン画面を表示 ---
        await ctx.page.locator('#login-btn').waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(800);

        const t1 = Date.now();
        ctx.cue(1);
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: 「Googleアカウントでログイン」ボタンをクリック ---
        const t2 = Date.now();
        ctx.cue(2);
        await ctx.page.locator('#login-btn').click();
        await ctx.page.locator('#create-btn').waitFor({ state: 'visible', timeout: 10000 });
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: プロジェクト設定画面を表示（全景） ---
        const t3 = Date.now();
        ctx.cue(3);
        await hoverSlow(ctx.page, ctx.page.locator('#user-info'), { durationMs: 500 });
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: 「新規レビュープロジェクトを作成」ボタンをハイライト（クリックしない） ---
        const t4 = Date.now();
        ctx.cue(4);
        await hoverSlow(ctx.page, ctx.page.locator('#create-btn'), { durationMs: 700 });
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: 最近のスプレッドシートのドロップダウン・URL入力欄をホバー/フォーカス（選択しない） ---
        const t5 = Date.now();
        ctx.cue(5);
        await hoverSlow(ctx.page, ctx.page.locator('#spreadsheet-input'), { durationMs: 600 });
        await ctx.page.locator('#spreadsheet-input').focus();
        await ctx.sleep(500);
        await hoverSlow(ctx.page, ctx.page.locator('#recent-sheets'), { durationMs: 600 });
        await ctx.page.locator('#recent-sheets').focus();
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        // --- cue 6: 「選択したシートに接続」→スクリーニング画面へ遷移 ---
        const t6 = Date.now();
        ctx.cue(6);
        await ctx.page.locator('#recent-sheets').selectOption({ index: 1 });
        await ctx.page.locator('#btn-include').waitFor({ state: 'visible', timeout: 15000 });
        await sleepRemainder(ctx, t6, DUR['06'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
