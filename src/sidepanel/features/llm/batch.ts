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
import { showModal, hideModal } from '../ml/dialogs';
import { getEffectiveApiKey, getManualTier } from '../../../lib/storage';
import {
    processBatch,
    calculateProbabilityDistribution,
    previewThresholdCounts,
    applyThresholdToDecisions,
    createLlmExecution,
    generateLlmReviewerId,
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

    // 中断・エラー時にも finally で履歴行を実件数で更新するため、
    // try 開始前に execution_id を保持する変数を用意しておく
    let executionId: string | null = null;
    const spreadsheetId = state.spreadsheetId;

    try {
        // 選択されたモデルの設定を取得（モデル ID はプロファイル解決にも使う）
        const modelConfig = getModelConfig(dom.llmModelSelect.value);

        const profile = await resolveBatchProfile(modelConfig.model);
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

        // バッチ開始前に execution_id を生成し、Batch 行（LLM_Executions）を先書きする。
        // こうしておくと、最後の数件でリトライ失敗・Stop・サイドパネル閉鎖などが起きても
        // Decisions シートに書かれた LLM 判定が「Batch 行のない孤立データ」になるのを防げる。
        // Run/Batch 分離後は閾値・status・is_active は LLM_Runs 側が正なので、
        // ここでは固定値（threshold=0, status='pending', is_active=false）で書き、後段で読み飛ばされる。
        const timestamp = new Date();
        executionId = generateLlmReviewerId(modelConfig.model, timestamp);
        state.setCurrentExecutionId(executionId);

        const initialExecution = createLlmExecution(
            executionId,
            'batch_screening',
            modelConfig.model,
            llmConfig.llm_criteria,
            dom.screeningPromptInput.value,
            0,
            targetRefs.length,      // target_count は実件数で finally に再更新
            0,
            0,
            'pending',
            false,                  // Batch 行の is_active は Run 側が管理するため常に false
            modelConfig.temperature,
            modelConfig.topP,
            modelConfig.thinkingLevel,
        );
        // execution_id 内の timestamp とシート上の timestamp 列を揃えておく
        initialExecution.timestamp = timestamp.toISOString();
        initialExecution.run_id = runId;
        await saveLlmExecution(spreadsheetId, initialExecution);
        // 履歴UIに「pending」として即時反映
        await loadExecutionHistory();

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
            // 事前生成した execution_id / timestamp を共有させて、
            // Decisions 側の reviewer_id と LLM_Executions 側の execution_id を一致させる
            executionId,
            timestamp,
            onProgress: updateBatchProgress,
            onSaveBatch: async (decisions) => {
                await appendDecisions(spreadsheetId, decisions);
                const currentDecisions = state.currentBatchDecisions;
                state.setCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
            // confirmed Run 配下のバッチは保存時点で include/exclude を確定させる
            applyThreshold: runThreshold ?? undefined,
        });

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
            // Batch 行は pre-write 済みなのでここでの再保存は不要。
            // Run/Batch 分離後、閾値・status・is_active は LLM_Runs 側を正とする。

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

        // pre-write した履歴行の target_count を、実際に保存できた判定件数で更新する。
        // 中断・エラー・成功のいずれでもここに来るので、履歴行と Decisions シートの件数が
        // 食い違わないようにする最後の保険。失敗しても黙って続行する。
        if (executionId) {
            try {
                const savedCount = state.currentBatchDecisions.length;
                await updateLlmExecution(spreadsheetId, executionId, {
                    target_count: savedCount,
                });
                await loadExecutionHistory();
            } catch (err) {
                console.warn('[handleStartBatch] target_count update failed:', err);
            }
        }

        // バッチで判定済みになった文献を「未判定」カウントから除外するため再読込
        // （中断・エラー時も部分的に保存されている可能性があるので必ず実行）
        await refreshReferencesAfterBatch(spreadsheetId);
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
 * 日時を yyyy/m/d H:MM 形式にフォーマット
 */
function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Run のプロンプトと判定基準をモーダルで表示する。
 * プロンプト全文 + criteria_snapshot を表示し、コピーボタンを提供する。
 */
function openRunPromptModal(run: LlmRun): void {
    const body = document.createElement('div');
    body.className = 'run-prompt-modal';

    // 判定基準 (criteria_snapshot) があれば構造化表示
    if (run.criteria_snapshot) {
        const criteriaSection = document.createElement('section');
        criteriaSection.className = 'run-prompt-section';

        const criteriaTitle = document.createElement('h4');
        criteriaTitle.textContent = t('llm_historyPromptSectionCriteria');
        criteriaSection.appendChild(criteriaTitle);

        const templateLabel = document.createElement('div');
        templateLabel.className = 'run-prompt-criteria-template';
        templateLabel.textContent = run.criteria_snapshot.template;
        criteriaSection.appendChild(templateLabel);

        const fieldsTable = document.createElement('dl');
        fieldsTable.className = 'run-prompt-criteria-fields';
        const fields = run.criteria_snapshot.fields ?? {};
        for (const [key, value] of Object.entries(fields)) {
            const dt = document.createElement('dt');
            dt.textContent = key;
            const dd = document.createElement('dd');
            dd.textContent = value;
            fieldsTable.appendChild(dt);
            fieldsTable.appendChild(dd);
        }
        criteriaSection.appendChild(fieldsTable);
        body.appendChild(criteriaSection);
    }

    // プロンプト全文
    const promptSection = document.createElement('section');
    promptSection.className = 'run-prompt-section';

    const promptTitle = document.createElement('h4');
    promptTitle.textContent = t('llm_historyPromptSectionPrompt');
    promptSection.appendChild(promptTitle);

    const pre = document.createElement('pre');
    pre.className = 'run-prompt-text';
    pre.textContent = run.screening_prompt || '';
    promptSection.appendChild(pre);
    body.appendChild(promptSection);

    // フッター: コピー + 閉じる
    const footer = document.createElement('div');

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn-primary btn-small';
    copyBtn.textContent = t('llm_historyPromptCopyBtn');
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(run.screening_prompt || '');
            showToast(t('llm_historyPromptCopied'));
        } catch (error) {
            console.error('[openRunPromptModal] clipboard write failed:', error);
            showToast(t('llm_historyPromptCopyFailed'));
        }
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn btn-outline btn-small';
    closeBtn.textContent = t('llm_historyPromptClose');
    closeBtn.addEventListener('click', () => hideModal());

    footer.appendChild(copyBtn);
    footer.appendChild(closeBtn);

    showModal({
        title: t('llm_historyPromptTitle'),
        body,
        footer,
    });
}

/**
 * Run カードを生成して履歴コンテナに append する
 */
function appendRunCard(
    container: HTMLElement,
    spreadsheetId: string,
    run: LlmRun,
    batches: Awaited<ReturnType<typeof getLlmExecutions>>,
    isSelectedActive: boolean,
    onActivate: (runId: string) => Promise<void>
): void {
    // 配下バッチを timestamp 昇順に並べ、合計を集計
    const sortedBatches = [...batches].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const oldest = sortedBatches[0];
    const latest = sortedBatches[sortedBatches.length - 1];
    const totalRefs = sortedBatches.reduce((sum, b) => sum + (b.target_count ?? 0), 0);

    const card = document.createElement('div');
    card.className = `run-card ${run.status === 'pending' ? 'pending' : 'confirmed'}`;

    const dateRange = oldest.timestamp === latest.timestamp
        ? formatTimestamp(oldest.timestamp)
        : t('llm_historyRunDateRange', [formatTimestamp(oldest.timestamp), formatTimestamp(latest.timestamp)]);

    const typeBadge = `<span class="run-type-badge">${t('llm_historyRun')}</span>`;
    const statusLabel = run.status === 'pending'
        ? `<span class="execution-status pending">${t('llm_historyPending')}</span>`
        : '';

    const statsContent = run.status === 'pending'
        ? t('llm_historyRunStatsPending', [String(sortedBatches.length), String(totalRefs)])
        : t('llm_historyRunStatsConfirmed', [String(sortedBatches.length), String(totalRefs), run.include_threshold.toFixed(2)]);

    const radioHtml = run.status === 'confirmed'
        ? `<label class="execution-active-label">
             <input type="radio" class="run-active-radio"
                    name="active-llm-run"
                    data-run-id="${run.run_id}"
                    ${isSelectedActive ? 'checked' : ''}>
             ${t('llm_historyUseDecision')}
           </label>`
        : '';

    const adjustButtonLabel = run.status === 'pending'
        ? t('llm_historySetThreshold')
        : t('llm_historyAdjustThreshold');
    const adjustButtonHtml = `<button type="button" class="btn btn-outline btn-xsmall run-adjust-btn"
                                       data-run-id="${run.run_id}">${adjustButtonLabel}</button>`;
    const promptButtonHtml = `<button type="button" class="btn btn-outline btn-xsmall run-prompt-btn"
                                       data-run-id="${run.run_id}">${t('llm_historyShowPrompt')}</button>`;

    const batchesDetailHtml = sortedBatches.map(b =>
        `<div class="run-batch-row">${t('llm_historyBatchDetail', [formatTimestamp(b.timestamp), String(b.target_count ?? 0)])}</div>`
    ).join('');

    const showBatchesLabel = t('llm_historyShowBatches', String(sortedBatches.length));
    const hideBatchesLabel = t('llm_historyHideBatches');

    const modelHtml = run.model
        ? `<div class="run-model"></div>`
        : '';

    card.innerHTML = `
        <div class="run-header">
            <div class="run-date-range">
                ${typeBadge}${statusLabel}${dateRange}
            </div>
            ${radioHtml}
        </div>
        ${modelHtml}
        <div class="run-stats">${statsContent}</div>
        <div class="run-actions">
            ${adjustButtonHtml}
            ${promptButtonHtml}
        </div>
        <button type="button" class="run-batches-toggle"
                data-show-label="${showBatchesLabel}"
                data-hide-label="${hideBatchesLabel}">${showBatchesLabel}</button>
        <div class="run-batches-detail hidden">${batchesDetailHtml}</div>
    `;

    // モデル名は textContent で安全に流し込む
    const modelEl = card.querySelector('.run-model') as HTMLElement | null;
    if (modelEl) {
        modelEl.textContent = run.model;
    }

    // ラジオ: クリックで Run を active 化
    const radio = card.querySelector('.run-active-radio') as HTMLInputElement | null;
    if (radio) {
        radio.addEventListener('change', async () => {
            if (!radio.checked) return;
            await onActivate(run.run_id);
        });
    }

    // 閾値調整ボタン: Run の代表として最新 Batch ID で prepareThresholdAdjustment を呼ぶ
    const adjustButton = card.querySelector('.run-adjust-btn') as HTMLButtonElement | null;
    if (adjustButton) {
        adjustButton.addEventListener('click', async () => {
            try {
                const initialThreshold = run.status === 'confirmed'
                    ? run.include_threshold
                    : (typeof state.llmConfig?.llm_include_threshold === 'number'
                        ? state.llmConfig.llm_include_threshold
                        : 0.3);
                await prepareThresholdAdjustment(latest.execution_id, initialThreshold, totalRefs);
                showToast(t('llm_thresholdAdjustReady'));
            } catch (error) {
                console.error('[appendRunCard] Failed to prepare threshold adjustment:', error);
                showToast((error as Error).message || t('llm_historyUpdateFailed'));
            }
        });
    }

    // プロンプト表示ボタン: モーダルで Run の screening_prompt と criteria を表示
    const promptButton = card.querySelector('.run-prompt-btn') as HTMLButtonElement | null;
    if (promptButton) {
        promptButton.addEventListener('click', () => openRunPromptModal(run));
    }

    // バッチ詳細トグル
    const toggle = card.querySelector('.run-batches-toggle') as HTMLButtonElement | null;
    const detail = card.querySelector('.run-batches-detail') as HTMLElement | null;
    if (toggle && detail) {
        toggle.addEventListener('click', () => {
            const isHidden = detail.classList.toggle('hidden');
            toggle.textContent = isHidden
                ? toggle.dataset.showLabel || ''
                : toggle.dataset.hideLabel || '';
        });
    }

    container.appendChild(card);
}

/**
 * prompt_generation 等、Run に紐付かない単独実行を従来形式のカードで描画
 */
function appendStandaloneItem(
    container: HTMLElement,
    exec: Awaited<ReturnType<typeof getLlmExecutions>>[number]
): void {
    const item = document.createElement('div');
    item.className = `execution-item ${exec.status === 'pending' ? 'pending' : 'confirmed'}`;

    const dateStr = formatTimestamp(exec.timestamp);
    const typeLabel = exec.execution_type === 'batch_screening'
        ? t('llm_historyBatch')
        : t('llm_historyCriteria');
    const statusLabel = exec.status === 'pending'
        ? `<span class="execution-status pending">${t('llm_historyPending')}</span>`
        : '';
    const statsContent = t('llm_historyPendingStats', String(exec.target_count));

    item.innerHTML = `
        <div class="execution-header">
            <div class="execution-date">
                <span class="execution-type">${typeLabel}</span>
                ${statusLabel}
                ${dateStr}
            </div>
        </div>
        <div class="execution-stats">${statsContent}</div>
    `;

    container.appendChild(item);
}

type HistoryItem =
    | { kind: 'run'; run: LlmRun; batches: Awaited<ReturnType<typeof getLlmExecutions>>; sortDate: number }
    | { kind: 'standalone'; exec: Awaited<ReturnType<typeof getLlmExecutions>>[number]; sortDate: number };

/**
 * 実行履歴を読み込み
 *
 * Run/Batch 分離後の表示構造:
 * - batch_screening は所属 Run でグループ化し、Run カード1枚として表示
 * - prompt_generation など Run に紐付かない実行は従来形式の単独カード
 * - すべての項目を最新活動順に並べ、上位 10 件を表示
 */
export async function loadExecutionHistory() {
    const spreadsheetId = state.spreadsheetId;

    try {
        const [executions, runs] = await Promise.all([
            getLlmExecutions(spreadsheetId),
            getLlmRuns(spreadsheetId),
        ]);

        // active Run 配下の Batch IDs をキャッシュへ反映
        const activeRun = runs.find(r => r.is_active && r.status === 'confirmed');
        const activeBatchIds = activeRun
            ? new Set(
                executions
                    .filter(e => e.execution_type === 'batch_screening' && e.run_id === activeRun.run_id)
                    .map(e => e.execution_id)
              )
            : new Set<string>();
        syncSetActiveLlmExecutionIds(activeBatchIds);

        if (executions.length === 0 && runs.length === 0) {
            dom.executionHistory.innerHTML = `<p class="placeholder-text">${t('llm_historyEmpty')}</p>`;
            return;
        }

        // バッチを Run でグループ化（run_id が無いものは migration 待ちとしてスキップ）
        const batchesByRunId = new Map<string, Awaited<ReturnType<typeof getLlmExecutions>>>();
        const standaloneExecs: Awaited<ReturnType<typeof getLlmExecutions>> = [];

        for (const exec of executions) {
            if (exec.execution_type === 'batch_screening' && exec.run_id) {
                const list = batchesByRunId.get(exec.run_id) ?? [];
                list.push(exec);
                batchesByRunId.set(exec.run_id, list);
            } else {
                standaloneExecs.push(exec);
            }
        }

        // 統一リストを構築
        const items: HistoryItem[] = [];

        for (const run of runs) {
            const batches = batchesByRunId.get(run.run_id);
            if (!batches || batches.length === 0) continue;
            const latestTs = Math.max(...batches.map(b => new Date(b.timestamp).getTime()));
            items.push({ kind: 'run', run, batches, sortDate: latestTs });
        }

        for (const exec of standaloneExecs) {
            items.push({ kind: 'standalone', exec, sortDate: new Date(exec.timestamp).getTime() });
        }

        // 最新活動順にソート、上位 10 件
        items.sort((a, b) => b.sortDate - a.sortDate);
        const visibleItems = items.slice(0, 10);

        dom.executionHistory.innerHTML = '';

        const handleRunActivate = async (runId: string): Promise<void> => {
            try {
                await setSingleActiveRun(spreadsheetId, runId);
                const targetBatchIds = new Set(
                    executions
                        .filter(e => e.execution_type === 'batch_screening' && e.run_id === runId)
                        .map(e => e.execution_id)
                );
                syncSetActiveLlmExecutionIds(targetBatchIds);
                showToast(t('llm_historyActivated'));
                await loadExecutionHistory();
            } catch (error) {
                console.error('[loadExecutionHistory] Failed to activate run:', error);
                showToast(t('llm_historyUpdateFailed'));
                await loadExecutionHistory();
            }
        };

        for (const item of visibleItems) {
            if (item.kind === 'run') {
                const isSelectedActive = item.run.run_id === activeRun?.run_id;
                appendRunCard(
                    dom.executionHistory,
                    spreadsheetId,
                    item.run,
                    item.batches,
                    isSelectedActive,
                    handleRunActivate
                );
            } else {
                appendStandaloneItem(dom.executionHistory, item.exec);
            }
        }
    } catch (error) {
        console.error('[loadExecutionHistory] Error:', error);
    }
}
