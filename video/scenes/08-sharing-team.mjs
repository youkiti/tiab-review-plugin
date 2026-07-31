// シーン08: 共有とチーム運用
//
// 全5キュー。共有解除ボタンはネイティブの confirm() ダイアログを伴うため、
// 録画が止まらないよう事前に dialog ハンドラ（承諾）を登録しておく。
// handleShare() は成功後に共有パネルを閉じる仕様のため、追加後は #share-btn を
// 再度開き直して一覧を確認する（video/scenes/... 内 verify-section5 の知見と同じ）。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, hoverSequence } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('08-sharing-team');

export default {
    id: '08',
    slug: 'sharing-team',
    title: '共有とチーム運用',
    narration: '08-sharing-team',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // 共有解除の確認ダイアログを自動で承諾する
        ctx.page.on('dialog', (dialog) => {
            dialog.accept().catch(() => {});
        });

        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: 「共有」ボタンをクリック→共有パネルを表示（2ユーザー） ---
        const t1 = Date.now();
        ctx.cue(1);
        await hoverSlow(ctx.page, ctx.page.locator('#share-btn'), { durationMs: 500 });
        await ctx.page.locator('#share-btn').click();
        await ctx.page.locator('.shared-user-item').first().waitFor({ state: 'visible', timeout: 8000 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: colleague2@example.com を追加→行が増える、招待文コピーをホバー ---
        const t2 = Date.now();
        ctx.cue(2);
        await ctx.page.locator('#share-email-input').fill('colleague2@example.com');
        await ctx.page.locator('#share-submit-btn').click();
        await ctx.sleep(1200);
        // handleShare() 成功後にパネルが閉じる仕様のため、開き直して一覧を確認する
        await ctx.page.locator('#share-btn').click();
        await ctx.page.locator('.shared-user-item', { hasText: 'colleague2@example.com' })
            .waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        await hoverSlow(ctx.page, ctx.page.locator('#share-copy-invite-btn'), { durationMs: 500 });
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: colleague@example.com の✕をクリック→行が消える ---
        const t3 = Date.now();
        ctx.cue(3);
        const colleagueRow = ctx.page.locator('.shared-user-item', { hasText: 'colleague@example.com' });
        await hoverSlow(ctx.page, colleagueRow.locator('.shared-user-remove-btn'), { durationMs: 400 });
        await colleagueRow.locator('.shared-user-remove-btn').click();
        await ctx.sleep(1200);
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: パネルを閉じ、Blindをオフ→オンに切り替える ---
        // #key-toggle-input 自体は `.switch input { opacity:0; width:0; height:0; }` で
        // 視覚的に隠されたチェックボックス（トグルスイッチの実装パターン）なので、
        // Playwright からは「不可視」と判定されクリックできない。見た目上クリック可能な
        // 隣接の `.slider`（ラベル内）をクリックする。
        const t4 = Date.now();
        ctx.cue(4);
        await ctx.page.locator('#share-cancel-btn').click().catch(() => {});
        const keySlider = ctx.page.locator('#key-section .slider');
        await hoverSlow(ctx.page, keySlider, { durationMs: 500 });
        await keySlider.click();
        await ctx.sleep(1800);
        await keySlider.click();
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: チーム進捗チップを開き、🔄をホバー ---
        const t5 = Date.now();
        ctx.cue(5);
        await ctx.page.locator('#team-progress-host .team-progress-header').click();
        await ctx.sleep(600);
        await hoverSlow(ctx.page, ctx.page.locator('.team-progress-refresh'), { durationMs: 500 });
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
