/**
 * LLMバッチ処理モジュール - 閾値調整・採用操作
 *
 * Issue #191: 元 `batch.ts`（1,393行）から閾値調整・採用操作部分を分離。
 * 閾値スライダーの変更プレビュー、確率分布チャート、閾値の確定保存（Run 単位での
 * Decisions 一括更新・Run の active 化）を担当する。
 *
 * `prepareThresholdAdjustment` は実行履歴の Run カード（`./history` の `appendRunCard`）
 * から呼ばれるが、`./history` 側は `loadExecutionHistory` をここから読み込むため、
 * 直接 import し合うと `./history` <-> `./threshold` の循環になる
 * （`node scripts/check-structure.mjs` の循環検出に引っかかる）。
 * これを避けるため、`setPrepareThresholdAdjustment`（`./history` 側）へこの関数を
 * 注入する方式にしている（`./index` が起動時に配線する）。挙動は直接 import していた
 * ときと同じで、単に依存の向きを一方向に揃えるための間接参照。
 */

import { dom } from '../dom';
import { state } from '../../../state';
import type { Decision } from '../../../../lib/types';
import {
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    updateLlmConfig,
    getRunForBatchId,
    getBatchIdsForRun,
    updateLlmRun,
    setSingleActiveRun,
} from '../../../../lib/sheets-api';
import { showToast } from '../../../ui/feedback';
import { t } from '../../../../lib/i18n';
import {
    calculateProbabilityDistribution,
    previewThresholdCounts,
    applyThresholdToDecisions,
} from '../../../../lib/llm-processor';
import { setCurrentBatchDecisions as syncSetCurrentBatchDecisions } from '../../../store/compat';
import { loadExecutionHistory } from './history';

// loadDataAndShowScreeningへの参照（循環依存回避）
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    _loadDataAndShowScreening = fn;
}

/**
 * 実行履歴の Run カードから閾値調整 UI を開く準備をする
 *
 * Run/Batch 分離後、閾値は Run 単位で適用される。プレビューも Run 配下の
 * 全 Batch を合算して表示する（confirm 時の挙動と整合させる）
 */
export async function prepareThresholdAdjustment(executionId: string, threshold: number, targetCount: number): Promise<void> {
    const spreadsheetId = state.spreadsheetId;

    const run = await getRunForBatchId(spreadsheetId, executionId);
    let allDecisions: Decision[] = [];

    if (run) {
        const batchIds = await getBatchIdsForRun(spreadsheetId, run.run_id);
        for (const batchId of batchIds) {
            const data = await getDecisionsByReviewerId(spreadsheetId, batchId);
            allDecisions.push(...data.map(d => d.decision));
        }
    } else {
        // Run 不明（移行前データ等）の場合はクリックされた Batch のみ
        const data = await getDecisionsByReviewerId(spreadsheetId, executionId);
        allDecisions = data.map(d => d.decision);
    }

    if (allDecisions.length === 0) {
        throw new Error(t('llm_thresholdAdjustNoDecisions'));
    }

    state.setCurrentExecutionId(executionId);
    syncSetCurrentBatchDecisions(allDecisions);

    dom.thresholdSlider.value = threshold.toFixed(2);
    dom.thresholdValueDisplay.textContent = threshold.toFixed(2);
    dom.thresholdCompleteMessage.textContent = t('llm_thresholdAdjustLoaded', String(targetCount));
    dom.thresholdSection.classList.remove('hidden');

    handleThresholdChange();
    dom.thresholdSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 閾値変更時の処理
 */
export function handleThresholdChange() {
    const threshold = parseFloat(dom.thresholdSlider.value);
    dom.thresholdValueDisplay.textContent = threshold.toFixed(2);

    // プレビューを更新
    const currentDecisions = state.currentBatchDecisions;
    const counts = previewThresholdCounts(currentDecisions, threshold);
    const total = counts.includeCount + counts.excludeCount;

    dom.previewIncludeCount.textContent = counts.includeCount.toString();
    dom.previewExcludeCount.textContent = counts.excludeCount.toString();

    if (total > 0) {
        dom.previewIncludePercent.textContent = Math.round((counts.includeCount / total) * 100).toString();
        dom.previewExcludePercent.textContent = Math.round((counts.excludeCount / total) * 100).toString();
    } else {
        dom.previewIncludePercent.textContent = '-';
        dom.previewExcludePercent.textContent = '-';
    }
}

/**
 * 分布チャートの表示/非表示
 */
export function toggleDistributionChart() {
    dom.distributionChart.classList.toggle('hidden');

    if (!dom.distributionChart.classList.contains('hidden')) {
        renderDistributionChart();
    }
}

/**
 * 分布チャートを描画
 */
export function renderDistributionChart() {
    const currentDecisions = state.currentBatchDecisions;
    const distribution = calculateProbabilityDistribution(currentDecisions, 5);
    const maxCount = Math.max(...distribution.map(d => d.count), 1);

    dom.distributionChart.innerHTML = '';

    for (const bin of distribution) {
        const container = document.createElement('div');
        container.className = 'distribution-bar-container';

        const label = document.createElement('span');
        label.className = 'distribution-label';
        label.textContent = bin.range;

        const barWrapper = document.createElement('div');
        barWrapper.className = 'distribution-bar-wrapper';

        const bar = document.createElement('div');
        bar.className = 'distribution-bar';
        bar.style.width = `${(bin.count / maxCount) * 100}%`;
        barWrapper.appendChild(bar);

        const count = document.createElement('span');
        count.className = 'distribution-count';
        count.textContent = t('common_countItems', String(bin.count));

        container.appendChild(label);
        container.appendChild(barWrapper);
        container.appendChild(count);
        dom.distributionChart.appendChild(container);
    }
}

/**
 * 閾値を確定して判断をGoogleスプレッドシートに保存
 *
 * Run/Batch 分離後:
 * - 閾値は Run 単位で1つ。current Batch の所属 Run を解決し、Run 配下の
 *   全 Batch の Decisions に対して閾値を適用する
 * - Run 行の include_threshold / status / is_active を更新
 * - LLM_Executions 側の冗長列は書き換えない
 */
export async function handleConfirmThreshold() {
    const threshold = parseFloat(dom.thresholdSlider.value);
    const spreadsheetId = state.spreadsheetId;
    const executionId = state.currentExecutionId;

    console.log('[handleConfirmThreshold] Starting with executionId:', executionId);

    if (!executionId) {
        console.error('[handleConfirmThreshold] executionId is empty!');
        showToast(t('llm_thresholdMissingId'));
        return;
    }

    try {
        dom.confirmThresholdBtn.disabled = true;
        showToast(t('common_saving'));

        // current Batch の所属 Run を解決
        const run = await getRunForBatchId(spreadsheetId, executionId);
        if (!run) {
            throw new Error(`Run not found for batch ${executionId}`);
        }

        // Run 配下の全 Batch を対象に Decisions を取得し、閾値を適用
        const batchIds = await getBatchIdsForRun(spreadsheetId, run.run_id);
        const allDecisionsWithRow: { rowIndex: number; decision: Decision }[] = [];
        let aggregatedInclude = 0;
        let aggregatedExclude = 0;

        for (const batchId of batchIds) {
            const decisionsForBatch = await getDecisionsByReviewerId(spreadsheetId, batchId);
            const decisionObjs = decisionsForBatch.map(d => d.decision);
            const updated = applyThresholdToDecisions(decisionObjs, threshold);
            const counts = previewThresholdCounts(decisionObjs, threshold);
            aggregatedInclude += counts.includeCount;
            aggregatedExclude += counts.excludeCount;

            for (const updatedDecision of updated) {
                const existing = decisionsForBatch.find(e => e.decision.ref_id === updatedDecision.ref_id);
                if (existing) {
                    allDecisionsWithRow.push({ rowIndex: existing.rowIndex, decision: updatedDecision });
                }
            }
        }

        console.log('[handleConfirmThreshold] Run-level updates:', {
            runId: run.run_id,
            batchCount: batchIds.size,
            updateCount: allDecisionsWithRow.length,
            includeCount: aggregatedInclude,
            excludeCount: aggregatedExclude,
        });

        if (allDecisionsWithRow.length > 0) {
            await updateDecisionsBatch(spreadsheetId, allDecisionsWithRow);
        }

        // Run を確定状態に更新（閾値・status・is_active）
        await updateLlmRun(spreadsheetId, run.run_id, {
            include_threshold: threshold,
            status: 'confirmed',
            is_active: true,
        });

        // この Run のみを active に。他の Run は false に切り替える
        await setSingleActiveRun(spreadsheetId, run.run_id);

        // LLM設定を更新（次回新規 Run のデフォルト閾値）
        await updateLlmConfig(spreadsheetId, {
            llm_include_threshold: threshold,
        });

        showToast(t('llm_thresholdSaved'));

        // データを再読み込み
        if (_loadDataAndShowScreening) {
            await _loadDataAndShowScreening();
        }

        // 実行履歴を更新
        await loadExecutionHistory();

        // ML判定完了後のガイダンスメッセージ
        setTimeout(() => {
            const shouldSwitch = confirm(t('llm_completedConfirm'));
            if (shouldSwitch) {
                // 手動タブに切り替え
                document.getElementById('tab-screening')?.click();
                // フィルターを「すべて」に設定
                const statusFilter = document.getElementById('status-filter') as HTMLSelectElement | null;
                if (statusFilter) {
                    statusFilter.value = 'all';
                    statusFilter.dispatchEvent(new Event('change'));
                }
            }
        }, 1000);
    } catch (error) {
        console.error('[handleConfirmThreshold] Error:', error);
        showToast(t('llm_thresholdSaveError', (error as Error).message));
    } finally {
        dom.confirmThresholdBtn.disabled = false;
    }
}
