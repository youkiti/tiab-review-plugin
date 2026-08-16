/**
 * 孤立判定の検出と復旧（Run/Batch 分離モデル対応）
 *
 * Decisions シートに `llm:` で始まる reviewer_id の判定行があるのに、
 * LLM_Executions（Batch シート）に対応する execution_id の行がないケースを救う。
 *
 * 発生原因の例:
 * - バッチ完了直前に Stop / サイドパネル閉鎖 / OAuth 失効などが発生し、
 *   Batch 行の書き込みがスキップされた
 * - 旧バージョンで判定したあと、新バージョンで履歴シートを期待するようになった
 * - ユーザーが LLM_Executions シートを手動で消した
 *
 * 復旧フロー:
 * 1. 孤立した execution_id ごとに Batch 行（LLM_Executions）を生成
 * 2. `getLlmRuns()` を呼ぶことで既存の `migrateLegacyExecutionsToRuns()` が走り、
 *    run_id 空の Batch 行が config_hash でグループ化されて Run 行が自動生成される
 * 3. 履歴UIを再読込
 */

import { dom } from '../../dom';
import { state } from '../../state';
import {
    getDecisions,
    getLlmExecutions,
    getLlmRuns,
    saveLlmExecution,
} from '../../../lib/sheets-api';
import { createLlmExecution, parseLlmDecisionNote } from '../../../lib/llm-processor';
import type { LlmExecution } from '../../../lib/types';
import { showToast } from '../../ui/feedback';
import { showModal, hideModal } from '../../ui/modal';
import { t } from '../../../lib/i18n';
import { loadExecutionHistory } from './batch';

/**
 * 孤立した実行に関する情報
 */
export interface OrphanedExecutionInfo {
    executionId: string;
    model: string;
    timestamp: string;        // ISO 8601。execution_id 内の `@` 以降から抽出
    decisionCount: number;    // Decisions シート上で同 reviewer_id を持つ行数
    promptVersion?: string;   // 判定行の note から抽出（任意）
}

/**
 * `llm:{model}@{ISO_timestamp}` 形式から model と timestamp を分離
 */
function parseExecutionId(executionId: string): { model: string; timestamp: string } | null {
    if (!executionId.startsWith('llm:')) return null;
    const body = executionId.slice('llm:'.length);
    const atIndex = body.lastIndexOf('@');
    if (atIndex <= 0 || atIndex >= body.length - 1) return null;
    const model = body.slice(0, atIndex);
    const timestamp = body.slice(atIndex + 1);
    return { model, timestamp };
}

/**
 * LLM_Executions に Batch 行がない execution_id を Decisions から拾い上げる
 */
export async function findOrphanedExecutions(spreadsheetId: string): Promise<OrphanedExecutionInfo[]> {
    console.log('[findOrphanedExecutions] Start');
    const [allDecisions, existingExecutions] = await Promise.all([
        getDecisions(spreadsheetId),
        getLlmExecutions(spreadsheetId),
    ]);
    console.log('[findOrphanedExecutions] decisions=', allDecisions.length, 'executions=', existingExecutions.length);

    const existingIds = new Set(existingExecutions.map((exec) => exec.execution_id));

    // reviewer_id ごとに件数とサンプル note を集計
    const buckets = new Map<string, { count: number; sampleNote?: string }>();
    for (const { decision } of allDecisions) {
        const id = decision.reviewer_id;
        if (!id.startsWith('llm:')) continue;
        // フルテキストAI判定（screening_phase='fulltext'）も reviewer_id が
        // `llm:{model}@{timestamp}` 形式なので、ここで見分けないと孤立判定として
        // 誤検出される。フルテキストAI判定は別枠の実行履歴（execution_type=
        // 'fulltext_batch_screening'）を持ち、TiAb の Run/Batch モデルには載せない
        // 対象なので、ここでは除外する（Issue #62）。
        if ((decision.screening_phase ?? 'tiab') === 'fulltext') continue;
        if (existingIds.has(id)) continue;

        const bucket = buckets.get(id) ?? { count: 0 };
        bucket.count += 1;
        if (!bucket.sampleNote && decision.note) {
            bucket.sampleNote = decision.note;
        }
        buckets.set(id, bucket);
    }

    const orphans: OrphanedExecutionInfo[] = [];
    for (const [executionId, { count, sampleNote }] of buckets) {
        const parsed = parseExecutionId(executionId);
        if (!parsed) {
            // 異常な ID は無視（ログに残しておく）
            console.warn('[findOrphanedExecutions] Skipping unparsable execution_id:', executionId);
            continue;
        }

        let promptVersion: string | undefined;
        if (sampleNote) {
            const note = parseLlmDecisionNote(sampleNote);
            promptVersion = note?.prompt_version;
        }

        orphans.push({
            executionId,
            model: parsed.model,
            timestamp: parsed.timestamp,
            decisionCount: count,
            promptVersion,
        });
    }

    // 新しい順に並べる
    orphans.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    console.log('[findOrphanedExecutions] orphans=', orphans.length);
    return orphans;
}

/**
 * 復旧時に流用する既存の Batch（同モデル優先）を選ぶ
 * - criteria_snapshot / screening_prompt / model parameters の補完元として使う
 */
function pickTemplateExecution(
    executions: LlmExecution[],
    model: string,
): LlmExecution | null {
    const batches = executions
        .filter((exec) => exec.execution_type === 'batch_screening')
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const sameModel = batches.find((exec) => exec.model === model);
    return sameModel ?? batches[0] ?? null;
}

/**
 * 孤立した execution_id に対して Batch 行（LLM_Executions）を再構築する
 *
 * - `run_id` は空にして保存する。後段の `getLlmRuns()` で自動的に Run へ束ねられる。
 * - status='pending', is_active=false は Batch 行のダミー値（Run 側が正の値を持つ）
 * - criteria_snapshot / screening_prompt / モデルパラメータは、同モデルの直近 Batch
 *   から流用、なければ現在の llmConfig からフォールバック
 */
export async function recoverOrphanedExecutions(
    spreadsheetId: string,
    orphans: OrphanedExecutionInfo[],
): Promise<number> {
    if (orphans.length === 0) return 0;

    console.log('[recoverOrphanedExecutions] Recovering', orphans.length, 'orphans');
    const executions = await getLlmExecutions(spreadsheetId);
    const llmConfig = state.llmConfig;
    let recovered = 0;

    for (const orphan of orphans) {
        const template = pickTemplateExecution(executions, orphan.model);

        const criteria = template?.criteria_snapshot ?? llmConfig?.llm_criteria ?? null;
        const screeningPrompt = template?.screening_prompt ?? llmConfig?.llm_screening_prompt ?? '';
        const temperature = template?.temperature;
        const topP = template?.topP;
        const thinkingLevel = template?.thinkingLevel;

        const execution = createLlmExecution(
            orphan.executionId,
            'batch_screening',
            orphan.model,
            criteria,
            screeningPrompt,
            0,                              // include_threshold（Run 側が正）
            orphan.decisionCount,           // target_count は実件数
            0,
            0,
            'pending',                      // status は Run 側が正
            false,                          // is_active は Run 側が正
            temperature,
            topP,
            thinkingLevel,
        );
        // 並び順を整えるため、execution_id 内の timestamp と一致させる
        execution.timestamp = orphan.timestamp;
        // run_id は空のままにしておく → getLlmRuns() 内の自動移行が config_hash で
        // グルーピングして Run を生成し、Batch の run_id を埋めてくれる
        execution.run_id = '';

        try {
            await saveLlmExecution(spreadsheetId, execution);
            recovered += 1;
        } catch (err) {
            console.error(`[recoverOrphanedExecutions] Failed to save ${orphan.executionId}:`, err);
        }
    }

    console.log('[recoverOrphanedExecutions] Saved', recovered, 'Batch rows; triggering Run migration');

    // 既存の自動移行を発火させる: getLlmRuns() 内部で
    // migrateLegacyExecutionsToRuns() が走り、run_id 空の Batch 行を
    // config_hash でグループ化して Run 行を新規作成する
    try {
        const runs = await getLlmRuns(spreadsheetId);
        console.log('[recoverOrphanedExecutions] Runs after migration:', runs.length);
    } catch (err) {
        console.error('[recoverOrphanedExecutions] Run migration failed:', err);
        // 移行失敗しても Batch 行は保存済みなので throw はしない
    }

    return recovered;
}

/**
 * 「孤立判定を復旧」ボタンのクリックハンドラ
 */
export async function handleRecoverOrphans(): Promise<void> {
    console.log('[handleRecoverOrphans] Clicked');
    const btn = dom.recoverOrphansBtn;
    const spreadsheetId = state.spreadsheetId;
    if (!spreadsheetId) {
        showToast(t('llm_recoverOrphansError', 'spreadsheetId missing'));
        return;
    }

    btn.disabled = true;
    try {
        showToast(t('llm_recoverOrphansChecking'));
        const orphans = await findOrphanedExecutions(spreadsheetId);

        if (orphans.length === 0) {
            showToast(t('llm_recoverOrphansNoneFound'));
            return;
        }

        // モーダル本体: 件数概要 + 各 orphan の execution_id / 判定件数を一覧表示
        const body = document.createElement('div');

        const summary = document.createElement('p');
        summary.textContent = t('llm_recoverOrphansDialogBody', String(orphans.length));
        body.appendChild(summary);

        const list = document.createElement('ul');
        list.style.margin = '0.5em 0';
        list.style.paddingLeft = '1.25em';
        for (const orphan of orphans) {
            const li = document.createElement('li');
            li.textContent = t('llm_recoverOrphansListItem', [
                orphan.executionId,
                String(orphan.decisionCount),
            ]);
            list.appendChild(li);
        }
        body.appendChild(list);

        // フッター: 復旧 / キャンセル
        const footer = document.createElement('div');
        footer.style.display = 'flex';
        footer.style.gap = '0.5em';
        footer.style.justifyContent = 'flex-end';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-outline';
        cancelBtn.textContent = t('llm_recoverOrphansCancelBtn');
        cancelBtn.onclick = () => hideModal();

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'btn btn-primary';
        confirmBtn.textContent = t('llm_recoverOrphansConfirmBtn');
        confirmBtn.onclick = async () => {
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            try {
                const recovered = await recoverOrphanedExecutions(spreadsheetId, orphans);
                hideModal();
                showToast(t('llm_recoverOrphansSuccess', String(recovered)));
                await loadExecutionHistory();
            } catch (err) {
                console.error('[handleRecoverOrphans] Recovery failed:', err);
                showToast(t('llm_recoverOrphansError', (err as Error).message));
                confirmBtn.disabled = false;
                cancelBtn.disabled = false;
            }
        };

        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);

        showModal({
            title: t('llm_recoverOrphansDialogTitle'),
            body,
            footer,
        });
    } catch (err) {
        console.error('[handleRecoverOrphans] Error:', err);
        showToast(t('llm_recoverOrphansError', (err as Error).message));
    } finally {
        btn.disabled = false;
    }
}
