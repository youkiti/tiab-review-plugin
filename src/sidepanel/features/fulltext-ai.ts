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
 * - **対象範囲の既定はプロジェクト全体**。AIは人間とは独立した判定者なので、人間側の
 *   分業（フルテキスト担当割り振り・担当セット絞り込み）では対象を絞らない。
 *   自分の担当分だけ試したいときはラジオで `assigned` を選ぶ。詳細は `lib/fulltext-ai-target.ts`
 * - **「AI判定済み」の判定は Decisions タブの再読込で行う**（Blind 中は参照側の
 *   allFulltextDecisions が空になり、票から導くと同じPDFを何度も課金してしまうため）
 */

import { dom } from '../dom';
import { state } from '../state';
import { t } from '../../lib/i18n';
import { escapeHtml } from '../utils/text';
import { showToast } from '../ui/feedback';
import { getVisibleFulltextCandidateList, getProjectFulltextCandidateList } from './screening/filters';
import { getAssignedSetsForUser, getReferenceAssignmentSet } from './assignment';
import { setReferences as syncSetReferences } from '../store/compat';
import {
    getReferencesWithStatus,
    getReferencesWithAllDecisions,
    saveDecision,
    getLlmConfig,
    getDecisions,
    getFulltextAiActiveRound,
    setFulltextAiActiveRound,
    deleteFulltextAiRound,
} from '../../lib/sheets-api';
import { setLlmConfig as syncSetLlmConfig } from '../store/compat';
import {
    extractDriveFileId,
    downloadDriveFile,
    describeDriveAccessError,
    DriveAccessDeniedError,
} from '../../lib/drive-api';
import { judgeFulltext, FULLTEXT_PROMPT_VERSION } from '../../lib/gemini-fulltext';
import { detectImageOnlyPdf } from '../../lib/pdf-image-only';
import { generateLlmReviewerId } from '../../lib/llm-processor';
import { getModelConfig, AVAILABLE_MODELS } from '../../lib/gemini-api';
import { getEffectiveApiKey } from '../../lib/storage';
import { getClientVersion } from '../../lib/client-version';
import { DEFAULT_SCREENING_PROMPT, generateScreeningPromptFromCriteria } from '../../lib/prompt-templates';
import {
    DEFAULT_FULLTEXT_AI_SCOPE,
    collectAiJudgedRefIds,
    countFulltextAiTargets,
    parseFulltextAiScope,
    selectFulltextAiTargets,
    type FulltextAiScope,
} from '../../lib/fulltext-ai-target';
import type { LlmConfig } from '../../lib/types';
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
// 対象範囲（既定はプロジェクト全体。人間の担当割り振りでは絞らない）
let aiScope: FulltextAiScope = DEFAULT_FULLTEXT_AI_SCOPE;
// 採用ラウンドが判定済みの ref_id（renderRounds が Decisions タブから更新するキャッシュ）
let judgedRefIds: ReadonlySet<string> = new Set<string>();

/**
 * 対象範囲に応じた候補一覧を返す
 * - project: プロジェクト全体（担当割り振り・担当セット絞り込みを無視）
 * - assigned: 自分の担当分＋担当セット絞り込み（候補リストタブと同じ見え方）
 */
function getScopedCandidates(scope: FulltextAiScope): ReferenceWithStatus[] {
    return scope === 'project'
        ? getProjectFulltextCandidateList()
        : getVisibleFulltextCandidateList();
}

/** Decisions タブと採用ラウンドを読み直して「判定済み ref_id」を取得する */
async function fetchJudgedRefIds(spreadsheetId: string): Promise<Set<string>> {
    const [decisions, activeRound] = await Promise.all([
        getDecisions(spreadsheetId),
        getFulltextAiActiveRound(spreadsheetId),
    ]);
    return collectAiJudgedRefIds(
        decisions.map(x => x.decision),
        activeRound ? new Set([activeRound]) : new Set<string>()
    );
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

/**
 * TiAb の設定から「実効スクリーニングプロンプト」を組む。
 * TiAb バッチと同じ優先順:
 *   1. 最適化済みプロンプト（llm_screening_prompt）
 *   2. 判定基準（llm_criteria）から生成
 *   3. 汎用デフォルト
 */
function buildEffectivePrompt(cfg: LlmConfig): string {
    if (cfg.llm_screening_prompt && cfg.llm_screening_prompt.trim()) {
        return cfg.llm_screening_prompt;
    }
    if (cfg.llm_criteria) {
        return generateScreeningPromptFromCriteria(cfg.llm_criteria);
    }
    return DEFAULT_SCREENING_PROMPT;
}

/**
 * プロンプトを TiAb の設定からプリフィルする。
 * state.llmConfig は LLM タブを開くまでロードされないため、未ロードならシートから取得する。
 */
async function prefillPrompt(): Promise<void> {
    const input = dom.fulltextAiPromptInput;
    if (input.value.trim()) return; // ユーザー入力済みなら尊重

    let cfg = state.llmConfig;
    // 未ロード（プロンプトも基準も空）ならシートから取得して state に反映
    const looksUnloaded = !cfg || (!cfg.llm_screening_prompt && !cfg.llm_criteria);
    if (looksUnloaded && state.spreadsheetId) {
        try {
            cfg = await getLlmConfig(state.spreadsheetId);
            syncSetLlmConfig(cfg);
        } catch (err) {
            console.warn('[fulltext-ai] LLM設定の取得に失敗:', err);
        }
    }
    // プリフィル前に再度ユーザー入力をチェック（await 中に入力された場合に上書きしない）
    if (input.value.trim()) return;
    input.value = buildEffectivePrompt(cfg);
}

/** AI判定タブを描画する */
export function renderFulltextAi(): void {
    populateModelSelect();
    if (!aiInitialized) {
        aiInitialized = true;
        void prefillPrompt();
    }
    syncScopeRadios();
    updateAiTargetCount();
    // 判定済み ref_id を Decisions タブから取り直し、件数表示も更新する
    void renderRounds();
}

/** 対象範囲ラジオの表示を現在値に合わせる */
function syncScopeRadios(): void {
    dom.fulltextAiScopeProjectRadio.checked = aiScope === 'project';
    dom.fulltextAiScopeAssignedRadio.checked = aiScope === 'assigned';
}

// ---------------------------------------------------------------------------
// 判定ラウンド: 採用ラジオ + 削除（TiAb の Run 履歴に相当）
// ---------------------------------------------------------------------------

interface AiRound {
    reviewerId: string;
    model: string;
    timestamp: string;
    include: number;
    exclude: number;
    maybe: number;
    total: number;
}

/** fulltext フェーズの llm: 判定を reviewer_id 単位のラウンドへ集約する */
function deriveRounds(decisions: Decision[]): AiRound[] {
    const map = new Map<string, AiRound>();
    for (const d of decisions) {
        if ((d.screening_phase ?? 'tiab') !== 'fulltext') continue;
        const rid = (d.reviewer_id || '').trim();
        if (!rid.startsWith('llm:')) continue;
        let r = map.get(rid);
        if (!r) {
            const body = rid.slice('llm:'.length);
            const at = body.lastIndexOf('@'); // ISO タイムスタンプに '@' は含まれない
            r = {
                reviewerId: rid,
                model: at >= 0 ? body.slice(0, at) : body,
                timestamp: at >= 0 ? body.slice(at + 1) : '',
                include: 0, exclude: 0, maybe: 0, total: 0,
            };
            map.set(rid, r);
        }
        r.total++;
        if (d.decision === 'include') r.include++;
        else if (d.decision === 'exclude') r.exclude++;
        else if (d.decision === 'maybe') r.maybe++;
    }
    return [...map.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** ISO 文字列を読みやすい日時へ（失敗時は原文） */
function formatTimestamp(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** ラウンド一覧（採用ラジオ＋削除）を再描画する */
async function renderRounds(): Promise<void> {
    const container = dom.fulltextAiRoundsDiv;
    if (!container) return;

    let decisions: Decision[] = [];
    let active: string | null = null;
    try {
        const [dec, act] = await Promise.all([
            getDecisions(state.spreadsheetId),
            getFulltextAiActiveRound(state.spreadsheetId),
        ]);
        decisions = dec.map(x => x.decision);
        active = act;
        // 「AI判定済み」は Blind 中に参照側の票から導けないため、ここで取得した
        // Decisions 行から採用ラウンド基準で作り直す（対象件数表示もこの値を使う）
        judgedRefIds = collectAiJudgedRefIds(decisions, active ? new Set([active]) : new Set<string>());
        updateAiTargetCount();
    } catch (err) {
        // 無言で空にすると「ラウンドがまだ無い」状態と見分けが付かないため、失敗を明示する
        console.warn('[fulltext-ai] ラウンド取得に失敗:', err);
        container.innerHTML = '';
        const error = document.createElement('div');
        error.className = 'fulltext-ai-rounds-error';
        error.textContent = t('fulltext_aiRoundsError', err instanceof Error ? err.message : String(err));
        container.appendChild(error);
        return;
    }

    const rounds = deriveRounds(decisions);
    container.innerHTML = '';

    if (rounds.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'fulltext-ai-rounds-empty';
        empty.textContent = t('fulltext_aiRoundsEmpty');
        container.appendChild(empty);
        return;
    }

    // ラウンドがあるのに未採用だと、全文閲覧ウィンドウでハイライトが一切出ない。
    // 気づけないまま使われる状態なので、選択を促す注意を先頭に出す。
    if (!active) {
        const notice = document.createElement('div');
        notice.className = 'fulltext-ai-rounds-notice';
        notice.textContent = t('fulltext_aiRoundsNotAdopted');
        container.appendChild(notice);
    }

    // 「採用なし」行
    container.appendChild(buildNoneRow(active));
    for (const r of rounds) {
        container.appendChild(buildRoundRow(r, active));
    }
}

/** 「採用なし」を選ぶラジオ行 */
function buildNoneRow(active: string | null): HTMLElement {
    const row = document.createElement('label');
    row.className = 'fulltext-ai-round-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ft-ai-round';
    radio.checked = !active;
    radio.addEventListener('change', () => { if (radio.checked) void adoptRound(null); });
    const label = document.createElement('span');
    label.className = 'fulltext-ai-round-none';
    label.textContent = t('fulltext_aiRoundNone');
    row.append(radio, label);
    return row;
}

/** 1ラウンドの行（採用ラジオ・情報・削除ボタン） */
function buildRoundRow(r: AiRound, active: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'fulltext-ai-round-row';
    if (r.reviewerId === active) row.classList.add('active');

    const main = document.createElement('label');
    main.className = 'fulltext-ai-round-main';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ft-ai-round';
    radio.checked = r.reviewerId === active;
    radio.addEventListener('change', () => { if (radio.checked) void adoptRound(r.reviewerId); });

    const info = document.createElement('span');
    info.className = 'fulltext-ai-round-info';
    const title = document.createElement('span');
    title.className = 'fulltext-ai-round-title';
    title.textContent = `${r.model} · ${formatTimestamp(r.timestamp)}`;
    const counts = document.createElement('span');
    counts.className = 'fulltext-ai-round-counts';
    counts.textContent = t('fulltext_aiRoundCounts', [String(r.include), String(r.exclude), String(r.maybe), String(r.total)]);
    info.append(title, counts);

    main.append(radio, info);

    const del = document.createElement('button');
    del.className = 'fulltext-ai-round-delete';
    del.textContent = t('fulltext_aiRoundDelete');
    del.addEventListener('click', () => { void deleteRound(r.reviewerId); });

    row.append(main, del);
    return row;
}

/** ラウンドを採用（null で採用解除）する */
async function adoptRound(reviewerId: string | null): Promise<void> {
    try {
        await setFulltextAiActiveRound(state.spreadsheetId, reviewerId);
        await reloadReferences(state.spreadsheetId);
        showToast(reviewerId ? t('fulltext_aiRoundAdopted') : t('fulltext_aiRoundNone'), 2500);
        void renderRounds();
    } catch (err) {
        showToast(`採用の保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`, 4000);
        void renderRounds();
    }
}

/** ラウンドを削除する */
async function deleteRound(reviewerId: string): Promise<void> {
    if (!window.confirm(t('fulltext_aiRoundDeleteConfirm'))) return;
    try {
        const n = await deleteFulltextAiRound(state.spreadsheetId, reviewerId);
        await reloadReferences(state.spreadsheetId);
        showToast(t('fulltext_aiRoundDeleted', String(n)), 3000);
        void renderRounds();
        updateAiTargetCount();
    } catch (err) {
        showToast(`削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`, 4000);
    }
}

/** 対象件数の表示を更新する */
function updateAiTargetCount(): void {
    const counts = countFulltextAiTargets(getScopedCandidates(aiScope), judgedRefIds);

    const lines = [
        `<span class="fulltext-ai-target-main">${escapeHtml(t('fulltext_aiTarget', String(counts.target)))}</span>`,
        `<span class="fulltext-ai-target-sub">${escapeHtml(t('fulltext_aiTargetSub', String(counts.cached)))}</span>`,
    ];

    // 採用ラウンドで判定済みのため除外した件数（0件表示の理由が分からなくなるのを防ぐ）
    if (counts.alreadyJudged > 0) {
        lines.push(
            `<span class="fulltext-ai-target-sub">${escapeHtml(t('fulltext_aiTargetJudged', String(counts.alreadyJudged)))}</span>`
        );
    }

    // プロジェクト全体を対象にしているとき、そのうち自分の担当分が何件かを併記する
    // （担当割り振りをしていて件数が変わる場合のみ）
    if (aiScope === 'project') {
        const assigned = countFulltextAiTargets(getScopedCandidates('assigned'), judgedRefIds);
        if (assigned.target !== counts.target) {
            lines.push(
                `<span class="fulltext-ai-target-sub">${escapeHtml(t('fulltext_aiTargetAssignedShare', String(assigned.target)))}</span>`
            );
        }
    }

    dom.fulltextAiTargetDiv.innerHTML = lines.join('');
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

    const spreadsheetId = state.spreadsheetId;

    // 実行直前だけは Decisions タブを読み直し、サーバーの真値で「判定済み」を確定する
    // （画面表示のキャッシュはタブを開いた時点のスナップショットで、他レビュアーが
    //   直前に実行した分を取りこぼす）。読み取りに失敗した場合はキャッシュで続行する
    let refetchFailed = false;
    try {
        judgedRefIds = await fetchJudgedRefIds(spreadsheetId);
    } catch (err) {
        refetchFailed = true;
        console.warn('[fulltext-ai] 判定済み ref_id の再取得に失敗:', err);
    }

    const targets = selectFulltextAiTargets(getScopedCandidates(aiScope), judgedRefIds);
    if (targets.length === 0) {
        updateAiTargetCount();
        showToast(t('fulltext_aiNoTarget'));
        return;
    }

    // この一括判定を1つの判定者(voter)として扱う共通 reviewer_id
    const batchTimestamp = new Date();
    const reviewerId = generateLlmReviewerId(modelConfig.model, batchTimestamp);
    const executionId = reviewerId;

    // UI: 実行状態へ
    aiAbort = { cancelled: false };
    dom.fulltextAiStartBtn.classList.add('hidden');
    dom.fulltextAiStopBtn.classList.remove('hidden');
    dom.fulltextAiStopBtn.disabled = false;
    dom.fulltextAiProgressDiv.classList.remove('hidden');
    dom.fulltextAiLogDiv.innerHTML = '';
    dom.fulltextAiModelSelect.disabled = true;
    dom.fulltextAiPromptInput.disabled = true;
    setScopeRadiosDisabled(true);
    if (refetchFailed) appendLog(t('fulltext_aiJudgedRefetchFailed'), 'log-warn');

    let done = 0, ok = 0, ng = 0;
    // Drive の読み取り権限が無くて落ちた件数（drive.file は「アプリ×ユーザー×ファイル」単位の
    // 付与なので、他メンバーがアップロードしたPDFは読めない。プロジェクト全体を対象にすると
    // まとまった件数で起きうるため、最後に復旧導線をまとめて案内する）
    let driveDenied = 0;
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
                if (err instanceof DriveAccessDeniedError) driveDenied++;
                const msg = err instanceof Error ? err.message : String(err);
                appendLog(`✕ ${ref.title || ref.ref_id} — ${describeDriveAccessError(err) ?? msg}`, 'log-err');
            } finally {
                done++;
                updateProgress(done, targets.length, ok, ng);
            }
        }
    } finally {
        // 1件以上成功していれば、今回のラウンドを自動採用する（中断時は採用しない）
        if (ok > 0 && !aiAbort?.cancelled) {
            try {
                await setFulltextAiActiveRound(spreadsheetId, reviewerId);
                showToast(t('fulltext_aiRoundAdopted'), 2500);
            } catch (err) {
                console.warn('[fulltext-ai] 自動採用に失敗:', err);
            }
        }
        // 判定結果を反映するため参照を再読込
        await reloadReferences(spreadsheetId);
        dom.fulltextAiStartBtn.classList.remove('hidden');
        dom.fulltextAiStopBtn.classList.add('hidden');
        dom.fulltextAiStopBtn.disabled = false;
        dom.fulltextAiModelSelect.disabled = false;
        dom.fulltextAiPromptInput.disabled = false;
        setScopeRadiosDisabled(false);
        updateAiTargetCount();
        void renderRounds();
        aiAbort = null;
        appendLog(t('fulltext_aiDone', [String(ok), String(ng)]), 'log-done');
        if (driveDenied > 0) {
            appendLog(t('fulltext_aiDriveDeniedHint', String(driveDenied)), 'log-warn');
        }
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

    // スキャン(画像only)PDFかを判定時に記録し、ビューアの表示経路によらず
    // 「ハイライト精度が落ちる」注意を出せるようにする。検出失敗でも判定は続行する。
    let imageOnly: boolean | undefined;
    try {
        imageOnly = (await detectImageOnlyPdf(bytes)).imageOnly;
    } catch (err) {
        console.warn('[fulltext-ai] image-only detection failed:', err);
    }

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
        image_only: imageOnly,
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

/**
 * 参照を再読込して state を更新する（refreshReferencesAfterBatch と同じロジック）。
 * fulltext-results.ts の裁定票保存後の再読込からも呼ばれる（同じ処理を書き起こさず、この経路を共有する）。
 */
export async function reloadReferences(spreadsheetId: string): Promise<void> {
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
        // プロジェクト全体を対象にする表示（対象件数・結果タブ）が絞り込み前の
        // 全文献を見るため、こちらも一緒に更新する
        state.setAllReferences(refs);
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

/** 実行中は対象範囲を変えられないようにする */
function setScopeRadiosDisabled(disabled: boolean): void {
    dom.fulltextAiScopeProjectRadio.disabled = disabled;
    dom.fulltextAiScopeAssignedRadio.disabled = disabled;
}

/** 対象範囲の変更を反映する */
function handleScopeChange(scope: FulltextAiScope): void {
    aiScope = parseFulltextAiScope(scope);
    updateAiTargetCount();
}

export function setupFulltextAiListeners(): void {
    dom.fulltextAiStartBtn?.addEventListener('click', () => { void handleStartAiBatch(); });
    dom.fulltextAiStopBtn?.addEventListener('click', () => {
        dom.fulltextAiStopBtn.disabled = false;
        handleStopAiBatch();
    });
    dom.fulltextAiScopeProjectRadio?.addEventListener('change', () => {
        if (dom.fulltextAiScopeProjectRadio.checked) handleScopeChange('project');
    });
    dom.fulltextAiScopeAssignedRadio?.addEventListener('change', () => {
        if (dom.fulltextAiScopeAssignedRadio.checked) handleScopeChange('assigned');
    });
}
