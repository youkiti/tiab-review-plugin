/**
 * LLMバッチ処理モジュール - 実行履歴
 *
 * Issue #191: 元 `batch.ts`（1,393行）から実行履歴の表示部分を分離。
 * Run/Batch 分離モデルでの履歴一覧描画（Run カード・単独実行カード）、
 * Run のプロンプト・判定基準モーダル表示を担当する。
 *
 * `appendRunCard` の閾値調整ボタンは `./threshold` の `prepareThresholdAdjustment` を
 * 呼ぶ必要があるが、`./threshold` 側は `loadExecutionHistory`（このファイル）を読み込む
 * ため、直接 import し合うと `./history` <-> `./threshold` の循環になる
 * （`node scripts/check-structure.mjs` の循環検出に引っかかる）。これを避けるため、
 * `setPrepareThresholdAdjustment` で `./threshold` 側の実体を注入してもらう方式にしている
 * （`./index` が起動時に配線する）。挙動は直接 import していたときと同じで、単に依存の
 * 向きを一方向に揃えるための間接参照。
 */

import { dom } from '../dom';
import { state } from '../../../state';
import type { LlmRun } from '../../../../lib/types';
import {
    getLlmExecutions,
    getLlmRuns,
    selectActiveBatchIds,
    selectActiveLlmRun,
    setSingleActiveRun,
} from '../../../../lib/sheets-api';
import { showModal, hideModal } from '../../../ui/modal';
import { showToast } from '../../../ui/feedback';
import { t } from '../../../../lib/i18n';
import { setActiveLlmExecutionIds as syncSetActiveLlmExecutionIds } from '../../../store/compat';

// prepareThresholdAdjustment（./threshold）への参照（循環依存回避）。
// ファイル冒頭の説明のとおり、./index が起動時に setPrepareThresholdAdjustment で配線する。
let _prepareThresholdAdjustment: ((executionId: string, threshold: number, targetCount: number) => Promise<void>) | null = null;

export function setPrepareThresholdAdjustment(fn: typeof _prepareThresholdAdjustment) {
    _prepareThresholdAdjustment = fn;
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
        modelEl.textContent = run.model_version
            ? `${run.model} / ${run.model_version}`
            : run.model;
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
    // （./threshold から setPrepareThresholdAdjustment で注入された実体。ファイル冒頭の説明を参照）
    const adjustButton = card.querySelector('.run-adjust-btn') as HTMLButtonElement | null;
    if (adjustButton) {
        adjustButton.addEventListener('click', async () => {
            try {
                const initialThreshold = run.status === 'confirmed'
                    ? run.include_threshold
                    : (typeof state.llmConfig?.llm_include_threshold === 'number'
                        ? state.llmConfig.llm_include_threshold
                        : 0.3);
                if (!_prepareThresholdAdjustment) {
                    throw new Error('prepareThresholdAdjustment が未配線（./index の setPrepareThresholdAdjustment）');
                }
                await _prepareThresholdAdjustment(latest.execution_id, initialThreshold, totalRefs);
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
export async function loadExecutionHistory(isCurrent: () => boolean = () => true) {
    const spreadsheetId = state.spreadsheetId;

    try {
        const [executions, runs] = await Promise.all([
            getLlmExecutions(spreadsheetId),
            getLlmRuns(spreadsheetId),
        ]);

        if (!isCurrent() || state.spreadsheetId !== spreadsheetId) return;

        // バッチ対象件数を Sheets 再読み込みなしに Run 単位で計算できるようキャッシュしておく
        state.setLlmRunsAndExecutions(runs, executions);

        // active Run 配下の Batch IDs をキャッシュへ反映
        syncSetActiveLlmExecutionIds(selectActiveBatchIds(runs, executions));
        // 採用 Run の選択規則は selectActiveLlmRun に一本化する（created_at 最新。Issue #153）
        const activeRun = selectActiveLlmRun(runs);

        // バッチを Run でグループ化（run_id が無いものは migration 待ちとしてスキップ）
        const batchesByRunId = new Map<string, Awaited<ReturnType<typeof getLlmExecutions>>>();
        const standaloneExecs: Awaited<ReturnType<typeof getLlmExecutions>> = [];

        for (const exec of executions) {
            if (exec.execution_type === 'batch_screening' && exec.run_id) {
                const list = batchesByRunId.get(exec.run_id) ?? [];
                list.push(exec);
                batchesByRunId.set(exec.run_id, list);
            } else if (exec.execution_type === 'fulltext_batch_screening') {
                // フルテキストAI判定の実行履歴は TiAb の Run/Batch モデルには載せない
                // （src/sidepanel/AGENTS.md「フルテキストAI判定」参照）。TiAb の実行履歴一覧に混ぜると
                // 「判定基準生成」という誤ったラベルで表示されてしまう（else 分岐が
                // batch_screening 以外を全部「判定基準生成」扱いする二値三項のため）。
                // フルテキストの実行履歴は AI判定タブのラウンド一覧（fulltext-ai.ts）で見せる。
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

        // 空判定は items（TiAb の実行履歴として実際に表示する項目）に対して行う。
        // executions/runs 全体で判定すると、フルテキストAI判定の行しか無いプロジェクト
        // （TiAb のAI判定を一度も使っていない）で早期returnせず、その後のグルーピングで
        // fulltext_batch_screening が全部除外されて items が空になり、プレースホルダーすら
        // 出ない空白になってしまう（PR #102 レビュー指摘）
        if (items.length === 0) {
            dom.executionHistory.innerHTML = `<p class="placeholder-text">${t('llm_historyEmpty')}</p>`;
            return;
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
        if (!isCurrent() || state.spreadsheetId !== spreadsheetId) return;
        console.error('[loadExecutionHistory] Error:', error);
        // クォータ超過などで読み込み失敗 → プレースホルダではなくエラー表示＋再試行ボタン
        const message = (error as Error).message ?? '';
        const isQuota = /quota|429|Too Many Requests/i.test(message);
        const errorText = isQuota ? t('llm_historyErrorQuota') : t('llm_historyErrorGeneric');
        const retryLabel = t('llm_historyErrorRetry');
        dom.executionHistory.innerHTML = `
            <div class="execution-history-error">
                <p class="error-text">${errorText}</p>
                <button type="button" class="btn btn-outline btn-small" id="execution-history-retry-btn">${retryLabel}</button>
            </div>
        `;
        const retryBtn = document.getElementById('execution-history-retry-btn');
        retryBtn?.addEventListener('click', () => { void loadExecutionHistory(); });
    }
}
