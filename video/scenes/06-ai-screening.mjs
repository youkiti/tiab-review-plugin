// シーン06: AIスクリーニング支援
//
// 全5キュー。cue2 は本来「設定(⚙️)を開いてAPIキーカードを表示」という構成だが、
// 実際のUIでは #llm-settings-btn は拡張機能全体の設定画面（settings-section）に
// 遷移するボタンであり、AIタブ内のAPIキーカード（#api-key-card）とは無関係。
// APIキーカードはAIタブを開いた時点で常に表示されているため、ここでは歯車ボタンは
// 押さずに直接カードへ入力する（ストーリーボードからの意図的な逸脱）。
//
// また、閾値確定保存（#confirm-threshold-btn）の完了後は、1秒後にネイティブの
// confirm() ダイアログ（手動タブへの切り替え確認）が表示される実装になっている。
// 録画がブロックされないよう、事前に dialog ハンドラを登録して自動的に閉じる。

import { loadCueDurations, sleepRemainder } from './lib/pacing.mjs';
import { hoverSlow, smoothWheel } from './lib/gestures.mjs';
import { connectDemoProject } from './lib/connect.mjs';

const DUR = loadCueDurations('06-ai-screening');

export default {
    id: '06',
    slug: 'ai-screening',
    title: 'AIスクリーニング支援',
    narration: '06-ai-screening',
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // ネイティブ confirm() ダイアログ（判定完了後の案内）が出ても録画が止まらないようにする
        ctx.page.on('dialog', (dialog) => {
            dialog.dismiss().catch(() => {});
        });

        // --- 収録前準備: サインイン済み状態からデモプロジェクトへ接続 ---
        await connectDemoProject(ctx.page);
        await ctx.sleep(800);

        // --- cue 1: AIタブを開く ---
        const t1 = Date.now();
        ctx.cue(1);
        await hoverSlow(ctx.page, ctx.page.locator('#tab-llm'), { durationMs: 500 });
        await ctx.page.locator('#tab-llm').click();
        await ctx.page.locator('#api-key-card').waitFor({ state: 'visible', timeout: 10000 });
        await sleepRemainder(ctx, t1, DUR['01'] * 1000 + 500);

        // --- cue 2: Gemini APIキーカードにダミーキーを入力し、ティア確認表示を待つ ---
        const t2 = Date.now();
        ctx.cue(2);
        await hoverSlow(ctx.page, ctx.page.locator('#gemini-api-key'), { durationMs: 500 });
        await ctx.page.locator('#gemini-api-key').fill('AIzaDemoKey1234567890');
        await ctx.page.locator('#gemini-api-key').dispatchEvent('change');
        await ctx.page.locator('#api-key-status').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        await ctx.sleep(1000);
        await sleepRemainder(ctx, t2, DUR['02'] * 1000 + 500);

        // --- cue 3: 「レビュー基準」カードを表示し、プロンプトをゆっくりスクロール ---
        const t3 = Date.now();
        ctx.cue(3);
        await ctx.page.locator('#criteria-card').scrollIntoViewIfNeeded();
        await hoverSlow(ctx.page, ctx.page.locator('#protocol-text-input'), { durationMs: 500 });
        await smoothWheel(ctx.page, 220, { steps: 8, stepDelayMs: 110 });
        await sleepRemainder(ctx, t3, DUR['03'] * 1000 + 500);

        // --- cue 4: 「一括実行開始」をクリックし、バッチ処理の進行を見せる ---
        const t4 = Date.now();
        ctx.cue(4);
        await ctx.page.locator('#start-batch-btn').scrollIntoViewIfNeeded();
        await hoverSlow(ctx.page, ctx.page.locator('#start-batch-btn'), { durationMs: 500 });
        await ctx.page.locator('#start-batch-btn').click();
        await ctx.page.locator('#batch-progress:not(.hidden)').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        await sleepRemainder(ctx, t4, DUR['04'] * 1000 + 500);

        // --- cue 5: 完了→結果スクロール→閾値確認→確定保存→トースト ---
        const t5 = Date.now();
        ctx.cue(5);
        await ctx.page.locator('#threshold-section:not(.hidden)').waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
        await ctx.sleep(600);
        await smoothWheel(ctx.page, 260, { steps: 8, stepDelayMs: 110 });
        await hoverSlow(ctx.page, ctx.page.locator('#threshold-slider'), { durationMs: 500 });
        await ctx.sleep(600);
        const confirmBtn = ctx.page.locator('#confirm-threshold-btn');
        if (await confirmBtn.isVisible().catch(() => false)) {
            await hoverSlow(ctx.page, confirmBtn, { durationMs: 500 });
            await confirmBtn.click();
            await ctx.page.locator('#toast.show').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        }
        await sleepRemainder(ctx, t5, DUR['05'] * 1000 + 500);

        await ctx.sleep(1500);
    },
};
