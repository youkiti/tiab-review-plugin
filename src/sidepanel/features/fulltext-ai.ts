/**
 * フルテキスト AI判定タブ
 *
 * 全文を確保済み（fulltext_status='cached'）かつ未だAI判定が無い候補を対象に、
 * Gemini へ PDF を丸ごと渡して include/exclude/maybe を一括判定する（バッチ専用）。
 *
 * - AI判定は1バッチ = 1つの判定者(voter) として Decisions タブへ保存する
 *   （reviewer_id = `llm:{model}@{timestamp}`、screening_phase='fulltext'）。
 *   人間は別 reviewer_id で独立にレビューするため、AI票はそのまま確定保存してよい
 *   （候補プールの投票/集計で人間票と共存する）。
 * - 判定根拠（evidence: quote / page / bbox）は Decision.note(JSON) に格納し、
 *   フルテキストページ(fulltext.html)でPDFハイライトとして再現する。
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { showToast } from '../ui/feedback';
import { getFulltextCandidateList } from './screening/filters';
import { getAssignedSetsForUser, getReferenceAssignmentSet } from './assignment';
import { setReferences as syncSetReferences } from '../store/compat';
import {
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    saveDecision,
} from '../../lib/sheets-api';
import { extractDriveFileId, downloadDriveFile } from '../../lib/drive-api';
import { judgeFulltext, FULLTEXT_PROMPT_VERSION } from '../../lib/gemini-fulltext';
import { generateLlmReviewerId } from '../../lib/llm-processor';
import { getModelConfig, AVAILABLE_MODELS } from '../../lib/gemini-api';
import { getEffectiveApiKey } from '../../lib/storage';
import { getClientVersion } from '../../lib/client-version';
import { DEFAULT_SCREENING_PROMPT } from '../../lib/prompt-templates';
import type {
    ReferenceWithStatus,
    Decision,
    FulltextLlmDecisionNote,
    FulltextJudgeOutput,
} from '../../lib/types';

// バッチ実行の中断フラグ
let aiAbort: { cancelled: boolean } | null = null;
// パネル初期化済みか（モデル選択・プロンプトの初回プリフィル制御）
let aiInitialized = false;

/** AI判定の対象（cached かつ AI未判定）か */
function isAiEligible(ref: ReferenceWithStatus): boolean {
    if (ref.fulltext_status !== 'cached' || !ref.fulltext_url) return false;
    return !hasAiFulltextDecision(ref);
}

/** すでにAIフルテキスト判定(llm: voter)が存在するか */
function hasAiFulltextDecision(ref: ReferenceWithStatus): boolean {
    const list = ref.allFulltextDecisions ?? (ref.myFulltextDecision ? [ref.myFulltextDecision] : []);
    return list.some(d => (d.reviewer_id || '').startsWith('llm:'));
}

/** Gemini モデルのみの選択肢でセレクトを満たす */
function populateModelSelect(): void {
    const select = dom.fulltextAiModelSelect;
    if (select.options.length > 0) return;
    for (const m of AVAILABLE_MODELS.filter(m => m.provider === 'gemini')) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        select.appendChild(opt);
    }
}

/** プロンプトを TiAb の設定（criteria/screening_prompt）からプリフィルする */
function prefillPrompt(): void {
    const input = dom.fulltextAiPromptInput;
    if (input.value.trim()) return;
    const stored = state.llmConfig?.llm_screening_prompt;
    input.value = (stored && stored.trim()) ? stored : DEFAULT_SCREENING_PROMPT;
}

/** AI判定タブを描画する */
export function renderFulltextAi(): void {
    populateModelSelect();
    if (!aiInitialized) {
        prefillPrompt();
        aiInitialized = true;
    }
    updateAiTargetCount();
}

/** 対象件数の表示を更新する */
function updateAiTargetCount(): void {
    const candidates = getFulltextCandidateList();
    const eligible = candidates.filter(isAiEligible).length;
    const cached = candidates.filter(r => r.fulltext_status === 'cached' && r.fulltext_url).length;
    dom.fulltextAiTargetDiv.innerHTML =
        `<span class="fulltext-ai-target-main">${escapeHtml(t('fulltext_aiTarget', String(eligible)))}</span>` +
        `<span class="fulltext-ai-target-sub">${escapeHtml(t('fulltext_aiTargetSub', String(cached)))}</span>`;
}

/** ログ行を追加する */
function appendLog(text: string, cls = ''): void {
    const line = document.createElement('div');
    line.className = `fulltext-ai-log-line ${cls}`.trim();
    line.textContent = text;
    dom.fulltextAiLogDiv.appendChild(line);
    dom.fulltextAiLogDiv.scrollTop = dom.fulltextAiLogDiv.scrollHeight;
}

/** 進捗バー・テキストを更新する */
function updateProgress(done: number, total: number, ok: number, ng: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    dom.fulltextAiProgressFill.style.width = `${pct}%`;
    dom.fulltextAiProgressText.textContent = t('fulltext_aiProgress', [String(done), String(total), String(ok), String(ng)]);
}

/** 一括AI判定を開始する */
async function handleStartAiBatch(): Promise<void> {
    if (aiAbort) return; // 二重起動防止

    const apiKey = await getEffectiveApiKey();
    if (!apiKey) {
        showToast(t('llm_apiKeyRequired'));
        return;
    }

    const screeningPrompt = dom.fulltextAiPromptInput.value.trim() || DEFAULT_SCREENING_PROMPT;
    const modelId = dom.fulltextAiModelSelect.value || AVAILABLE_MODELS.find(m => m.provider === 'gemini')!.id;
    const modelConfig = getModelConfig(modelId);

    const candidates = getFulltextCandidateList();
    const targets = candidates.filter(isAiEligible);
    if (targets.length === 0) {
        showToast(t('fulltext_aiNoTarget'));
        return;
    }

    // この一括判定を1つの判定者(voter)として扱う共通 reviewer_id
    const batchTimestamp = new Date();
    const reviewerId = generateLlmReviewerId(modelConfig.model, batchTimestamp);
    const executionId = reviewerId;
    const spreadsheetId = state.spreadsheetId;

    // UI: 実行状態へ
    aiAbort = { cancelled: false };
    dom.fulltextAiStartBtn.classList.add('hidden');
    dom.fulltextAiStopBtn.classList.remove('hidden');
    dom.fulltextAiProgressDiv.classList.remove('hidden');
    dom.fulltextAiLogDiv.innerHTML = '';
    dom.fulltextAiModelSelect.disabled = true;
    dom.fulltextAiPromptInput.disabled = true;

    let done = 0, ok = 0, ng = 0;
    updateProgress(0, targets.length, 0, 0);
    appendLog(t('fulltext_aiStarted', String(targets.length)));

    try {
        for (const ref of targets) {
            if (aiAbort?.cancelled) {
                appendLog(t('fulltext_aiCancelled'), 'log-warn');
                break;
            }
            try {
                await judgeOne(ref, screeningPrompt, modelConfig, reviewerId, executionId, modelId, spreadsheetId);
                ok++;
                appendLog(`✓ ${ref.title || ref.ref_id}`, 'log-ok');
            } catch (err) {
                ng++;
                const msg = err instanceof Error ? err.message : String(err);
                appendLog(`✕ ${ref.title || ref.ref_id} — ${msg}`, 'log-err');
            } finally {
                done++;
                updateProgress(done, targets.length, ok, ng);
            }
        }
    } finally {
        // 判定結果を反映するため参照を再読込
        await reloadReferences(spreadsheetId);
        dom.fulltextAiStartBtn.classList.remove('hidden');
        dom.fulltextAiStopBtn.classList.add('hidden');
        dom.fulltextAiModelSelect.disabled = false;
        dom.fulltextAiPromptInput.disabled = false;
        updateAiTargetCount();
        aiAbort = null;
        appendLog(t('fulltext_aiDone', [String(ok), String(ng)]), 'log-done');
        showToast(t('fulltext_aiDone', [String(ok), String(ng)]), 4000);
    }
}

/** 1件のPDFをGeminiで判定し、Decisions タブへ確定保存する */
async function judgeOne(
    ref: ReferenceWithStatus,
    screeningPrompt: string,
    modelConfig: ReturnType<typeof getModelConfig>,
    reviewerId: string,
    executionId: string,
    requestedModel: string,
    spreadsheetId: string
): Promise<void> {
    const fileId = ref.fulltext_url ? extractDriveFileId(ref.fulltext_url) : null;
    if (!fileId) throw new Error(t('fulltext_aiErrNoDrive'));

    const blob = await downloadDriveFile(fileId);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const { output, usageMetadata, responseMetadata } = await judgeFulltext(
        bytes, screeningPrompt, modelConfig
    );

    const note: FulltextLlmDecisionNote = {
        type: 'llm_fulltext',
        execution_id: executionId,
        model: modelConfig.model,
        requested_model: requestedModel,
        model_version: responseMetadata?.modelVersion,
        response_id: responseMetadata?.responseId,
        include_probability: output.include_probability,
        reason: output.reason,
        exclude_reason_category: output.exclude_reason_category,
        evidence: output.evidence,
        prompt_version: FULLTEXT_PROMPT_VERSION,
        usageMetadata,
    };

    const decision: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: reviewerId,
        decision: normalizeDecision(output),
        // 除外時は Decisions の reason 列に PRISMA 区分を入れる（人間判定と同じ運用）
        reason: output.decision === 'exclude' ? (output.exclude_reason_category || 'other') : undefined,
        note: JSON.stringify(note),
        decided_at: new Date().toISOString(),
        client_version: getClientVersion('-llm'),
        screening_phase: 'fulltext',
    };

    await saveDecision(spreadsheetId, decision);
}

/** 出力の decision を最終決定に正規化（maybe はそのまま保持） */
function normalizeDecision(output: FulltextJudgeOutput): 'include' | 'exclude' | 'maybe' {
    if (output.decision === 'include' || output.decision === 'exclude' || output.decision === 'maybe') {
        return output.decision;
    }
    return output.include_probability >= 0.5 ? 'include' : 'exclude';
}

/** 参照を再読込して state を更新する（refreshReferencesAfterBatch と同じロジック） */
async function reloadReferences(spreadsheetId: string): Promise<void> {
    try {
        const userEmail = state.userEmail;
        const isKeyOpened = state.isKeyOpened;
        const refs = isKeyOpened
            ? await getReferencesWithAllDecisions(spreadsheetId, userEmail)
            : await getReferencesWithStatus(spreadsheetId, userEmail);

        const visibleRefs = (() => {
            if (state.isAdmin) return refs;
            const config = state.assignmentConfig;
            if (config.status !== 'configured') return refs;
            const assignedSets = getAssignedSetsForUser(config, userEmail);
            return refs.filter(ref => assignedSets.has(getReferenceAssignmentSet(ref)));
        })();

        syncSetReferences(visibleRefs);
    } catch (error) {
        console.error('[fulltext-ai] Failed to reload references:', error);
    }
}

/** 実行を中断する */
function handleStopAiBatch(): void {
    if (aiAbort) {
        aiAbort.cancelled = true;
        dom.fulltextAiStopBtn.disabled = true;
        appendLog(t('fulltext_aiCancelling'), 'log-warn');
    }
}

export function setupFulltextAiListeners(): void {
    dom.fulltextAiStartBtn?.addEventListener('click', () => { void handleStartAiBatch(); });
    dom.fulltextAiStopBtn?.addEventListener('click', () => {
        dom.fulltextAiStopBtn.disabled = false;
        handleStopAiBatch();
    });
}
