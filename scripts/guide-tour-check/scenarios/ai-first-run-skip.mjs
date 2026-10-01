// ツアー ai-first-run（AI 判定の初回）: 全部「押さずに次へ」で最後まで進む経路。
// 手動タブで ❓ の一覧から始め、AI タブを開く手順（open-tab）から通す。キー・最適化・一括実行は押さないので、
// プロンプトと閾値の手順は「まだ無い」ときの代わりの手順（prompt-wait / threshold-wait）になる。

import { defineScenario } from '../lib/scenario.mjs';
import { expectTourListDone, openTourList } from '../lib/checks.mjs';

export default defineScenario({
    name: 'ai-first-run-skip',
    title: 'ツアー ai-first-run（押さずに次へ）',
    defaultRun: true,
    async run(run) {
        const T = 'ai-first-run';
        await run.openAndLogin();
        await run.connectToDemoSheet();

        // 手動タブの ❓ → 操作ツアーの一覧 → このツアーを始める
        await openTourList(run);
        await run.click(`#guide-tour-list [data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ツアー一覧の「始める」');

        // AI タブを開く手順（タブのボタンを指す）
        await run.waitStep(T, 'open-tab');
        await run.click('#tab-llm', 'open-tab', 'AI タブのボタン');

        await run.waitStep(T, 'model');
        await run.clickNext('model');

        await run.waitStep(T, 'keys'); // キー未設定なので出る
        await run.clickNext('keys');

        await run.waitStep(T, 'protocol');
        await run.clickNext('protocol');

        await run.waitStep(T, 'optimize');
        await run.clickNext('optimize');

        // 最適化していないので、プロンプトが無ければ prompt-wait、デモの保存済み基準があれば prompt
        const prompt = await run.waitStep(T, ['prompt', 'prompt-wait']);
        run.log(`プロンプトの手順は ${prompt}`);
        await run.clickNext(prompt);

        await run.waitStep(T, 'batch-settings');
        await run.clickNext('batch-settings');

        await run.waitStep(T, 'batch-run');
        await run.clickNext('batch-run');

        // 実行していないので閾値の確定欄は無い
        await run.waitStep(T, 'threshold-wait');
        await run.clickNext('threshold-wait');

        await run.waitStep(T, 'history');
        await run.clickNext('history');

        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: ai-first-run が done');

        await expectTourListDone(run, T);
    },
});
