/**
 * LLMバッチ処理モジュール
 * バッチ処理実行、閾値調整、実行履歴管理
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmBatchProgress, Decision, RateLimitConfig, LlmExecution } from '../../../lib/types';
import { RATE_LIMIT_FREE, RATE_LIMIT_PAID } from '../../../lib/types';
import {
    appendDecisions,
    getDecisionsByReviewerId,
    getLlmPendingDecisions,
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
import { t } from '../../../lib/i18n';

// loadDataAndShowScreeningへの参照（循環依存回避）
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    _loadDataAndShowScreening = fn;
}

function updateThresholdCompleteMessage(processedCount: number) {
    dom.thresholdCompleteMessage.textContent = t('llm_thresholdComplete', String(processedCount));
}

function clearThresholdConfirmationState() {
    state.setCurrentExecutionId('');
    state.setCurrentBatchDecisions([]);
    dom.thresholdCompleteMessage.textContent = '';
    dom.thresholdSection.classList.add('hidden');
}

async function restorePendingExecution(exec: LlmExecution) {
    const spreadsheetId = state.spreadsheetId;
    const pendingDecisions = await getLlmPendingDecisions(spreadsheetId, exec.execution_id);

    if (pendingDecisions.length === 0) {
        throw new Error(t('llm_historyPendingLoadError'));
    }

    state.setCurrentExecutionId(exec.execution_id);
    state.setCurrentBatchDecisions(pendingDecisions.map(({ decision }) => decision));
    updateThresholdCompleteMessage(pendingDecisions.length);
    handleThresholdChange();
    dom.thresholdSection.classList.remove('hidden');
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
        showToast(t('llm_apiKeyRequired'));
        return;
    }

    const screeningPrompt = dom.screeningPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    if (!screeningPrompt) {
        showToast(t('llm_screeningPromptRequired'));
        return;
    }

    // 対象文献を取得（全件）
    const targetRefs = state.references;

    if (targetRefs.length === 0) {
        showToast(t('llm_batchNoTarget'));
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
    state.setCurrentExecutionId('');
    state.setCurrentBatchDecisions([]);
    dom.thresholdCompleteMessage.textContent = '';

    try {
        const saveBatchSize = Math.max(parseInt(dom.batchSaveSizeInput.value, 10) || 5, 1);
        const spreadsheetId = state.spreadsheetId;
        const llmConfig = state.llmConfig;

        // API tierに基づいてレート制限を設定
        const tier = await getApiTier();
        const rateLimitConfig: RateLimitConfig = tier === 'free' ? RATE_LIMIT_FREE : RATE_LIMIT_PAID;

        if (tier === 'free') {
            showToast(t('llm_freeTierBatchWarning'), 4000);
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
            dom.retryFailedBtn.textContent = t('llm_retryBtn', String(result.failedRefIds.length));
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

            updateThresholdCompleteMessage(result.successCount);
            dom.thresholdSection.classList.remove('hidden');

            // 閾値プレビューを更新
            handleThresholdChange();
        }
    } catch (error) {
        console.error('[handleStartBatch] Error:', error);
        showToast(t('llm_batchError', (error as Error).message));
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
        showToast(t('llm_batchStopped'));
    }
}

/**
 * 失敗した件をリトライ
 */
export async function handleRetryFailed() {
    const failedRefIds = state.failedRefIds;
    if (failedRefIds.length === 0) {
        showToast(t('llm_retryNoTarget'));
        return;
    }

    // 失敗したref_idに対応する文献を取得
    const targetRefs = state.references.filter(r => failedRefIds.includes(r.ref_id));
    if (targetRefs.length === 0) {
        showToast(t('llm_retryNoRefs'));
        return;
    }

    showToast(t('llm_retrying', String(targetRefs.length)));

    // リトライボタンを非表示にしてから再処理
    dom.retryFailedBtn.classList.add('hidden');
    state.clearFailedRefIds();

    // 通常のバッチ処理と同様に処理
    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast(t('llm_apiKeyRequired'));
        return;
    }

    const screeningPrompt = dom.screeningPromptInput.value.trim();
    if (!screeningPrompt) {
        showToast(t('llm_screeningPromptRequired'));
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
            dom.retryFailedBtn.textContent = t('llm_retryBtn', String(result.failedRefIds.length));
            dom.retryFailedBtn.classList.remove('hidden');
            showToast(t('llm_retryPartial', [String(result.successCount), String(result.failCount)]));
        } else {
            showToast(t('llm_retryComplete', String(result.successCount)));
        }

        // 閾値プレビューを更新
        handleThresholdChange();
    } catch (error) {
        console.error('[handleRetryFailed] Error:', error);
        showToast(t('llm_retryError', (error as Error).message));
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
        count.textContent = t('common_countItems', String(bin.count));

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
        showToast(t('llm_thresholdMissingId'));
        return;
    }

    try {
        dom.confirmThresholdBtn.disabled = true;
        showToast(t('common_saving'));

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
            dom.executionHistory.innerHTML = `<p class="placeholder-text">${t('llm_historyEmpty')}</p>`;
            clearThresholdConfirmationState();
            return;
        }

        dom.executionHistory.innerHTML = '';

        // 新しい順にソート
        const sorted = [...executions].sort((a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const pendingExecutions = sorted.filter(
            exec => exec.execution_type === 'batch_screening' && exec.status === 'pending'
        );

        for (const exec of sorted.slice(0, 10)) {
            const item = document.createElement('div');
            item.className = `execution-item ${exec.status === 'pending' ? 'pending' : 'confirmed'}`;

            const date = new Date(exec.timestamp);
            const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

            const typeLabel = exec.execution_type === 'batch_screening' ? t('llm_historyBatch') : t('llm_historyCriteria');
            const statusLabel = exec.status === 'pending' ? `<span class="execution-status pending">${t('llm_historyPending')}</span>` : '';

            // pending状態では閾値・件数を非表示
            const statsContent = exec.status === 'pending'
                ? t('llm_historyPendingStats', String(exec.target_count))
                : t('llm_historyConfirmedStats', [String(exec.target_count), String(exec.include_count), String(exec.exclude_count), exec.include_threshold.toFixed(2)]);

            // チェックボックス（batch_screening かつ confirmed のみ）
            const actionHtml = exec.status === 'pending' && exec.execution_type === 'batch_screening'
                ? `<button type="button" class="btn btn-outline btn-small execution-resume-btn"
                            data-execution-id="${exec.execution_id}">
                        ${t('llm_historyResumePending')}
                   </button>`
                : exec.status === 'confirmed' && exec.execution_type === 'batch_screening'
                    ? `<label class="execution-active-label">
                     <input type="checkbox" class="execution-active-checkbox" 
                            data-execution-id="${exec.execution_id}" 
                            ${exec.is_active ? 'checked' : ''}>
                     ${t('llm_historyUseDecision')}
                   </label>`
                    : '';

            item.innerHTML = `
                <div class="execution-header">
                    <div class="execution-date">
                        <span class="execution-type">${typeLabel}</span>
                        ${statusLabel}
                        ${dateStr}
                    </div>
                    ${actionHtml}
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
                        showToast(checkbox.checked ? t('llm_historyActivated') : t('llm_historyDeactivated'));
                    } catch (error) {
                        console.error('[loadExecutionHistory] Failed to update is_active:', error);
                        showToast(t('llm_historyUpdateFailed'));
                        checkbox.checked = !checkbox.checked; // ロールバック
                    }
                });
            }

            const resumeButton = item.querySelector('.execution-resume-btn') as HTMLButtonElement | null;
            if (resumeButton) {
                resumeButton.addEventListener('click', async () => {
                    try {
                        await restorePendingExecution(exec);
                        showToast(t('llm_historyResumeLoaded'));
                    } catch (error) {
                        console.error('[loadExecutionHistory] Failed to restore pending execution:', error);
                        showToast(t('llm_historyPendingLoadError'));
                    }
                });
            }

            dom.executionHistory.appendChild(item);
        }

        if (pendingExecutions.length === 0) {
            clearThresholdConfirmationState();
            return;
        }

        const pendingExecutionIds = new Set(pendingExecutions.map(exec => exec.execution_id));
        const shouldRestoreLatestPending =
            state.currentBatchDecisions.length === 0 ||
            !pendingExecutionIds.has(state.currentExecutionId);

        if (shouldRestoreLatestPending) {
            try {
                await restorePendingExecution(pendingExecutions[0]);
            } catch (error) {
                console.error('[loadExecutionHistory] Failed to auto-restore pending execution:', error);
                clearThresholdConfirmationState();
                showToast(t('llm_historyPendingLoadError'));
            }
        }
    } catch (error) {
        console.error('[loadExecutionHistory] Error:', error);
    }
}
