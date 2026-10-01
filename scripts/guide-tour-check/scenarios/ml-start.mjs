// ツアー ml-start（ML の開始）: ❓ の一覧から始め、ML タブを開く → 停止基準のダイアログ → 実際に判定 →
// 学習状態 → 停止基準 → 到達時の説明 → 完了まで、実際に押して進む経路。
// デモの ?demoProfile=ml（合成文献 1,100 件）で ML タブが開く。

import { defineScenario } from '../lib/scenario.mjs';
import { sleep } from '../lib/constants.mjs';
import {
    expectCardClearOfTarget,
    expectTourListDone,
    openTourList,
} from '../lib/checks.mjs';

export default defineScenario({
    name: 'ml-start',
    title: 'ツアー ml-start（実際に押す経路）',
    defaultRun: true,
    async run(run) {
        const T = 'ml-start';
        await run.openAndLogin('?demoProfile=ml');
        await run.connectToDemoSheet();

        // 一覧から始める（スクリーニング画面のまま。ML タブはまだ開いていない）
        await openTourList(run);
        await run.click(`[data-guide-tour-item="${T}"] [data-guide-action="start"]`, 'start', 'ml-start の「始める」');

        // ML タブを開く
        await run.waitStep(T, 'open-tab');
        await expectCardClearOfTarget(run, 'open-tab', '#tab-ml', 'ML タブ');
        await run.click('#tab-ml', 'open-tab', 'ML タブ');

        // 停止基準のダイアログ（モーダルの中の対象を強調する）
        await run.waitStep(T, 'stopping-dialog');
        await run.waitVisible('#modal-backdrop:not(.hidden) [data-tour="ml-stopping-confirm"]', 'stopping-dialog', 'ダイアログの「この設定で開始」');
        await expectCardClearOfTarget(run, 'stopping-dialog', '[data-tour="ml-stopping-confirm"]', 'ダイアログの「この設定で開始」');
        // run.click はモーダルを閉じてしまうので、ダイアログの中のボタンは直接押す
        await run.page.locator('[data-tour="ml-stopping-confirm"]').click({ timeout: 10000 });

        // 判定（Web Worker の初期化を待つので、判定ボタンが見えてから押す）
        await run.waitStep(T, 'decide');
        await expectCardClearOfTarget(run, 'decide', '[data-tour="ml-decision-buttons"]', '判定ボタン');
        await run.click('#ml-btn-include', 'decide', 'ML の Include ボタン');

        // 学習状態: もう1件 Exclude を付けて、学習が始まる（バッジが「未学習」でなくなる）のを見る
        await run.waitStep(T, 'learning-state');
        await expectCardClearOfTarget(run, 'learning-state', '[data-tour="ml-stats"]', '学習状態の件数');
        await run.page.locator('#ml-btn-exclude').click({ timeout: 10000 });
        await sleep(1500);
        const badge = (await run.page.locator('#ml-status-text').textContent())?.trim();
        run.log(`Include 1 件 + Exclude 1 件のあとの状態バッジ: "${badge}"`);
        await run.shot('learning-badge');
        await run.clickNext('learning-state');

        // 停止基準の進み具合 → 到達したときの説明（説明だけ）
        await run.waitStep(T, 'stopping-progress');
        await expectCardClearOfTarget(run, 'stopping-progress', '[data-tour="ml-stopping"]', '停止基準の表示');
        await run.clickNext('stopping-progress');
        await run.waitStep(T, 'stopping-reached');
        await run.clickNext('stopping-reached');

        // 使えないプロジェクト向けの手順は、使えるので飛ばされる。ML タブにいる間は、画面内の「?」を指して終える
        await run.waitStep(T, 'finish-ml');
        await expectCardClearOfTarget(run, 'finish-ml', '[data-tour="ml-help"]', 'ML 画面の「?」');
        await run.clickNext('finish-ml');
        await run.waitCardGone('finish-ml');
        await run.waitTourStatus(T, 'done', 'finish-ml');
        run.log('guide_progress: ml-start が done');
        // ❓ はスクリーニング画面のツールバーにあるので、手動タブへ戻ってから一覧を確かめる
        await run.click('#tab-screening', 'tour-list', '手動タブ');
        await expectTourListDone(run, T);
    },
});
