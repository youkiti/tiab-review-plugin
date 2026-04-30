/**
 * LLMバッチ処理モジュール
 * バッチ処理実行、閾値調整、実行履歴管理
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmBatchProgress, Decision, RateLimitConfig, LlmFailure } from '../../../lib/types';
import { RATE_LIMIT_FREE, RATE_LIMIT_PAID } from '../../../lib/types';
import {
    appendDecisions,
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    upsertLlmExecution,
    appendLlmFailures,
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
import { setActiveLlmExecutionIds as syncSetActiveLlmExecutionIds } from '../../store/compat';

// loadDataAndShowScreeningへの参照（循環依存回避）
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    _loadDataAndShowScreening = fn;
}

function getSelectedActiveExecutionId(executions: Awaited<ReturnType<typeof getLlmExecutions>>): string | null {
    const activeBatchExecutions = executions
        .filter(exec => exec.execution_type === 'batch_screening' && exec.status === 'confirmed' && exec.is_active)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return activeBatchExecutions[0]?.execution_id ?? null;
}

function getThresholdForAdjustment(exec: Awaited<ReturnType<typeof getLlmExecutions>>[number]): number {
    if (exec.status === 'confirmed') {
        return exec.include_threshold;
    }

    const configuredThreshold = state.llmConfig?.llm_include_threshold;
    return typeof configuredThreshold === 'number' ? configuredThreshold : 0.3;
}

async function prepareThresholdAdjustment(executionId: string, threshold: number, targetCount: number): Promise<void> {
    const spreadsheetId = state.spreadsheetId;
    const existingDecisions = await getDecisionsByReviewerId(spreadsheetId, executionId);

    if (existingDecisions.length === 0) {
        throw new Error(t('llm_thresholdAdjustNoDecisions'));
    }

    state.setCurrentExecutionId(executionId);
    state.setCurrentBatchDecisions(existingDecisions.map(({ decision }) => decision));

    dom.thresholdSlider.value = threshold.toFixed(2);
    dom.thresholdValueDisplay.textContent = threshold.toFixed(2);
    dom.thresholdCompleteMessage.textContent = t('llm_thresholdAdjustLoaded', String(targetCount));
    dom.thresholdSection.classList.remove('hidden');

    handleThresholdChange();
    dom.thresholdSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function setSingleActiveExecution(spreadsheetId: string, selectedExecutionId: string): Promise<void> {
    const executions = await getLlmExecutions(spreadsheetId);
    const targetExecutions = executions.filter(exec =>
        exec.execution_type === 'batch_screening' && exec.status === 'confirmed'
    );

    for (const exec of targetExecutions) {
        const shouldBeActive = exec.execution_id === selectedExecutionId;
        if (exec.is_active !== shouldBeActive) {
            await updateLlmExecution(spreadsheetId, exec.execution_id, {
                is_active: shouldBeActive,
            });
        }
    }
}

/**
 * バッチ対象件数を更新
 *
 * 'pending' (＝自分が未判定) のみを対象として表示する。
 * 旧実装は state.references.length をそのまま表示していたため、
 * 既判定文献を含めた全件数を「未判定」と誤表示していた。
 */
export function updateBatchTargetCount() {
    const pendingCount = countPendingReferences();
    dom.batchTargetCount.textContent = pendingCount.toString();
}

/**
 * 自分が未判定の文献数を返す。
 * バッチ処理／UI 表示の真の対象母数。
 */
function countPendingReferences(): number {
    return state.references.filter((r) => r.status === 'pending').length;
}

/**
 * 失敗 N 件の表示状態を更新する。
 * N>0 なら「リトライ」と「諦めて閾値へ」の両ボタンを表示、
 * N=0 なら両方とも非表示にする。
 */
function updateFailureButtons(failedCount: number): void {
    if (failedCount > 0) {
        dom.retryFailedBtn.textContent = t('llm_retryBtn', String(failedCount));
        dom.retryFailedBtn.classList.remove('hidden');
        if (dom.skipFailedBtn) {
            dom.skipFailedBtn.textContent = t('llm_skipFailedBtn', String(failedCount));
            dom.skipFailedBtn.classList.remove('hidden');
        }
    } else {
        dom.retryFailedBtn.classList.add('hidden');
        dom.skipFailedBtn?.classList.add('hidden');
    }
}

/**
 * currentBatchDecisions に新規 decisions をマージ（ref_id で dedupe、後勝ち）。
 * リトライ時に旧失敗→新成功で同じ ref_id が来てもプレビュー数が二重カウント
 * されないようにする。
 */
function mergeBatchDecisions(existing: Decision[], incoming: Decision[]): Decision[] {
    const map = new Map<string, Decision>();
    for (const d of existing) {
        map.set(d.ref_id, d);
    }
    for (const d of incoming) {
        map.set(d.ref_id, d);
    }
    return Array.from(map.values());
}

/**
 * 進行中／未確定のバッチ実行があるかを判定。
 * 'running' (まだ走っている) または 'pending' (実行は終わったが閾値未確定) を抽出する。
 */
async function findUnfinishedBatchExecutions(spreadsheetId: string) {
    const executions = await getLlmExecutions(spreadsheetId);
    return executions.filter(
        (e) => e.execution_type === 'batch_screening'
            && (e.status === 'running' || e.status === 'pending')
    );
}

/**
 * バッチ処理を開始
 *
 * 動作:
 *  - 進行中／未確定の execution が既にある場合はユーザーに警告ダイアログ。
 *  - 開始時に LLM_Executions へ status='running' で即座に upsert。
 *    これによりタブを閉じてもジョブの存在が永続化され、後から再開・削除が可能。
 *  - currentBatchDecisions は ref_id で dedupe しながら追加。
 *  - 失敗 ref は LLM_Failures シートにエラーメッセージ込みで記録。
 *  - 全 batch 完了後に status='pending' に更新（閾値未確定状態）。
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

    const spreadsheetId = state.spreadsheetId;

    // 進行中／未確定の execution があれば確認ダイアログ
    try {
        const unfinished = await findUnfinishedBatchExecutions(spreadsheetId);
        if (unfinished.length > 0 && !confirm(t('llm_batchUnfinishedConfirm', String(unfinished.length)))) {
            return;
        }
    } catch (e) {
        // 取得失敗は致命的ではないため警告のみ出して続行
        console.warn('[handleStartBatch] Failed to check unfinished executions:', e);
    }

    // 対象文献は「自分が未判定」のものに限定。既判定の重複処理を防ぐ。
    const targetRefs = state.references.filter((r) => r.status === 'pending');

    if (targetRefs.length === 0) {
        showToast(t('llm_batchNoTarget'));
        return;
    }

    // UI更新
    dom.startBatchBtn.classList.add('hidden');
    dom.stopBatchBtn.classList.remove('hidden');
    dom.batchProgressDiv.classList.remove('hidden');
    dom.thresholdSection.classList.add('hidden');
    dom.thresholdCompleteMessage.textContent = '';

    // AbortControllerを作成
    const abortController = new AbortController();
    state.setBatchAbortController(abortController);
    state.setCurrentBatchDecisions([]);
    state.clearFailedRefIds();

    let executionId = '';

    try {
        const saveBatchSize = Math.max(parseInt(dom.batchSaveSizeInput.value, 10) || 5, 1);
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
            // 開始時に running として即時登録（拡張機能を閉じても痕跡が残る）
            onStart: async (newExecutionId, total) => {
                executionId = newExecutionId;
                state.setCurrentExecutionId(newExecutionId);
                const exec = createLlmExecution(
                    newExecutionId,
                    'batch_screening',
                    modelConfig.model,
                    llmConfig.llm_criteria,
                    dom.screeningPromptInput.value,
                    0,
                    total,
                    0,
                    0,
                    'running',
                    true,
                    modelConfig.temperature,
                    modelConfig.topP,
                    modelConfig.thinkingLevel
                );
                await upsertLlmExecution(spreadsheetId, exec);
            },
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                state.setCurrentBatchDecisions(
                    mergeBatchDecisions(state.currentBatchDecisions, decisions)
                );
            },
            onRefFailed: async (refId, errorMessage) => {
                if (!executionId) return;
                const failure: LlmFailure = {
                    execution_id: executionId,
                    ref_id: refId,
                    failed_at: new Date().toISOString(),
                    error_message: errorMessage,
                    model: modelConfig.model,
                };
                try {
                    await appendLlmFailures(spreadsheetId, [failure]);
                } catch (e) {
                    console.warn('[handleStartBatch] Failed to log LLM failure:', e);
                }
            },
        });

        state.setCurrentExecutionId(result.executionId);

        // 失敗したref_idを保存
        state.setFailedRefIds(result.failedRefIds);

        // 失敗があればリトライボタン + スキップボタンを表示
        updateFailureButtons(result.failedRefIds.length);

        // 完了後のUI更新
        if (!abortController.signal.aborted) {
            // running -> pending に遷移
            await updateLlmExecution(spreadsheetId, result.executionId, {
                status: 'pending',
                target_count: result.processedCount,
            });

            // 履歴を再読み込み
            await loadExecutionHistory();

            dom.thresholdCompleteMessage.textContent = t('llm_thresholdComplete', String(result.successCount));
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
 *
 * 動作:
 *  - 既存の executionId を引き継ぐため、Decisions / LLM_Executions / LLM_Failures
 *    すべて元のジョブと同一 ID で記録される（孤児行が出ない）。
 *  - currentBatchDecisions は ref_id で dedupe しながら追加。
 *  - リトライで成功した ref については LLM_Failures に過去の失敗行が残るが、
 *    Decisions シートの方に成功 row が追加されるため判定上の問題はない。
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

    const existingExecutionId = state.currentExecutionId;
    if (!existingExecutionId) {
        // 過去 run の executionId が分からないとリトライしても孤児が増えるだけなので拒否
        showToast(t('llm_retryNoExecutionId'));
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
            existingExecutionId,
            onProgress: updateBatchProgress,
            onStart: async () => {
                // status を 'running' に戻す（再開中であることを示す）
                try {
                    await updateLlmExecution(spreadsheetId, existingExecutionId, { status: 'running' });
                } catch (e) {
                    console.warn('[handleRetryFailed] Failed to mark running:', e);
                }
            },
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                state.setCurrentBatchDecisions(
                    mergeBatchDecisions(state.currentBatchDecisions, decisions)
                );
            },
            onRefFailed: async (refId, errorMessage) => {
                const failure: LlmFailure = {
                    execution_id: existingExecutionId,
                    ref_id: refId,
                    failed_at: new Date().toISOString(),
                    error_message: errorMessage,
                    model: modelConfig.model,
                };
                try {
                    await appendLlmFailures(spreadsheetId, [failure]);
                } catch (e) {
                    console.warn('[handleRetryFailed] Failed to log LLM failure:', e);
                }
            },
        });

        // リトライ結果を更新
        state.setFailedRefIds(result.failedRefIds);

        // running -> pending に戻す
        if (!abortController.signal.aborted) {
            try {
                await updateLlmExecution(spreadsheetId, existingExecutionId, { status: 'pending' });
            } catch (e) {
                console.warn('[handleRetryFailed] Failed to mark pending:', e);
            }
            await loadExecutionHistory();
        }

        updateFailureButtons(result.failedRefIds.length);
        if (result.failedRefIds.length > 0) {
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
 * 残った失敗をすべて諦めて閾値設定セクションに移行する。
 * 永続失敗で抜け出せないユーザー向けの脱出口。
 */
export async function handleSkipFailedAndProceed() {
    const failedRefIds = state.failedRefIds;
    if (failedRefIds.length === 0) {
        // 失敗なしならそのまま閾値セクションを開いて終わり
        dom.retryFailedBtn.classList.add('hidden');
        dom.thresholdSection.classList.remove('hidden');
        handleThresholdChange();
        return;
    }
    if (!confirm(t('llm_skipFailedConfirm', String(failedRefIds.length)))) {
        return;
    }
    state.clearFailedRefIds();
    dom.retryFailedBtn.classList.add('hidden');
    dom.skipFailedBtn?.classList.add('hidden');
    dom.thresholdSection.classList.remove('hidden');
    handleThresholdChange();
    showToast(t('llm_skipFailedDone', String(failedRefIds.length)));
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

        await setSingleActiveExecution(spreadsheetId, executionId);

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
        const selectedActiveExecutionId = getSelectedActiveExecutionId(executions);

        console.log('[loadExecutionHistory] executions:', executions.map(e => ({
            id: e.execution_id,
            status: e.status,
            is_active: e.is_active,
            type: e.execution_type,
        })));

        // 確定済みかつアクティブなLLM実行IDをキャッシュに保存
        syncSetActiveLlmExecutionIds(new Set(selectedActiveExecutionId ? [selectedActiveExecutionId] : []));

        if (executions.length === 0) {
            dom.executionHistory.innerHTML = `<p class="placeholder-text">${t('llm_historyEmpty')}</p>`;
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

            const typeLabel = exec.execution_type === 'batch_screening' ? t('llm_historyBatch') : t('llm_historyCriteria');
            const statusLabel = exec.status === 'pending' ? `<span class="execution-status pending">${t('llm_historyPending')}</span>` : '';

            // pending状態では閾値・件数を非表示
            const statsContent = exec.status === 'pending'
                ? t('llm_historyPendingStats', String(exec.target_count))
                : t('llm_historyConfirmedStats', [String(exec.target_count), String(exec.include_count), String(exec.exclude_count), exec.include_threshold.toFixed(2)]);

            // ラジオボタン（batch_screening かつ confirmed のみ、単一選択）
            const radioHtml = exec.status === 'confirmed' && exec.execution_type === 'batch_screening'
                ? `<label class="execution-active-label">
                     <input type="radio" class="execution-active-checkbox"
                            name="active-llm-execution"
                            data-execution-id="${exec.execution_id}" 
                            ${exec.execution_id === selectedActiveExecutionId ? 'checked' : ''}>
                     ${t('llm_historyUseDecision')}
                   </label>`
                : '';

            const canAdjustThreshold = exec.execution_type === 'batch_screening'
                && (exec.status === 'pending' || exec.status === 'confirmed');
            const adjustButtonLabel = exec.status === 'pending'
                ? t('llm_historySetThreshold')
                : t('llm_historyAdjustThreshold');
            const adjustButtonHtml = canAdjustThreshold
                ? `<button type="button" class="btn btn-outline btn-xsmall execution-adjust-btn" data-execution-id="${exec.execution_id}">
                     ${adjustButtonLabel}
                    </button>`
                : '';

            item.innerHTML = `
                <div class="execution-header">
                    <div class="execution-date">
                        <span class="execution-type">${typeLabel}</span>
                        ${statusLabel}
                        ${dateStr}
                    </div>
                    ${radioHtml}
                </div>
                <div class="execution-stats">
                    ${statsContent}
                </div>
                ${adjustButtonHtml}
            `;

            // ラジオボタンのイベントリスナー
            const radio = item.querySelector('.execution-active-checkbox') as HTMLInputElement | null;
            if (radio) {
                radio.addEventListener('change', async () => {
                    if (!radio.checked) {
                        return;
                    }

                    try {
                        await setSingleActiveExecution(spreadsheetId, exec.execution_id);
                        syncSetActiveLlmExecutionIds(new Set([exec.execution_id]));
                        showToast(t('llm_historyActivated'));
                        await loadExecutionHistory();
                    } catch (error) {
                        console.error('[loadExecutionHistory] Failed to update is_active:', error);
                        showToast(t('llm_historyUpdateFailed'));
                        await loadExecutionHistory();
                    }
                });
            }

            const adjustButton = item.querySelector('.execution-adjust-btn') as HTMLButtonElement | null;
            if (adjustButton) {
                adjustButton.addEventListener('click', async () => {
                    try {
                        await prepareThresholdAdjustment(exec.execution_id, getThresholdForAdjustment(exec), exec.target_count);
                        showToast(t('llm_thresholdAdjustReady'));
                    } catch (error) {
                        console.error('[loadExecutionHistory] Failed to prepare threshold adjustment:', error);
                        showToast((error as Error).message || t('llm_historyUpdateFailed'));
                    }
                });
            }

            dom.executionHistory.appendChild(item);
        }
    } catch (error) {
        console.error('[loadExecutionHistory] Error:', error);
    }
}
