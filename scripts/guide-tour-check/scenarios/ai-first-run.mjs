// ツアー ai-first-run（AI 判定の初回）: 実際に押して進む経路。
// タブを初めて開いたときの提案の帯から始め、キーの保存 → 一括実行 → 閾値の確定まで押して進み、
// 確定の1秒後に出る confirm()（手動タブへの切り替え）で別のタブへ移っても、続きの手順が迷子にならないことを確かめる。
// 全部「押さずに次へ」で進む経路は ai-first-run-skip.mjs。

import { sleep } from '../lib/constants.mjs';
import { defineScenario } from '../lib/scenario.mjs';
import { expectCardClearOfTarget, expectTourListDone } from '../lib/checks.mjs';

// src/demo の Gemini 模擬応答に通るダミーのキー（scripts/doc-screenshots/capture.mjs と同じ）
const DEMO_API_KEY = 'AIzaDemoKey1234567890';
const BATCH_TIMEOUT = 120000;

export default defineScenario({
    name: 'ai-first-run',
    title: 'ツアー ai-first-run（押して進む）',
    defaultRun: true,
    async run(run) {
        const T = 'ai-first-run';
        await run.openAndLogin();
        await run.connectToDemoSheet();

        // AI タブを初めて開く → 提案の帯から始める（タブはすでに開いているので open-tab は飛ばされる）
        await run.page.locator('#tab-llm').click();
        await run.waitVisible('#guide-tab-suggest', 'banner', 'タブの提案の帯');
        await run.shot('tab-suggest');
        await run.click('#guide-tab-suggest [data-guide-action="start"]', 'banner', '帯の「ツアーで進める」');

        await run.waitStep(T, 'model');
        await expectCardClearOfTarget(run, 'model', '#llm-model-select', 'モデルの選択欄');
        await run.clickNext('model');

        // キー: 未設定なので手順が出る。実際に入れて保存する
        await run.waitStep(T, 'keys');
        await run.page.locator('#gemini-api-key').fill(DEMO_API_KEY);
        await run.click('#verify-gemini-api-key-btn', 'keys', 'Gemini の「確認して保存」');

        await run.waitStep(T, 'protocol');
        await run.page.locator('#protocol-text-input').fill('Population: adults with depression\nIntervention: exercise\nInclude: randomized trials\nExclude: animal studies');
        await run.clickNext('protocol');

        // 基準の最適化（デモの模擬応答）
        await run.waitStep(T, 'optimize');
        await run.click('#optimize-criteria-btn', 'optimize', '「基準を最適化」');
        const afterOptimize = await run.waitStep(T, ['prompt', 'prompt-wait']);
        if (afterOptimize === 'prompt-wait') run.fail('optimize', '最適化のあとはプロンプトの手順（prompt）になること');
        await run.click('#save-criteria-btn', 'prompt', '「基準を保存」');

        await run.waitStep(T, 'batch-settings');
        await run.page.locator('#batch-max-count-select').selectOption('10');
        await run.clickNext('batch-settings');

        // 一括実行 → 終わると閾値の手順へ
        await run.waitStep(T, 'batch-run');
        await run.click('#start-batch-btn', 'batch-run', '「一括実行開始」');
        await run.waitStep(T, 'threshold', BATCH_TIMEOUT);
        await expectCardClearOfTarget(run, 'threshold', '#confirm-threshold-btn', '閾値の確定ボタン');

        // 閾値の確定 → 1秒後に confirm()（openAndLogin のハンドラが承諾し、手動タブへ切り替わる）
        await run.click('#confirm-threshold-btn', 'threshold', '「閾値を確定して保存」');
        await run.waitStep(T, 'history');
        const switched = await run.page.locator('#tab-screening.active').waitFor({ state: 'attached', timeout: 8000 }).then(() => true, () => false);
        await sleep(500);
        if (switched) {
            // 手動タブへ切り替わると、履歴は画面に無いので「この操作ができる画面を開いてください」の待機表示になる
            await run.page.waitForFunction(() => document.getElementById('guide-tour-card')?.getAttribute('data-guide-waiting') === 'true', null, { timeout: 8000 })
                .catch(() => run.fail('history', '手動タブへ切り替わったあと、カードが待機表示（data-guide-waiting）になること'));
            run.log('手動タブへ切り替わり、history の手順は待機表示になった');
            await run.shot('history-waiting');
            await run.click('#tab-llm', 'history', 'AI タブ');
            await run.page.waitForFunction(() => document.getElementById('guide-tour-card')?.getAttribute('data-guide-waiting') === null, null, { timeout: 8000 })
                .catch(() => run.fail('history', 'AI タブへ戻ると待機表示が消えること'));
            await run.waitStep(T, 'history');
        } else {
            run.log('confirm() のあとも AI タブのまま（手動タブへは切り替わらなかった）');
        }
        await run.clickNext('history');

        await run.waitStep(T, 'finish');
        await run.clickNext('finish');
        await run.waitCardGone('finish');
        await run.waitTourStatus(T, 'done', 'finish');
        run.log('guide_progress: ai-first-run が done');

        await expectTourListDone(run, T);
    },
});
