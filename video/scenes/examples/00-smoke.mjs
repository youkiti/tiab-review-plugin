// スモークテスト用シーン（シーンスクリプトの CONTRACT 例）
//
// video/scripts/record.mjs のヘッダーコメントに書かれた CONTRACT に沿った最小構成のシーン。
// サイドパネルを開いた状態から、待つ→キューを打つ、だけを行うトリビアルな内容だが、
// narration を 01-intro に向けることで、収録→TTS→合成の一連のパイプラインを
// 音声付きで最後まで通せる検証に使う（実際のチャプター 01〜11 は別タスクで追加される）。
//
// 実際のチャプター用シーンを書く際はこのファイルを土台にしてよい。

export default {
    id: '00',
    slug: 'smoke',
    title: 'スモークテスト',
    // このシーン自体の原稿は無いが、01-intro の原稿（3キュー）を借りて
    // 音声合成・字幕・ミックスまでの経路を通す。
    narration: '01-intro',
    // ログイン画面をスキップし、プロジェクト選択画面から収録を始める。
    storageSeed: { demo_signed_in: true },

    async run(ctx) {
        // 画面遷移が落ち着くまでの「間」（config.mjs の SCENE_LEAD_IN_SEC 目安）
        await ctx.page.locator('#recent-sheets').waitFor({ state: 'visible', timeout: 15000 });
        await ctx.sleep(800);

        ctx.cue(1);
        await ctx.sleep(6000);

        ctx.cue(2);
        await ctx.sleep(6000);

        ctx.cue(3);
        await ctx.sleep(6000);
    },
};
