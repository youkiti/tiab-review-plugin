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
    saveLlmExecution,
    updateLlmExecution,
    getLlmExecutions,
} from '../../lib/sheets-api';
import { setLlmConfig as syncSetLlmConfig } from '../store/compat';
import {
    extractDriveFileId,
    downloadDriveFile,
    describeDriveAccessError,
    DriveAccessDeniedError,
} from '../../lib/drive-api';
import { judgeFulltext, FULLTEXT_PROMPT_VERSION } from '../../lib/gemini-fulltext';
import { normalizeExcludeReasonKey } from '../../lib/exclude-reasons';
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
import {
    classifyFulltextAiFailure,
    summarizeFailures,
    serializeFailureBreakdown,
    NoDriveUrlError,
    PdfReadError,
    LlmCallError,
    type FulltextAiFailureKind,
} from '../../lib/fulltext-ai-failures';
import {
    deriveRounds,
    mergeRoundsWithExecutions,
    type AiRoundWithExecution,
} from '../../lib/fulltext-ai-rounds';
import type { LlmConfig } from '../../lib/types';
import type {
    ReferenceWithStatus,
    Decision,
    FulltextLlmDecisionNote,
    FulltextJudgeOutput,
    LlmExecution,
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

// AiRound / deriveRounds は src/lib/fulltext-ai-rounds.ts へ移した
// （Decisions由来のラウンドと LLM_Executions の実行履歴を結合する純関数を DOM から切り離すため）。

/** 失敗種別 → i18n キーの対応。UI表示専用（純関数側の分類ロジックとは分離する） */
const FAILURE_KIND_I18N_KEY: Record<FulltextAiFailureKind, string> = {
    drive_denied: 'fulltext_aiFailureKindDriveDenied',
    drive_not_found: 'fulltext_aiFailureKindDriveNotFound',
    drive_auth: 'fulltext_aiFailureKindDriveAuth',
    drive_transient: 'fulltext_aiFailureKindDriveTransient',
    no_drive_url: 'fulltext_aiFailureKindNoDriveUrl',
    pdf: 'fulltext_aiFailureKindPdf',
    llm: 'fulltext_aiFailureKindLlm',
    other: 'fulltext_aiFailureKindOther',
};

// シート直編集等で内訳に混入しうる未知キーを弾くための既知順序（表示順を安定させる）
const FAILURE_KIND_ORDER: FulltextAiFailureKind[] = [
    'drive_denied', 'drive_not_found', 'drive_auth', 'drive_transient',
    'no_drive_url', 'pdf', 'llm', 'other',
];

/** 失敗内訳を「理由: 件数」の読める文へ組み立てる（対処が分かる文言は FAILURE_KIND_I18N_KEY 側で用意） */
function formatFailureBreakdown(breakdown: Partial<Record<FulltextAiFailureKind, number>>): string {
    return FAILURE_KIND_ORDER
        .filter(kind => (breakdown[kind] ?? 0) > 0)
        .map(kind => `${t(FAILURE_KIND_I18N_KEY[kind])}: ${breakdown[kind]}`)
        .join(', ');
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

    // 実行履歴（失敗件数・内訳等）は付加情報にすぎないため、取得に失敗しても
    // ラウンド一覧そのものは従来どおり表示する（Decisions取得失敗とは別枠でcatchする）。
    // 全件失敗したラウンドは Decisions に1行も無いため、失敗時は「実行履歴のみのラウンド」が
    // 一覧から抜け落ちるが、それ以外の表示（採用ラジオ等）は維持できる。
    let executions: LlmExecution[] = [];
    try {
        executions = await getLlmExecutions(state.spreadsheetId);
    } catch (err) {
        console.warn('[fulltext-ai] 実行履歴の取得に失敗:', err);
    }

    const rounds = mergeRoundsWithExecutions(deriveRounds(decisions), executions);
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
function buildRoundRow(r: AiRoundWithExecution, active: string | null): HTMLElement {
    const row = document.createElement('div');
    row.className = 'fulltext-ai-round-row';
    if (r.reviewerId === active) row.classList.add('active');

    // 0件成功のラウンド（executions側にしか無い＝全件失敗）は、採用しても Decisions に
    // 票が無く意味がなく、削除しても消す行が無いため採用ラジオ・削除ボタンを無効化する
    const zeroSuccess = r.total === 0;
    if (zeroSuccess) row.classList.add('zero-success');

    const main = document.createElement('label');
    main.className = 'fulltext-ai-round-main';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'ft-ai-round';
    radio.checked = r.reviewerId === active;
    radio.disabled = zeroSuccess;
    if (zeroSuccess) radio.title = t('fulltext_aiRoundZeroSuccessHint');
    radio.addEventListener('change', () => { if (radio.checked) void adoptRound(r.reviewerId); });

    const info = document.createElement('span');
    info.className = 'fulltext-ai-round-info';
    const title = document.createElement('span');
    title.className = 'fulltext-ai-round-title';
    title.textContent = `${r.model} · ${formatTimestamp(r.timestamp)}`;
    info.appendChild(title);

    // 実行者（Drive の失敗は実行者固有の事実。drive.file は「アプリ×ユーザー×ファイル」単位の
    // 付与なので、どのアカウントで権限を付与し直せば良いかはここに出さないと特定できない）
    // executedBy が無い（実行履歴の無い過去のラウンド）ときは何も出さない
    if (r.executedBy) {
        const executedBy = document.createElement('span');
        executedBy.className = 'fulltext-ai-round-executed-by';
        executedBy.textContent = t('fulltext_aiRoundExecutedBy', r.executedBy);
        info.appendChild(executedBy);
    }

    const counts = document.createElement('span');
    counts.className = 'fulltext-ai-round-counts';
    counts.textContent = t('fulltext_aiRoundCounts', [String(r.include), String(r.exclude), String(r.maybe), String(r.total)]);
    info.appendChild(counts);

    // 処理済み/対象件数（実行履歴があるラウンドのみ）。isIncomplete のときは未完了である旨も添える。
    // 新しい列は足さず、実行履歴側の件数から導出した値（PR #102 レビュー指摘: 中断した実行が
    // 完了実行と見分けが付かない問題への対応。詳細は fulltext-ai-rounds.ts の processedCount/
    // isIncomplete のコメント参照）
    if (r.hasExecution && r.targetCount !== null) {
        const processed = document.createElement('span');
        processed.className = 'fulltext-ai-round-processed';
        if (r.isIncomplete) processed.classList.add('incomplete');
        processed.textContent = r.isIncomplete
            ? t('fulltext_aiRoundProcessedIncomplete', [String(r.processedCount), String(r.targetCount)])
            : t('fulltext_aiRoundProcessed', [String(r.processedCount), String(r.targetCount)]);
        info.appendChild(processed);
    }

    // 失敗件数・内訳（1件以上あるときだけ表示）。「ファイルが壊れている」ではなく
    // 「実行したアカウントから読み取れなかった」旨が伝わるよう、対処が分かる文言にする
    // （FAILURE_KIND_I18N_KEY / formatFailureBreakdown 参照）
    if (r.failedCount > 0) {
        const failed = document.createElement('span');
        failed.className = 'fulltext-ai-round-failed';
        failed.textContent = t('fulltext_aiRoundFailed', [String(r.failedCount), formatFailureBreakdown(r.failureBreakdown)]);
        info.appendChild(failed);
    }

    // 0件成功の理由をラウンド行自体に明示する（無効化しただけだと理由が分からないため）
    if (zeroSuccess) {
        const zeroNotice = document.createElement('span');
        zeroNotice.className = 'fulltext-ai-round-zero-notice';
        zeroNotice.textContent = t('fulltext_aiRoundZeroSuccessHint');
        info.appendChild(zeroNotice);
    }

    main.append(radio, info);

    const del = document.createElement('button');
    del.className = 'fulltext-ai-round-delete';
    del.textContent = t('fulltext_aiRoundDelete');
    del.disabled = zeroSuccess;
    if (zeroSuccess) del.title = t('fulltext_aiRoundZeroSuccessHint');
    del.addEventListener('click', () => { if (!zeroSuccess) void deleteRound(r.reviewerId); });

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

    // 実行履歴（LLM_Executions）に開始行を先書きする。中断・全件失敗でも「実行した」事実が
    // 残るようにするのが本Issueの主眼。References/Decisions タブは一切触らない
    // （fulltext_status を書き換えると候補プールから全員分外れ、Decisions に失敗行を書くと
    //   κ算出とラウンド管理が壊れるため）。
    const initialExecution: LlmExecution = {
        execution_id: executionId,
        execution_type: 'fulltext_batch_screening',
        timestamp: batchTimestamp.toISOString(),
        model: modelConfig.model,
        requested_model: modelId,
        temperature: modelConfig.temperature,
        topP: modelConfig.topP,
        thinkingLevel: modelConfig.thinkingLevel,
        // フルテキストAI判定の判定基準は TiAb の criteria_snapshot（LlmCriteria）とそのまま
        // 対応しない。buildEffectivePrompt() は llm_criteria をプロンプト生成の入力の1つとして
        // 使っているため、それが読み込み済みならスナップショットとして入れる。無ければ
        // （PICO等のテンプレートを使わずプロンプトを直接編集した場合など）意味のある値が無いので null。
        criteria_snapshot: state.llmConfig?.llm_criteria ?? null,
        screening_prompt: screeningPrompt,
        include_threshold: 0, // フルテキストは3値(include/exclude/maybe)判定で閾値の概念が無いため未使用
        target_count: targets.length,
        include_count: 0,
        exclude_count: 0,
        maybe_count: 0,
        status: 'pending',
        // フルテキストAI判定の採用状態は Config の fulltext_ai_active_round が正であり、
        // LLM_Executions.is_active と二重管理しないため常に false 固定にする
        is_active: false,
        executed_by: state.userEmail,
        // AI判定のスキーマ(enum)・プロンプトはこのリストから生成される（judgeOne の judgeFulltext 呼び出し
        // 参照）。あとで fulltext_exclude_reasons のラベルを変えても、この Run が何の区分で判定したかを
        // 復元できるようにスナップショットを残す（criteria_snapshot / screening_prompt と同列）。
        exclude_reasons_snapshot: JSON.stringify(state.excludeReasonItems),
    };
    // 開始行の保存に成功したか（終了時の記録方法をこれで分岐する。must-fix 3 参照）
    let executionLogWritten = false;
    try {
        await saveLlmExecution(spreadsheetId, initialExecution);
        executionLogWritten = true;
    } catch (err) {
        // 履歴の書き込み失敗は判定結果より軽い。判定処理自体は止めず、警告として出すだけにする
        console.warn('[fulltext-ai] 実行履歴（開始）の保存に失敗:', err);
        appendLog(t('fulltext_aiExecutionLogFailed'), 'log-warn');
    }

    let done = 0, ok = 0, ng = 0;
    // Drive の読み取り権限が無くて落ちた件数（drive.file は「アプリ×ユーザー×ファイル」単位の
    // 付与なので、他メンバーがアップロードしたPDFは読めない。プロジェクト全体を対象にすると
    // まとまった件数で起きうるため、最後に復旧導線をまとめて案内する）。
    // 定義上 failureKinds の drive_denied + drive_not_found の件数と一致するはずなので、
    // 分類ロジック（classifyFulltextAiFailure）側だけを直して乖離させないこと。
    let driveDenied = 0;
    // include/exclude/maybe の内訳（実行履歴の include_count/exclude_count/maybe_count に使う）
    const decisionCounts: Record<'include' | 'exclude' | 'maybe', number> = { include: 0, exclude: 0, maybe: 0 };
    // 失敗種別ごとの内訳（実行履歴の failure_breakdown に使う）
    const failureKinds: FulltextAiFailureKind[] = [];
    updateProgress(0, targets.length, 0, 0);
    appendLog(t('fulltext_aiStarted', String(targets.length)));

    try {
        for (const ref of targets) {
            if (aiAbort?.cancelled) {
                appendLog(t('fulltext_aiCancelled'), 'log-warn');
                break;
            }
            try {
                const decision = await judgeOne(ref, screeningPrompt, modelConfig, reviewerId, executionId, modelId, spreadsheetId);
                ok++;
                decisionCounts[decision]++;
                appendLog(`✓ ${ref.title || ref.ref_id}`, 'log-ok');
            } catch (err) {
                ng++;
                if (err instanceof DriveAccessDeniedError) driveDenied++;
                failureKinds.push(classifyFulltextAiFailure(err));
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

        // 実行履歴を確定させる。中断・全件失敗でも「実行したが0件成功だった」という事実自体を
        // 残すのが本Issueの主眼なので、条件を付けず必ず更新を試みる（失敗しても判定処理は止めない）。
        const { failedCount, breakdown } = summarizeFailures(failureKinds);
        const finalCounts = {
            include_count: decisionCounts.include,
            exclude_count: decisionCounts.exclude,
            maybe_count: decisionCounts.maybe,
            failed_count: failedCount,
            failure_breakdown: serializeFailureBreakdown(breakdown),
        };
        try {
            if (executionLogWritten) {
                await updateLlmExecution(spreadsheetId, executionId, {
                    ...finalCounts,
                    status: 'confirmed',
                });
            } else {
                // 開始行の保存に失敗していると updateLlmExecution は対象行が無いため必ず
                // 「Execution not found」で失敗し、この Run の履歴が1行も残らなくなる。
                // 開始失敗の典型はネットワーク瞬断で、判定が終わる頃には回復していることが
                // 多いため、確定値を入れた行をここで新規作成するフォールバックで履歴を救う。
                await saveLlmExecution(spreadsheetId, {
                    ...initialExecution,
                    ...finalCounts,
                    status: 'confirmed',
                });
            }
        } catch (err) {
            // フォールバック経路もさらに失敗しうるが、判定処理自体は止めず警告に留める
            console.warn('[fulltext-ai] 実行履歴（終了）の記録に失敗:', err);
            appendLog(t('fulltext_aiExecutionLogFailed'), 'log-warn');
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

/** 1件のPDFをGeminiで判定し、Decisions タブへ確定保存する。保存した最終判定を返す */
async function judgeOne(
    ref: ReferenceWithStatus,
    screeningPrompt: string,
    modelConfig: ReturnType<typeof getModelConfig>,
    reviewerId: string,
    executionId: string,
    requestedModel: string,
    spreadsheetId: string
): Promise<'include' | 'exclude' | 'maybe'> {
    const fileId = ref.fulltext_url ? extractDriveFileId(ref.fulltext_url) : null;
    // i18n文言（t()）に依存したエラーだと表示言語が変わったときに分類が壊れるため、
    // 専用のエラークラス（classifyFulltextAiFailure で判別）を投げる。UI表示文言は
    // 呼び出し側（handleStartAiBatch）が describeDriveAccessError() 経由/フォールバックで組み立てる
    if (!fileId) throw new NoDriveUrlError(t('fulltext_aiErrNoDrive'));

    const blob = await downloadDriveFile(fileId);
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await blob.arrayBuffer());
    } catch (err) {
        // Driveからのダウンロード自体は成功しているので、ここでの失敗はDriveアクセスの問題ではなく
        // PDFバイト列としての読み取り失敗（破損ファイル等）として分類する
        throw new PdfReadError(err);
    }

    // スキャン(画像only)PDFかを判定時に記録し、ビューアの表示経路によらず
    // 「ハイライト精度が落ちる」注意を出せるようにする。検出失敗でも判定は続行する。
    let imageOnly: boolean | undefined;
    try {
        imageOnly = (await detectImageOnlyPdf(bytes)).imageOnly;
    } catch (err) {
        console.warn('[fulltext-ai] image-only detection failed:', err);
    }

    type JudgeFulltextResult = Awaited<ReturnType<typeof judgeFulltext>>;
    let output: JudgeFulltextResult['output'];
    let usageMetadata: JudgeFulltextResult['usageMetadata'];
    let responseMetadata: JudgeFulltextResult['responseMetadata'];
    try {
        ({ output, usageMetadata, responseMetadata } = await judgeFulltext(
            bytes, screeningPrompt, modelConfig, 'ja', undefined, state.excludeReasonItems
        ));
    } catch (err) {
        // judgeFulltext は PDFサイズ超過（PdfTooLargeError）や Gemini API 呼び出し失敗
        // （GeminiApiError）等、既に分類可能なエラーはそのまま投げてくる。
        // それ以外（レスポンスボディが空、ネットワーク例外等の未分類エラー）は
        // classifyFulltextAiFailure だと 'other' に落ちてしまい、Gemini呼び出し中に起きた
        // 失敗だという実態が実行履歴から読み取れなくなるため、ここで LlmCallError にラップし直す
        // （メッセージ・原因は保持するのでログ表示は変わらない）。
        throw classifyFulltextAiFailure(err) === 'other' ? new LlmCallError(err) : err;
    }

    // normalizeDecision は output.decision が列挙外（モデルの逸脱出力）でも
    // include_probability からフォールバックする。note・reason の両方でこの最終判定を
    // 基準に揃えるため、note を組み立てるより前に確定させる。
    const normalizedDecision = normalizeDecision(output);
    // 除外時のみ正規化済みキーを持たせる（人間判定の reason 運用と揃える）。
    // カスタム理由では 'other' が存在しないことがあるため、リストに無い値は
    // normalizeExcludeReasonKey でフォールバック理由（常に末尾）へ寄せる。
    const normalizedReasonKey = normalizedDecision === 'exclude'
        ? normalizeExcludeReasonKey(output.exclude_reason_category, state.excludeReasonItems)
        : undefined;

    const note: FulltextLlmDecisionNote = {
        type: 'llm_fulltext',
        execution_id: executionId,
        model: modelConfig.model,
        requested_model: requestedModel,
        model_version: responseMetadata?.modelVersion,
        response_id: responseMetadata?.responseId,
        include_probability: output.include_probability,
        reason: output.reason,
        // note には decision.reason と同じ正規化後のキーを入れる（バナー・シート表示が
        // 食い違わないように）。モデルの生出力はデバッグ価値があるため、正規化で値が
        // 変わった場合だけ exclude_reason_category_raw に残す。
        exclude_reason_category: normalizedReasonKey,
        exclude_reason_category_raw: output.exclude_reason_category && output.exclude_reason_category !== normalizedReasonKey
            ? output.exclude_reason_category
            : undefined,
        evidence: output.evidence,
        image_only: imageOnly,
        prompt_version: FULLTEXT_PROMPT_VERSION,
        usageMetadata,
    };

    const decision: Decision = {
        decision_id: crypto.randomUUID(),
        ref_id: ref.ref_id,
        reviewer_id: reviewerId,
        decision: normalizedDecision,
        // 除外時は Decisions の reason 列に除外理由の区分を入れる（人間判定と同じ運用）。
        // note.exclude_reason_category と同じ正規化済みキーを使う（食い違い防止）。
        reason: normalizedReasonKey,
        note: JSON.stringify(note),
        decided_at: new Date().toISOString(),
        client_version: getClientVersion('-llm'),
        screening_phase: 'fulltext',
    };

    await saveDecision(spreadsheetId, decision);
    return normalizedDecision;
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
