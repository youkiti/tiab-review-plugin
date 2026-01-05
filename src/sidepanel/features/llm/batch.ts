/**
 * LLMバッチ処理モジュール
 * バッチ処理実行、閾値調整、実行履歴管理
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmBatchProgress, Decision, RateLimitConfig } from '../../../lib/types';
import { RATE_LIMIT_FREE, RATE_LIMIT_PAID } from '../../../lib/types';
import {
    appendDecisions,
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    saveLlmExecution,
    getLlmExecutions,
    updateLlmExecution,
    updateLlmConfig,
} from '../../../lib/sheets-api';
import { getEffectiveApiKey, getApiTier } from '../../../lib/storage';
import {
    processBatch,
    calculateProbabilityDistribution,
    previewThresholdCounts,
    applyThresholdToDecisions,
    createLlmExecution,
} from '../../../lib/llm-processor';
import { DEFAULT_SCREENING_PROMPT } from '../../../lib/prompt-templates';
import { getModelConfig } from '../../../lib/gemini-api';
import { showToast } from '../../ui/feedback';

// loadDataAndShowScreeningへの参照（循環依存回避）
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    _loadDataAndShowScreening = fn;
}

/**
 * バッチ対象件数を更新
 */
export function updateBatchTargetCount() {
    // 常に未判定のみを対象
    const count = state.references.length;
    dom.batchTargetCount.textContent = count.toString();
}

/**
 * バッチ処理を開始
 */
export async function handleStartBatch() {
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast('APIキーを設定してください');
        return;
    }

    const screeningPrompt = dom.screeningPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    if (!screeningPrompt) {
        showToast('スクリーニング基準を設定してください');
        return;
    }

    // 対象文献を取得（全件）
    const targetRefs = state.references;

    if (targetRefs.length === 0) {
        showToast('処理対象の文献がありません');
        return;
    }

    // UI更新
    dom.startBatchBtn.classList.add('hidden');
    dom.stopBatchBtn.classList.remove('hidden');
    dom.batchProgressDiv.classList.remove('hidden');
    dom.thresholdSection.classList.add('hidden');

    // AbortControllerを作成
    const abortController = new AbortController();
    state.setBatchAbortController(abortController);
    state.setCurrentBatchDecisions([]);

    try {
        const saveBatchSize = Math.max(parseInt(dom.batchSaveSizeInput.value, 10) || 5, 1);
        const spreadsheetId = state.spreadsheetId;
        const llmConfig = state.llmConfig;

        // API tierに基づいてレート制限を設定
        const tier = await getApiTier();
        const rateLimitConfig: RateLimitConfig = tier === 'free' ? RATE_LIMIT_FREE : RATE_LIMIT_PAID;

        if (tier === 'free') {
            showToast('無料版APIキーのため、処理速度が制限されます（約13秒/件）', 4000);
        }

        // 選択されたモデルの設定を取得
        const modelConfig = getModelConfig(dom.llmModelSelect.value);

        const result = await processBatch(targetRefs, {
            batchSize: saveBatchSize,
            screeningPrompt,
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            topP: modelConfig.topP,
            thinkingLevel: modelConfig.thinkingLevel,

            outputLanguage: dom.llmLanguageSelect.value,
            rateLimitConfig,
            abortSignal: abortController.signal,
            onProgress: updateBatchProgress,
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                const currentDecisions = state.currentBatchDecisions;
                state.setCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
        });

        state.setCurrentExecutionId(result.executionId);

        // 失敗したref_idを保存
        state.setFailedRefIds(result.failedRefIds);

        // 失敗があればリトライボタンを表示
        if (result.failedRefIds.length > 0) {
            dom.retryFailedBtn.textContent = `🔄 失敗した${result.failedRefIds.length}件をリトライ`;
            dom.retryFailedBtn.classList.remove('hidden');
        } else {
            dom.retryFailedBtn.classList.add('hidden');
        }

        // 完了後のUI更新
        if (!abortController.signal.aborted) {
            // pending状態で実行履歴を保存
            const execution = createLlmExecution(
                result.executionId,
                'batch_screening',
                modelConfig.model,
                llmConfig.llm_criteria,
                dom.screeningPromptInput.value,
                0,  // 閾値は未確定
                result.processedCount,
                0,  // include_countは未確定
                0,  // exclude_countは未確定
                'pending',  // status
                true,       // is_active
                // Model parameters
                modelConfig.temperature,
                modelConfig.topP,
                modelConfig.thinkingLevel
            );
            await saveLlmExecution(spreadsheetId, execution);

            // 履歴を再読み込み
            await loadExecutionHistory();

            dom.thresholdProcessedCount.textContent = result.successCount.toString();
            dom.thresholdSection.classList.remove('hidden');

            // 閾値プレビューを更新
            handleThresholdChange();
        }
    } catch (error) {
        console.error('[handleStartBatch] Error:', error);
        showToast(`バッチ処理エラー: ${(error as Error).message}`);
    } finally {
        dom.startBatchBtn.classList.remove('hidden');
        dom.stopBatchBtn.classList.add('hidden');
        state.setBatchAbortController(null);
    }
}

/**
 * バッチ処理を中止
 */
export function handleStopBatch() {
    const controller = state.batchAbortController;
    if (controller) {
        controller.abort();
        showToast('バッチ処理を中止しました');
    }
}

/**
 * 失敗した件をリトライ
 */
export async function handleRetryFailed() {
    const failedRefIds = state.failedRefIds;
    if (failedRefIds.length === 0) {
        showToast('リトライ対象がありません');
        return;
    }

    // 失敗したref_idに対応する文献を取得
    const targetRefs = state.references.filter(r => failedRefIds.includes(r.ref_id));
    if (targetRefs.length === 0) {
        showToast('リトライ対象の文献が見つかりません');
        return;
    }

    showToast(`${targetRefs.length}件をリトライ中...`);

    // リトライボタンを非表示にしてから再処理
    dom.retryFailedBtn.classList.add('hidden');
    state.clearFailedRefIds();

    // 通常のバッチ処理と同様に処理
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast('APIキーを設定してください');
        return;
    }

    const screeningPrompt = dom.screeningPromptInput.value.trim();
    if (!screeningPrompt) {
        showToast('スクリーニング基準を設定してください');
        return;
    }

    dom.startBatchBtn.classList.add('hidden');
    dom.stopBatchBtn.classList.remove('hidden');
    dom.batchProgressDiv.classList.remove('hidden');

    const abortController = new AbortController();
    state.setBatchAbortController(abortController);

    try {
        const saveBatchSize = Math.max(parseInt(dom.batchSaveSizeInput.value, 10) || 5, 1);
        const spreadsheetId = state.spreadsheetId;

        const tier = await getApiTier();
        const rateLimitConfig: RateLimitConfig = tier === 'free' ? RATE_LIMIT_FREE : RATE_LIMIT_PAID;

        const result = await processBatch(targetRefs, {
            batchSize: saveBatchSize,
            screeningPrompt,
            model: dom.llmModelSelect.value,
            temperature: 0,

            outputLanguage: dom.llmLanguageSelect.value,
            rateLimitConfig,
            abortSignal: abortController.signal,
            onProgress: updateBatchProgress,
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                const currentDecisions = state.currentBatchDecisions;
                state.setCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
        });

        // リトライ結果を更新
        state.setFailedRefIds(result.failedRefIds);

        if (result.failedRefIds.length > 0) {
            dom.retryFailedBtn.textContent = `🔄 失敗した${result.failedRefIds.length}件をリトライ`;
            dom.retryFailedBtn.classList.remove('hidden');
            showToast(`リトライ完了: 成功${result.successCount}件、失敗${result.failCount}件`);
        } else {
            showToast(`リトライ完了: 全${result.successCount}件成功`);
        }

        // 閾値プレビューを更新
        handleThresholdChange();
    } catch (error) {
        console.error('[handleRetryFailed] Error:', error);
        showToast(`リトライエラー: ${(error as Error).message}`);
    } finally {
        dom.startBatchBtn.classList.remove('hidden');
        dom.stopBatchBtn.classList.add('hidden');
        state.setBatchAbortController(null);
    }
}

/**
 * バッチ進捗を更新
 */
export function updateBatchProgress(progress: LlmBatchProgress) {
    dom.batchProgressCurrent.textContent = progress.processed.toString();
    dom.batchProgressTotal.textContent = progress.total.toString();

    const percent = progress.total > 0
        ? Math.round((progress.processed / progress.total) * 100)
        : 0;
    dom.batchProgressPercent.textContent = percent.toString();
    dom.batchProgressBarFill.style.width = `${percent}%`;

    dom.batchSuccessCount.textContent = progress.succeeded.toString();
    dom.batchFailCount.textContent = progress.failed.toString();
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
        count.textContent = `${bin.count}件`;

        container.appendChild(label);
        container.appendChild(barWrapper);
        container.appendChild(count);
        dom.distributionChart.appendChild(container);
    }
}

/**
 * 閾値を確定して判断をGoogleスプレッドシートに保存
 */
export async function handleConfirmThreshold() {
    const threshold = parseFloat(dom.thresholdSlider.value);
    const spreadsheetId = state.spreadsheetId;
    const currentDecisions = state.currentBatchDecisions;
    const executionId = state.currentExecutionId;

    console.log('[handleConfirmThreshold] Starting with executionId:', executionId);
    console.log('[handleConfirmThreshold] currentDecisions count:', currentDecisions.length);

    if (!executionId) {
        console.error('[handleConfirmThreshold] executionId is empty!');
        showToast('エラー: 実行IDが見つかりません。ページをリロードしてください。');
        return;
    }

    try {
        dom.confirmThresholdBtn.disabled = true;
        showToast('保存中...');

        // 閾値を適用してdecisionを確定
        const updatedDecisions = applyThresholdToDecisions(currentDecisions, threshold);

        // Decisionsシートの行を取得して更新
        const existingDecisions = await getDecisionsByReviewerId(spreadsheetId, executionId);
        console.log('[handleConfirmThreshold] existingDecisions count:', existingDecisions.length);

        const updates: { rowIndex: number; decision: Decision }[] = [];
        for (const updated of updatedDecisions) {
            const existing = existingDecisions.find(e => e.decision.ref_id === updated.ref_id);
            if (existing) {
                updates.push({ rowIndex: existing.rowIndex, decision: updated });
            }
        }

        console.log('[handleConfirmThreshold] updates count:', updates.length);

        if (updates.length > 0) {
            await updateDecisionsBatch(spreadsheetId, updates);
        }

        // 実行履歴を更新（pending → confirmed）
        const counts = previewThresholdCounts(currentDecisions, threshold);
        console.log('[handleConfirmThreshold] Calling updateLlmExecution with:', {
            executionId,
            threshold,
            includeCount: counts.includeCount,
            excludeCount: counts.excludeCount,
            status: 'confirmed',
            is_active: true
        });

        await updateLlmExecution(spreadsheetId, executionId, {
            include_threshold: threshold,
            include_count: counts.includeCount,
            exclude_count: counts.excludeCount,
            status: 'confirmed',
            is_active: true,  // 閾値確定時に「判定に使用」を自動でオン
        });

        console.log('[handleConfirmThreshold] updateLlmExecution completed successfully');

        // LLM設定を更新
        await updateLlmConfig(spreadsheetId, {
            llm_include_threshold: threshold,
        });

        showToast('閾値を確定してGoogleスプレッドシートに保存しました');

        // データを再読み込み
        if (_loadDataAndShowScreening) {
            await _loadDataAndShowScreening();
        }

        // 実行履歴を更新
        await loadExecutionHistory();

        // ML判定完了後のガイダンスメッセージ
        setTimeout(() => {
            const shouldSwitch = confirm(
                'ML判定が完了しました。\n\n' +
                '手動タブで判定結果を確認しますか？\n' +
                '（フィルターで「すべて」または「Include」「Exclude」を選択すると、判定された文献を確認できます）'
            );
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
        showToast(`保存エラー: ${(error as Error).message}`);
    } finally {
        dom.confirmThresholdBtn.disabled = false;
    }
}

/**
 * 実行履歴を読み込み
 */
export async function loadExecutionHistory() {
    const spreadsheetId = state.spreadsheetId;

    try {
        const executions = await getLlmExecutions(spreadsheetId);

        console.log('[loadExecutionHistory] executions:', executions.map(e => ({
            id: e.execution_id,
            status: e.status,
            is_active: e.is_active,
            type: e.execution_type,
        })));

        // 確定済みかつアクティブなLLM実行IDをキャッシュに保存
        state.clearActiveLlmExecutionIds();
        for (const exec of executions) {
            if (exec.status === 'confirmed' && exec.is_active) {
                state.addActiveLlmExecutionId(exec.execution_id);
            }
        }

        if (executions.length === 0) {
            dom.executionHistory.innerHTML = '<p class="placeholder-text">実行履歴がありません</p>';
            return;
        }

        dom.executionHistory.innerHTML = '';

        // 新しい順にソート
        const sorted = [...executions].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        for (const exec of sorted.slice(0, 10)) {
            const item = document.createElement('div');
            item.className = `execution-item ${exec.status === 'pending' ? 'pending' : 'confirmed'}`;

            const date = new Date(exec.timestamp);
            const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

            const typeLabel = exec.execution_type === 'batch_screening' ? 'バッチ' : '基準生成';
            const statusLabel = exec.status === 'pending' ? '<span class="execution-status pending">未確定</span>' : '';

            // pending状態では閾値・件数を非表示
            const statsContent = exec.status === 'pending'
                ? `${exec.target_count}件処理（閾値未確定）`
                : `${exec.target_count}件処理 → Include: ${exec.include_count}件, Exclude: ${exec.exclude_count}件 (閾値: ${exec.include_threshold.toFixed(2)})`;

            // チェックボックス（batch_screening かつ confirmed のみ）
            const checkboxHtml = exec.status === 'confirmed' && exec.execution_type === 'batch_screening'
                ? `<label class="execution-active-label">
                     <input type="checkbox" class="execution-active-checkbox" 
                            data-execution-id="${exec.execution_id}" 
                            ${exec.is_active ? 'checked' : ''}>
                     判定に使用
                   </label>`
                : '';

            item.innerHTML = `
                <div class="execution-header">
                    <div class="execution-date">
                        <span class="execution-type">${typeLabel}</span>
                        ${statusLabel}
                        ${dateStr}
                    </div>
                    ${checkboxHtml}
                </div>
                <div class="execution-stats">
                    ${statsContent}
                </div>
            `;

            // チェックボックスのイベントリスナー
            const checkbox = item.querySelector('.execution-active-checkbox') as HTMLInputElement | null;
            if (checkbox) {
                checkbox.addEventListener('change', async () => {
                    try {
                        await updateLlmExecution(spreadsheetId, exec.execution_id, {
                            is_active: checkbox.checked,
                        });
                        showToast(checkbox.checked ? '判定に使用します' : '判定から除外しました');
                    } catch (error) {
                        console.error('[loadExecutionHistory] Failed to update is_active:', error);
                        showToast('更新に失敗しました');
                        checkbox.checked = !checkbox.checked; // ロールバック
                    }
                });
            }

            dom.executionHistory.appendChild(item);
        }
    } catch (error) {
        console.error('[loadExecutionHistory] Error:', error);
    }
}
