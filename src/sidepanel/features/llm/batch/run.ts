/**
 * LLMバッチ処理モジュール - 実行制御
 *
 * Issue #191: 元 `batch.ts`（1,393行）から実行制御部分を分離。
 * バッチの開始・中断・リトライ、429スロットル通知を担当する。
 * 対象件数・実行モード表示の更新（画面更新）は `./target-count`、閾値調整・採用操作は
 * `./threshold`、実行履歴の描画は `./history` に分離しており、公開APIの再exportは
 * `./index`（旧 `./batch` の import 経路を維持する薄い入口）にまとめている。
 */

import { dom } from '../dom';
import { state } from '../../../state';
import type { LlmBatchProgress, BatchProfile, LlmRun } from '../../../../lib/types';
import { BATCH_PROFILES, getBatchProfile } from '../../../../lib/types';
import {
    appendDecisions,
    saveLlmExecution,
    updateLlmExecution,
    loadProjectSnapshot,
    selectReferencesWithStatus,
    saveLlmRun,
    updateLlmRun,
    setSingleActiveRun,
    getRunForBatchId,
    getBatchIdsForRun,
    findRunByConfigHash,
    getJudgedRefIdsForBatches,
} from '../../../../lib/sheets-api';
import { computeConfigHash } from '../../../../lib/llm-config-hash';
import { getEffectiveApiKey, getEffectiveOpenRouterApiKey, getEffectiveOpenAiApiKey, getManualTier } from '../../../../lib/storage';
import { resolveProviderId } from '../../../../lib/llm-provider';
import {
    processBatch,
    previewThresholdCounts,
    createLlmExecution,
    generateLlmReviewerId,
} from '../../../../lib/llm-processor';
import { DEFAULT_SCREENING_PROMPT } from '../../../../lib/prompt-templates';
import { getModelConfig, AVAILABLE_MODELS } from '../../../../lib/gemini-api';
import { showToast } from '../../../ui/feedback';
import { t } from '../../../../lib/i18n';
import {
    setReferences as syncSetReferences,
    setCurrentBatchDecisions as syncSetCurrentBatchDecisions,
    setFailedRefIds as syncSetFailedRefIds,
    clearFailedRefIds as syncClearFailedRefIds,
} from '../../../store/compat';
import { getAssignedSetsForUser, getReferenceAssignmentSet } from '../../assignment';
import {
    selectBatchTargetsByJudgedRefIds,
    BATCH_MAX_COUNT_ALL,
} from '../../../../lib/llm-batch-target';
import { collectSetIdsForRefs } from '../../../../lib/llm-target-selection';
import { handleThresholdChange } from './threshold';
import { loadExecutionHistory } from './history';
import { getBatchBaseRefs, updateBatchTargetCount } from './target-count';

/**
 * 現在の手動 tier 設定とモデル ID からバッチ実行プロファイルを取得
 * 未設定の場合は安全側（＝最も低並列）の free を採用する。
 * tier1 をデフォルトにすると、判定不能なユーザーが実際には無料キーだった場合に
 * 高並列でレート制限を叩き続けることになるため危険側に倒れていた。
 * モデル別に上書きがある場合はそちら（例: gemini-2.5-flash-lite は高並列）を優先
 */
async function resolveBatchProfile(modelId?: string): Promise<BatchProfile> {
    const manualTier = (await getManualTier()) || 'free';
    return getBatchProfile(manualTier, modelId);
}

// バッチ対象の判定ロジックは src/lib/llm-batch-target.ts（純粋関数・テスト対象）に集約している
// getBatchBaseRefs・対象件数と実行モード表示の計算は ./target-count（画面更新）に分離している

/**
 * バッチ実行直後に references を再読込してUIカウントを最新化する
 * - 画面遷移は行わず、データだけ更新する
 * - 担当割当（assignment）のフィルタは初期読み込み時と同じ条件で適用する
 */
async function refreshReferencesAfterBatch(spreadsheetId: string): Promise<void> {
    try {
        const userEmail = state.userEmail;
        const isKeyOpened = state.isKeyOpened;
        const snapshot = await loadProjectSnapshot(spreadsheetId, userEmail, { history: isKeyOpened, duplicateCandidates: false });
        if (snapshot.spreadsheetId !== state.spreadsheetId) return;
        const refs = selectReferencesWithStatus(snapshot, userEmail, isKeyOpened);

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
        await updateBatchTargetCount();
    } catch (error) {
        console.error('[refreshReferencesAfterBatch] Failed to reload references:', error);
    }
}

/**
 * 「新規にやり直す」トグル
 *
 * 既存の判定・履歴は一切削除せず、次の実行を新しい Run として全文献に対して行う。
 * どちらの Run を採用するかは実行履歴のラジオボタンで選べる。
 */
export async function handleToggleRestartRun() {
    const next = !state.forceNewLlmRun;
    state.setForceNewLlmRun(next);
    if (next) {
        showToast(t('llm_batchRunRestartToast'), 5000);
    }
    await updateBatchTargetCount();
}

/**
 * バッチ処理を開始
 */
export async function handleStartBatch() {
    // 直前バッチの post-batch refresh が走っている間は state.references が古いまま。
    // ここで握っておかないと、同じ文献を次のバッチが重複して投げてしまう。
    if (state.batchAbortController) {
        return;
    }

    // 選択中モデルの provider に応じて該当 API キーを確認する
    // (Gemini モデル選択中なのに OpenRouter キーしか無い、等のケースで誤ったエラーを出さない)
    const selectedModelId = dom.llmModelSelect.value;
    const providerId = resolveProviderId(selectedModelId, AVAILABLE_MODELS);
    const apiKey = providerId === 'openrouter'
        ? await getEffectiveOpenRouterApiKey()
        : providerId === 'openai'
            ? await getEffectiveOpenAiApiKey()
            : await getEffectiveApiKey();
    if (!apiKey) {
        const missingKeyMessageKey = providerId === 'openrouter'
            ? 'llm_openRouterApiKeyRequired'
            : providerId === 'openai'
                ? 'llm_openAiApiKeyRequired'
                : 'llm_apiKeyRequired';
        showToast(t(missingKeyMessageKey));
        return;
    }

    const screeningPrompt = dom.screeningPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    if (!screeningPrompt) {
        showToast(t('llm_screeningPromptRequired'));
        return;
    }

    const spreadsheetId = state.spreadsheetId;
    const modelConfig = getModelConfig(dom.llmModelSelect.value);
    // 「新規にやり直す」モードでは既存 Run を再利用せず、新しい Run として全文献を対象にする
    const isRestart = state.forceNewLlmRun;

    // Run 解決 → 対象文献の確定。
    // 件数表示は state のキャッシュ（llmBatchIds）による近似で済ませているが、実行時は
    // 他レビュアーが直前に判定した分をキャッシュが取りこぼすと同一 Run に LLM 票が二重に入り、
    // AI 同士の偽 conflict が発生してしまう。それを防ぐため、実行直前に Sheets から
    // 最新の Run/Batch と「その Run で判定済みの ref_id」を読み直して対象を確定する。
    let configHash: string;
    let matchedRun: LlmRun | null;
    let targetRefs: typeof state.references;
    try {
        configHash = await computeConfigHash({
            model: modelConfig.model,
            temperature: modelConfig.temperature,
            topP: modelConfig.topP,
            thinkingLevel: modelConfig.thinkingLevel,
            criteria_snapshot: state.llmConfig.llm_criteria,
            screening_prompt: screeningPrompt,
        });
        matchedRun = isRestart ? null : await findRunByConfigHash(spreadsheetId, configHash);
        const judgedBatchIds = matchedRun
            ? await getBatchIdsForRun(spreadsheetId, matchedRun.run_id)
            : new Set<string>();
        const judgedRefIds = await getJudgedRefIdsForBatches(spreadsheetId, judgedBatchIds);

        // 対象文献を取得（この Run で未判定のもの・件数上限を適用。人間の判定有無では絞り込まない）
        // 選択モードでは対象の母集合を選択済み ref_id に差し替え、実行上限は無視して選んだ分を全部投げる
        const baseRefs = getBatchBaseRefs();
        const maxCountValue = state.llmTargetMode === 'selection'
            ? BATCH_MAX_COUNT_ALL
            : dom.batchMaxCountSelect.value;
        targetRefs = selectBatchTargetsByJudgedRefIds(baseRefs, maxCountValue, judgedRefIds);
    } catch (error) {
        console.error('[handleStartBatch] Failed to resolve run:', error);
        showToast(t('llm_batchError', (error as Error).message));
        return;
    }

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
    resetThrottleNoticeState();

    // AbortControllerを作成
    const abortController = new AbortController();
    state.setBatchAbortController(abortController);
    syncSetCurrentBatchDecisions([]);

    // 中断・エラー時にも finally で履歴行を実件数で更新するため、
    // try 開始前に execution_id を保持する変数を用意しておく
    let executionId: string | null = null;
    let batchResult: Awaited<ReturnType<typeof processBatch>> | null = null;

    try {
        const profile = await resolveBatchProfile(modelConfig.model);
        const llmConfig = state.llmConfig;

        if (profile === BATCH_PROFILES.free) {
            showToast(t('llm_freeTierBatchWarning'), 4000);
        }

        // Run は上で解決済み（matchedRun があればその続き、無ければ新規作成）。
        // confirmed Run なら閾値を即時適用し、閾値確認 UI をスキップする
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
                requested_model: modelConfig.model,
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
            // 新しい Run を作れたら「新規にやり直す」モードは役目を終える。
            // 以降の実行はこの Run の続きとして扱う（毎回 Run が増えるのを防ぐ）
            state.setForceNewLlmRun(false);
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
            {
                mode: state.llmTargetMode,
                sets: collectSetIdsForRefs(targetRefs, getReferenceAssignmentSet).join(','),
                selectedCount: state.llmTargetMode === 'selection' ? state.llmTargetRefIds.size : undefined,
            },
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
                syncSetCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
            // confirmed Run 配下のバッチは保存時点で include/exclude を確定させる
            applyThreshold: runThreshold ?? undefined,
        });
        batchResult = result;

        // 失敗したref_idを保存
        syncSetFailedRefIds(result.failedRefIds);

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
        dom.stopBatchBtn.classList.add('hidden');

        // pre-write した履歴行の target_count を、実際に保存できた判定件数で更新する。
        // 中断・エラー・成功のいずれでもここに来るので、履歴行と Decisions シートの件数が
        // 食い違わないようにする最後の保険。失敗しても黙って続行する。
        if (executionId) {
            try {
                const savedCount = state.currentBatchDecisions.length;
                await updateLlmExecution(spreadsheetId, executionId, {
                    target_count: savedCount,
                    model_version: batchResult?.resolvedModelVersion,
                    response_id: batchResult?.latestResponseId,
                });
                const resolvedModelVersion = batchResult?.resolvedModelVersion;
                if (resolvedModelVersion) {
                    const run = await getRunForBatchId(spreadsheetId, executionId);
                    if (run) {
                        await updateLlmRun(spreadsheetId, run.run_id, {
                            model_version: resolvedModelVersion,
                            response_id: batchResult?.latestResponseId,
                        });
                    }
                }
                await loadExecutionHistory();
            } catch (err) {
                console.warn('[handleStartBatch] target_count update failed:', err);
            }
        }

        // バッチで判定済みになった文献を「未判定」カウントから除外するため再読込
        // （中断・エラー時も部分的に保存されている可能性があるので必ず実行）
        // Start ボタンと AbortController の解放は refresh 完了後にまとめて行う。
        // 先に解放すると state.references が古いまま連続クリックされて、
        // 直前のバッチ対象を重複して投げてしまう競合が起きる（重複の入口は冒頭の guard で塞ぐ）。
        await refreshReferencesAfterBatch(spreadsheetId);
        state.setBatchAbortController(null);
        dom.startBatchBtn.classList.remove('hidden');
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
    // 直前バッチの後始末（refresh）と被ると state.references が古いまま走るので block する
    if (state.batchAbortController) {
        return;
    }

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
    syncClearFailedRefIds();

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
    resetThrottleNoticeState();

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
                syncSetCurrentBatchDecisions([...currentDecisions, ...decisions]);
            },
        });

        // リトライ結果を更新
        syncSetFailedRefIds(result.failedRefIds);

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
        dom.stopBatchBtn.classList.add('hidden');
        // refresh 完了後にまとめて解放（handleStartBatch 側の guard と対になっている）
        await refreshReferencesAfterBatch(state.spreadsheetId);
        state.setBatchAbortController(null);
        dom.startBatchBtn.classList.remove('hidden');
    }
}

// 429 適応スロットリングの「減速中」表示用の要素キャッシュ。
// sidepanel.html 側に静的なプレースホルダを増やさず batch.ts 側だけで完結させるため、
// 初回の updateBatchProgress 呼び出し時に dom.batchProgressDiv の子として動的に生成する。
let throttleNoticeEl: HTMLElement | null = null;

function getOrCreateThrottleNotice(): HTMLElement {
    if (throttleNoticeEl && throttleNoticeEl.isConnected) {
        return throttleNoticeEl;
    }
    const el = document.createElement('div');
    el.id = 'batch-throttle-notice';
    // execution-status.pending は実行履歴の「未確定」バッジで使っている既存スタイル
    // （amber系の小さいバッジ）を流用し、新規CSSを追加せずに視認性を確保する
    el.className = 'execution-status pending hidden';
    el.style.display = 'block';
    el.style.marginTop = '8px';
    el.style.textAlign = 'center';
    dom.batchProgressDiv.appendChild(el);
    throttleNoticeEl = el;
    return el;
}

// レート制限検出トーストを1バッチ実行につき1回だけ出すための直前値。
// handleStartBatch / handleRetryFailed の開始時にリセットする。
let lastReportedRateLimitHits = 0;

/** 新しいバッチ実行を開始する直前に呼ぶ（前回実行の検出回数を持ち越さないため） */
function resetThrottleNoticeState(): void {
    lastReportedRateLimitHits = 0;
    // 7番: バナー要素自体も隠す。トーストのラッチだけ戻しても、前回実行の「検出N回」が
    // 今回の1件目が終わるまで表示され続けてしまうため
    if (throttleNoticeEl) {
        throttleNoticeEl.classList.add('hidden');
    }
}

/**
 * rateLimitHits が 0 → 1 に変わった最初のタイミングで1回だけトーストを出す。
 * isFreeTierQuota は LlmBatchProgress からは見えない（GeminiApiError 側のフィールドのため）
 * ので、ここでは「無料枠だ」とは断定せず、レート制限を検出して自動調整したことだけを伝える。
 */
function maybeShowRateLimitToast(progress: LlmBatchProgress): void {
    if (progress.rateLimitHits > 0 && lastReportedRateLimitHits === 0) {
        showToast(t('llm_batchRateLimitDetected'), 6000);
    }
    lastReportedRateLimitHits = progress.rateLimitHits;
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

    // 429 適応スロットリングで速度を落としている間だけ「減速中」を表示する。
    // isThrottled は「並列度が既定未満 or 滞在時間が既定超 or クールダウン中」なので、
    // 無料プロファイル（並列度・滞在時間が既にクランプ済みで変化しない）でもクールダウン中は
    // true になる。onThrottleChange → syncProgressFromGovernor により、クールダウンが立った
    // 瞬間に throttled=true の progress が飛ぶため、「1件完了時にしかサンプリングされないから
    // 無料枠ユーザーに出ない」という問題は既に解消済み。クールダウンが明けるとバナーが消えるが、
    // これは「実際に減速していない」ことを正しく表している（429ごとに出たり消えたりするのが正しい挙動）。
    // rateLimitHits > 0 だけでは一度でも429を踏むと実行終了までバナーが出っぱなしになり、
    // 「続行しています」という現在進行形の文言と矛盾するため使わない。
    // 実行終了後（isRunning=false）は隠す（7番: 完全回復していない状態のまま実行が終わっても、
    // 次のバッチ開始までバナーが残らないように）
    const throttleNotice = getOrCreateThrottleNotice();
    if (progress.isRunning && progress.throttled) {
        throttleNotice.textContent = t('llm_batchThrottled', String(progress.rateLimitHits));
        throttleNotice.classList.remove('hidden');
    } else {
        throttleNotice.classList.add('hidden');
    }

    maybeShowRateLimitToast(progress);
}

