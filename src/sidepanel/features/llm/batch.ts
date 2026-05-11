/**
 * LLMバッチ処理モジュール
 * バッチ処理実行、閾値調整、実行履歴管理
 */

import { dom } from '../../dom';
import { state } from '../../state';
import type { LlmBatchProgress, Decision, BatchProfile, LlmRun } from '../../../lib/types';
import { BATCH_PROFILES, getBatchProfile } from '../../../lib/types';
import {
    appendDecisions,
    getDecisionsByReviewerId,
    updateDecisionsBatch,
    saveLlmExecution,
    getLlmExecutions,
    updateLlmExecution,
    updateLlmConfig,
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    getLlmRuns,
    saveLlmRun,
    updateLlmRun,
    setSingleActiveRun,
    getRunForBatchId,
    getBatchIdsForRun,
    findRunByConfigHash,
} from '../../../lib/sheets-api';
import { computeConfigHash } from '../../../lib/llm-config-hash';
import { getEffectiveApiKey, getManualTier } from '../../../lib/storage';
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
import {
    setActiveLlmExecutionIds as syncSetActiveLlmExecutionIds,
    setReferences as syncSetReferences,
} from '../../store/compat';
import { getAssignedSetsForUser, getReferenceAssignmentSet } from '../assignment';

// loadDataAndShowScreeningへの参照（循環依存回避）
let _loadDataAndShowScreening: (() => Promise<void>) | null = null;

export function setLoadDataAndShowScreening(fn: () => Promise<void>) {
    _loadDataAndShowScreening = fn;
}

/**
 * 現在の手動 tier 設定とモデル ID からバッチ実行プロファイルを取得
 * 未設定の場合は安全側で tier1 を採用
 * モデル別に上書きがある場合はそちら（例: gemini-2.5-flash-lite は高並列）を優先
 */
async function resolveBatchProfile(modelId?: string): Promise<BatchProfile> {
    const manualTier = (await getManualTier()) || 'tier1';
    return getBatchProfile(manualTier, modelId);
}

/**
 * 履歴 UI で「使用中」マークを付ける Batch ID を決める。
 * Run/Batch 分離後は active Run 配下の最新 Batch を選ぶ。
 * （Run 配下に複数 Batch がある場合、ラジオは1つしか checked にできないため）
 */
function getSelectedActiveExecutionId(
    executions: Awaited<ReturnType<typeof getLlmExecutions>>,
    runs: LlmRun[]
): string | null {
    const activeRun = runs.find(r => r.is_active && r.status === 'confirmed');
    if (!activeRun) return null;

    const activeBatches = executions
        .filter(e => e.execution_type === 'batch_screening' && e.run_id === activeRun.run_id)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return activeBatches[0]?.execution_id ?? null;
}

/**
 * 閾値再調整 UI に表示する初期値を、Batch が属する Run から取得する。
 * Run が confirmed なら Run の値を、なければ project の default を使う。
 */
function getThresholdForAdjustment(
    exec: Awaited<ReturnType<typeof getLlmExecutions>>[number],
    runs: LlmRun[]
): number {
    const run = exec.run_id ? runs.find(r => r.run_id === exec.run_id) : undefined;
    if (run && run.status === 'confirmed') {
        return run.include_threshold;
    }

    const configuredThreshold = state.llmConfig?.llm_include_threshold;
    return typeof configuredThreshold === 'number' ? configuredThreshold : 0.3;
}

async function prepareThresholdAdjustment(executionId: string, threshold: number, targetCount: number): Promise<void> {
    const spreadsheetId = state.spreadsheetId;

    // Run/Batch 分離後、閾値は Run 単位で適用される。プレビューも Run 配下の
    // 全 Batch を合算して表示する（confirm 時の挙動と整合させる）
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
    state.setCurrentBatchDecisions(allDecisions);

    dom.thresholdSlider.value = threshold.toFixed(2);
    dom.thresholdValueDisplay.textContent = threshold.toFixed(2);
    dom.thresholdCompleteMessage.textContent = t('llm_thresholdAdjustLoaded', String(targetCount));
    dom.thresholdSection.classList.remove('hidden');

    handleThresholdChange();
    dom.thresholdSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * UI のラジオから受け取った Batch ID を、その Batch が属する Run の active 化に変換する。
 * Run/Batch 分離後、active 状態は Run 単位でのみ管理される。
 */
async function setSingleActiveExecution(spreadsheetId: string, selectedExecutionId: string): Promise<void> {
    const run = await getRunForBatchId(spreadsheetId, selectedExecutionId);
    if (!run) {
        console.warn('[setSingleActiveExecution] Run not found for batch:', selectedExecutionId);
        return;
    }
    await setSingleActiveRun(spreadsheetId, run.run_id);
}

/**
 * LLM バッチの対象となる文献かどうか判定
 * - 自分が未判定 (status === 'pending')
 * - かつ いずれの LLM 実行でもまだ判定されていない（pending/confirmed/inactive いずれも除外）
 *   → 同一文献を別バッチで再処理してAPI呼び出しが無駄になるのを防ぐ
 */
function isBatchEligible(ref: { status: string; hasAnyLlmDecision?: boolean }): boolean {
    return ref.status === 'pending' && !ref.hasAnyLlmDecision;
}

/**
 * バッチ実行直後に references を再読込してUIカウントを最新化する
 * - 画面遷移は行わず、データだけ更新する
 * - 担当割当（assignment）のフィルタは初期読み込み時と同じ条件で適用する
 */
async function refreshReferencesAfterBatch(spreadsheetId: string): Promise<void> {
    try {
        const userEmail = state.userEmail;
        const isKeyOpened = state.isKeyOpened;
        const refs = isKeyOpened
            ? await getReferencesWithAllDecisions(spreadsheetId, userEmail)
            : await getReferencesWithStatus(spreadsheetId, userEmail);

        // 管理者でなく担当割当が configured の場合のみ自分の担当セットで絞り込む
        // （loadDataAndShowScreening の initializeAssignmentState と同じロジック）
        const visibleRefs = (() => {
            if (state.isAdmin) return refs;
            const config = state.assignmentConfig;
            if (config.status !== 'configured') return refs;
            const assignedSets = getAssignedSetsForUser(config, userEmail);
            return refs.filter((ref) => assignedSets.has(getReferenceAssignmentSet(ref)));
        })();

        syncSetReferences(visibleRefs);
        updateBatchTargetCount();
    } catch (error) {
        console.error('[refreshReferencesAfterBatch] Failed to reload references:', error);
    }
}

/**
 * バッチ対象件数を更新
 */
export function updateBatchTargetCount() {
    const eligibleCount = state.references.filter(isBatchEligible).length;
    dom.batchTargetCount.textContent = eligibleCount.toString();

    const maxCountRaw = dom.batchMaxCountSelect.value;
    const plannedCount = maxCountRaw === 'all'
        ? eligibleCount
        : Math.min(eligibleCount, Math.max(parseInt(maxCountRaw, 10) || 100, 1));
    dom.batchPlannedCount.textContent = plannedCount.toString();
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

    // 対象文献を取得（未判定 かつ LLM 未判定のみ・件数上限を適用）
    const eligibleRefs = state.references.filter(isBatchEligible);
    const maxCountRaw = dom.batchMaxCountSelect.value;
    const targetRefs = maxCountRaw === 'all'
        ? eligibleRefs
        : eligibleRefs.slice(0, Math.max(parseInt(maxCountRaw, 10) || 100, 1));

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

    try {
        // 選択されたモデルの設定を取得（モデル ID はプロファイル解決にも使う）
        const modelConfig = getModelConfig(dom.llmModelSelect.value);

        const profile = await resolveBatchProfile(modelConfig.model);
        const spreadsheetId = state.spreadsheetId;
        const llmConfig = state.llmConfig;

        if (profile === BATCH_PROFILES.free) {
            showToast(t('llm_freeTierBatchWarning'), 4000);
        }

        // Run 解決: 同一設定の既存 Run があれば再利用、なければ新規作成
        // confirmed Run なら閾値を即時適用し、閾値確認 UI をスキップする
        const configHash = await computeConfigHash({
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            topP: modelConfig.topP,
            thinkingLevel: modelConfig.thinkingLevel,
            criteria_snapshot: llmConfig.llm_criteria,
            screening_prompt: screeningPrompt,
        });

        const matchedRun = await findRunByConfigHash(spreadsheetId, configHash);
        const isImmediate = matchedRun?.status === 'confirmed';
        const runThreshold = isImmediate ? matchedRun!.include_threshold : null;

        let runId: string;
        if (matchedRun) {
            runId = matchedRun.run_id;
        } else {
            runId = crypto.randomUUID();
            const newRun: LlmRun = {
                run_id: runId,
                config_hash: configHash,
                created_at: new Date().toISOString(),
                model: modelConfig.model,
                temperature: modelConfig.temperature,
                topP: modelConfig.topP,
                thinkingLevel: modelConfig.thinkingLevel,
                criteria_snapshot: llmConfig.llm_criteria,
                screening_prompt: screeningPrompt,
                include_threshold: typeof llmConfig.llm_include_threshold === 'number'
                    ? llmConfig.llm_include_threshold
                    : 0.3,
                status: 'pending',
                is_active: false,
            };
            await saveLlmRun(spreadsheetId, newRun);
        }

        const result = await processBatch(targetRefs, {
            batchSize: profile.saveBatchSize,
            screeningPrompt,
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            topP: modelConfig.topP,
            thinkingLevel: modelConfig.thinkingLevel,

            outputLanguage: dom.llmLanguageSelect.value,
            rateLimitConfig: profile.rate,
            abortSignal: abortController.signal,
            onProgress: updateBatchProgress,
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                const currentDecisions = state.currentBatchDecisions;
                state.setCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
            // confirmed Run 配下のバッチは保存時点で include/exclude を確定させる
            applyThreshold: runThreshold ?? undefined,
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
            // Batch row を保存。
            // Run/Batch 分離後は閾値・status・is_active は LLM_Runs 側を正とするため、
            // LLM_Executions 側の値は固定値（threshold=0, status='pending', is_active=false）で
            // 書き込み、読み取り時は無視される。
            const execution = createLlmExecution(
                result.executionId,
                'batch_screening',
                modelConfig.model,
                llmConfig.llm_criteria,
                dom.screeningPromptInput.value,
                0,
                result.processedCount,
                0,
                0,
                'pending',
                false,
                modelConfig.temperature,
                modelConfig.topP,
                modelConfig.thinkingLevel
            );
            execution.run_id = runId;
            await saveLlmExecution(spreadsheetId, execution);

            // confirmed Run なら、Run を active 化して閾値 UI を出さない
            if (isImmediate && runThreshold !== null) {
                const counts = previewThresholdCounts(state.currentBatchDecisions, runThreshold);
                await setSingleActiveRun(spreadsheetId, runId);
                showToast(
                    t('llm_thresholdAutoApplied', [String(counts.includeCount), String(counts.excludeCount)]),
                    4000
                );
                console.log('[handleStartBatch] Auto-applied confirmed Run threshold:', {
                    runId,
                    threshold: runThreshold,
                    counts,
                });
            } else {
                // pending Run: 従来通り閾値確認 UI を出す
                // 既存 pending Run を再利用する場合は前回の閾値をスライダー初期値として復元
                if (matchedRun) {
                    const initial = matchedRun.include_threshold;
                    if (typeof initial === 'number' && Number.isFinite(initial)) {
                        dom.thresholdSlider.value = initial.toFixed(2);
                        dom.thresholdValueDisplay.textContent = initial.toFixed(2);
                    }
                }
                dom.thresholdCompleteMessage.textContent = result.fallbackCount > 0
                    ? t('llm_thresholdCompleteWithFallback', [String(result.processedCount), String(result.fallbackCount)])
                    : t('llm_thresholdComplete', String(result.successCount));
                dom.thresholdSection.classList.remove('hidden');
                handleThresholdChange();
            }

            // 履歴を再読み込み
            await loadExecutionHistory();

            // フォールバック発生時はトーストでも明示
            if (result.fallbackCount > 0) {
                showToast(t('llm_batchFallbackNotice', String(result.fallbackCount)), 6000);
            }
        }
    } catch (error) {
        console.error('[handleStartBatch] Error:', error);
        showToast(t('llm_batchError', (error as Error).message));
    } finally {
        dom.startBatchBtn.classList.remove('hidden');
        dom.stopBatchBtn.classList.add('hidden');
        state.setBatchAbortController(null);
        // バッチで判定済みになった文献を「未判定」カウントから除外するため再読込
        // （中断・エラー時も部分的に保存されている可能性があるので必ず実行）
        await refreshReferencesAfterBatch(state.spreadsheetId);
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
        const modelId = dom.llmModelSelect.value;
        const profile = await resolveBatchProfile(modelId);
        const spreadsheetId = state.spreadsheetId;

        const result = await processBatch(targetRefs, {
            batchSize: profile.saveBatchSize,
            screeningPrompt,
            model: modelId,
            temperature: 0,

            outputLanguage: dom.llmLanguageSelect.value,
            rateLimitConfig: profile.rate,
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
            showToast(t('llm_retryPartial', [String(result.successCount), String(result.failCount + result.fallbackCount)]));
        } else {
            showToast(t('llm_retryComplete', String(result.successCount)));
        }

        if (result.fallbackCount > 0) {
            showToast(t('llm_batchFallbackNotice', String(result.fallbackCount)), 6000);
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
        await refreshReferencesAfterBatch(state.spreadsheetId);
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
    dom.batchFallbackCount.textContent = progress.parseErrorFallback.toString();
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

/**
 * 実行履歴を読み込み
 */
export async function loadExecutionHistory() {
    const spreadsheetId = state.spreadsheetId;

    try {
        const [executions, runs] = await Promise.all([
            getLlmExecutions(spreadsheetId),
            getLlmRuns(spreadsheetId),
        ]);
        const selectedActiveExecutionId = getSelectedActiveExecutionId(executions, runs);

        console.log('[loadExecutionHistory] executions:', executions.map(e => ({
            id: e.execution_id,
            status: e.status,
            is_active: e.is_active,
            type: e.execution_type,
            run_id: e.run_id,
        })));

        // active Run 配下の全 Batch IDs を「LLM 判定として有効」としてキャッシュ
        const activeRun = runs.find(r => r.is_active && r.status === 'confirmed');
        const activeBatchIds = activeRun
            ? new Set(
                executions
                    .filter(e => e.execution_type === 'batch_screening' && e.run_id === activeRun.run_id)
                    .map(e => e.execution_id)
              )
            : new Set<string>();
        syncSetActiveLlmExecutionIds(activeBatchIds);

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
            // batch_screening の場合は所属 Run のメタ情報を反映する。
            // Run/Batch 分離後、status/include_threshold は Run 側を正とするため、
            // Batch 行の同名フィールドは表示用にオーバーライドする。
            const run = exec.run_id ? runs.find(r => r.run_id === exec.run_id) : undefined;
            const effectiveStatus: 'pending' | 'confirmed' = exec.execution_type === 'batch_screening'
                ? (run?.status ?? exec.status)
                : exec.status;
            const effectiveThreshold = run?.include_threshold ?? exec.include_threshold;
            const hasLegacyCounts = (exec.include_count ?? 0) + (exec.exclude_count ?? 0) > 0;

            const item = document.createElement('div');
            item.className = `execution-item ${effectiveStatus === 'pending' ? 'pending' : 'confirmed'}`;

            const date = new Date(exec.timestamp);
            const dateStr = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;

            const typeLabel = exec.execution_type === 'batch_screening' ? t('llm_historyBatch') : t('llm_historyCriteria');
            const statusLabel = effectiveStatus === 'pending' ? `<span class="execution-status pending">${t('llm_historyPending')}</span>` : '';

            // pending状態では閾値・件数を非表示
            // confirmed でも Run 移行後の新規 Batch は件数を保持しないため、
            // legacy データのみ件数を表示する
            const statsContent = effectiveStatus === 'pending' || !hasLegacyCounts
                ? t('llm_historyPendingStats', String(exec.target_count))
                : t('llm_historyConfirmedStats', [String(exec.target_count), String(exec.include_count), String(exec.exclude_count), effectiveThreshold.toFixed(2)]);

            // ラジオボタン（batch_screening かつ confirmed のみ、単一選択）
            const radioHtml = effectiveStatus === 'confirmed' && exec.execution_type === 'batch_screening'
                ? `<label class="execution-active-label">
                     <input type="radio" class="execution-active-checkbox"
                            name="active-llm-execution"
                            data-execution-id="${exec.execution_id}"
                            ${exec.execution_id === selectedActiveExecutionId ? 'checked' : ''}>
                     ${t('llm_historyUseDecision')}
                   </label>`
                : '';

            const canAdjustThreshold = exec.execution_type === 'batch_screening'
                && (effectiveStatus === 'pending' || effectiveStatus === 'confirmed');
            const adjustButtonLabel = effectiveStatus === 'pending'
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
            // クリック時は Batch の所属 Run を active 化し、同 Run 配下の全 Batch IDs を
            // 「LLM 判定として有効」としてキャッシュに反映する
            const radio = item.querySelector('.execution-active-checkbox') as HTMLInputElement | null;
            if (radio) {
                radio.addEventListener('change', async () => {
                    if (!radio.checked) {
                        return;
                    }

                    try {
                        await setSingleActiveExecution(spreadsheetId, exec.execution_id);
                        const newActiveRun = exec.run_id ? runs.find(r => r.run_id === exec.run_id) : undefined;
                        const newActiveBatchIds = newActiveRun
                            ? new Set(
                                executions
                                    .filter(e => e.execution_type === 'batch_screening' && e.run_id === newActiveRun.run_id)
                                    .map(e => e.execution_id)
                              )
                            : new Set([exec.execution_id]);
                        syncSetActiveLlmExecutionIds(newActiveBatchIds);
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
                        await prepareThresholdAdjustment(exec.execution_id, getThresholdForAdjustment(exec, runs), exec.target_count);
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
