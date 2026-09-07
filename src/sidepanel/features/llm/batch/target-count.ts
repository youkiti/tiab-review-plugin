/**
 * LLMバッチ処理モジュール - 画面更新（対象件数・実行モード表示）
 *
 * Issue #191: 元 `batch.ts`（1,393行）から「バッチ対象件数と実行モード表示の更新」部分を分離。
 * `./run` の `handleStartBatch` / `refreshReferencesAfterBatch` / `handleToggleRestartRun` から
 * `getBatchBaseRefs` / `updateBatchTargetCount` を呼ぶ一方向の依存（`./run` → `./target-count`）
 * のみで、`./threshold` や `./history` への依存は無い。
 */

import { dom } from '../dom';
import { state } from '../../../state';
import type { LlmRun } from '../../../../lib/types';
import { computeConfigHash } from '../../../../lib/llm-config-hash';
import { getModelConfig } from '../../../../lib/gemini-api';
import { DEFAULT_SCREENING_PROMPT } from '../../../../lib/prompt-templates';
import { t } from '../../../../lib/i18n';
import {
    isBatchEligible,
    resolveBatchLimit,
    pickRunByConfigHash,
} from '../../../../lib/llm-batch-target';
import {
    resolveSelectedRefs,
    countTargetSelection,
} from '../../../../lib/llm-target-selection';

// バッチ対象の判定ロジックは src/lib/llm-batch-target.ts（純粋関数・テスト対象）に集約している

/** 対象モードを反映したバッチ対象の母集合を返す */
export function getBatchBaseRefs() {
    return state.llmTargetMode === 'selection'
        ? resolveSelectedRefs(state.references, state.llmTargetRefIds)
        : state.references;
}

/**
 * 現在の UI 設定から config_hash を計算する
 * screeningPrompt は handleStartBatch と同じ既定値解決を行う
 */
async function computeCurrentConfigHash(): Promise<string> {
    const modelConfig = getModelConfig(dom.llmModelSelect.value);
    const screeningPrompt = dom.screeningPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    return computeConfigHash({
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        topP: modelConfig.topP,
        thinkingLevel: modelConfig.thinkingLevel,
        criteria_snapshot: state.llmConfig.llm_criteria,
        screening_prompt: screeningPrompt,
    });
}

/**
 * 「これから実行する Run」と、その Run で既に判定済みの Batch ID 集合を解決する
 *
 * Sheets は読まず、loadExecutionHistory が保持した state のキャッシュだけを使う。
 * 件数表示はモデル変更やプロンプト入力のたびに再計算されるため、
 * ここで API を叩くと読み取りクォータを容易に超過してしまう。
 */
async function resolveTargetRun(): Promise<{ run: LlmRun | null; judgedBatchIds: Set<string> }> {
    // 「新規にやり直す」モードでは既存 Run を再利用しないので、判定済み集合は空
    if (state.forceNewLlmRun) {
        return { run: null, judgedBatchIds: new Set() };
    }

    try {
        const configHash = await computeCurrentConfigHash();
        const run = pickRunByConfigHash(state.llmRuns, configHash);
        if (!run) return { run: null, judgedBatchIds: new Set() };

        const judgedBatchIds = new Set(
            state.llmExecutions
                .filter(e => e.execution_type === 'batch_screening' && e.run_id === run.run_id)
                .map(e => e.execution_id)
        );
        return { run, judgedBatchIds };
    } catch (error) {
        // ハッシュ計算に失敗しても件数表示は出したいので、新規 Run 扱いにフォールバックする
        console.warn('[resolveTargetRun] Failed to resolve run:', error);
        return { run: null, judgedBatchIds: new Set() };
    }
}

/**
 * バッチ対象件数と実行モード表示を更新
 *
 * 対象は「これから実行する Run でまだ判定していない文献」。
 * 設定（モデル・プロンプト・基準）を変えると別 Run になるため、対象は全文献に戻る。
 */
export async function updateBatchTargetCount(isCurrent: () => boolean = () => true) {
    const { run, judgedBatchIds } = await resolveTargetRun();
    if (!isCurrent()) return;
    const isSelectionMode = state.llmTargetMode === 'selection';

    const baseRefs = getBatchBaseRefs();
    const eligibleCount = baseRefs.filter(ref => isBatchEligible(ref, judgedBatchIds)).length;
    dom.batchTargetCount.textContent = eligibleCount.toString();

    // 選択モードでは実行上限を適用しない（選んだ分は全部投げる）
    const limit = isSelectionMode ? null : resolveBatchLimit(dom.batchMaxCountSelect.value);
    const plannedCount = limit === null ? eligibleCount : Math.min(eligibleCount, limit);
    dom.batchPlannedCount.textContent = plannedCount.toString();
    dom.batchMaxCountSelect.disabled = isSelectionMode;

    // 対象サマリ・解除ボタン
    // judgedCount は下の renderBatchRunMode に渡す値と同じ式。Run 行を出す条件（run が非 null かつ
    // judgedCount >= 1、すなわち同じ設定の Run の続きで既に判定済みの文献がある）と揃えることで、
    // 「続きから実行できます」という表示と「全件」の誤読を同時に防ぐ
    const judgedCount = baseRefs.length - eligibleCount;
    dom.batchTargetSummary.textContent = isSelectionMode
        ? t('llm_targetSelected', String(state.llmTargetRefIds.size))
        : run && judgedCount >= 1
            ? t('llm_targetAllResume', [String(eligibleCount), String(state.references.length)])
            : t('llm_targetAll', String(state.references.length));
    dom.batchTargetClearBtn.classList.toggle('hidden', !isSelectionMode);

    // 選択モードの注記: 手元に無い ref_id・この Run で既に判定済みの件数を案内する
    if (isSelectionMode) {
        const breakdown = countTargetSelection(
            state.references,
            state.llmTargetRefIds,
            ref => !isBatchEligible(ref, judgedBatchIds)
        );
        const notes: string[] = [];
        const missingCount = breakdown.selected - breakdown.available;
        if (missingCount > 0) {
            notes.push(t('llm_targetMissingNote', String(missingCount)));
        }
        if (breakdown.alreadyJudged > 0) {
            notes.push(t('llm_targetJudgedNote', String(breakdown.alreadyJudged)));
        }
        dom.batchTargetNote.textContent = notes.join(' ');
        dom.batchTargetNote.classList.toggle('hidden', notes.length === 0);
    } else {
        dom.batchTargetNote.classList.add('hidden');
    }

    renderBatchRunMode(run, judgedCount);
}

/**
 * 実行モード行（続きから / 新規にやり直す）を描画する
 * @param judgedCount 現在の Run で既に判定済みの件数
 */
function renderBatchRunMode(run: LlmRun | null, judgedCount: number) {
    const container = dom.batchRunMode;
    const text = dom.batchRunModeText;
    const button = dom.batchRestartRunBtn;

    if (state.forceNewLlmRun) {
        container.classList.remove('hidden');
        container.classList.add('restart-active');
        text.textContent = t('llm_batchRunRestartActive');
        button.textContent = t('llm_batchRunRestartCancel');
        return;
    }

    container.classList.remove('restart-active');

    // 既存 Run の続きでない（＝この設定では未実行）ときは、やり直す対象が無いので非表示
    if (!run || judgedCount <= 0) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    text.textContent = t('llm_batchRunResume', String(judgedCount));
    button.textContent = t('llm_batchRunRestartBtn');
}
