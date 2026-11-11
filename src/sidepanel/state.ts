/**
 * アプリケーション状態の集約管理
 * 設定・絞り込み・現在文献・spreadsheetId/userEmail/highlightKeywords/isAdmin/
 * fulltextPoolRule/fulltextAssignment/availableReviewers/enabledReviewers/currentTab/
 * llmConfig/mlState/activeLlmExecutionIds/currentBatchDecisions/failedRefIds は
 * Storeを読むgetterのみ（src/sidepanel/AGENTS.md参照）。
 */

import { getState } from './store';

import type { ReferenceWithStatus, ImportStatsMap, LlmRun, LlmExecution } from '../lib/types';
import type { ReviewCriteria } from '../lib/review-criteria';
import type { ExcludeReasonConfig } from '../lib/exclude-reason-config';
import { resolveExcludeReasonItems } from '../lib/exclude-reason-config';
import type { ExcludeReasonItem } from '../lib/exclude-reasons';
import type { LlmTargetMode } from '../lib/llm-target-selection';
import { DEFAULT_LLM_TARGET_MODE } from '../lib/llm-target-selection';

// ========== Private State ==========

/**
 * state.ts が持つ、Store に未移行のセッション状態（プロジェクトに属するもの）。
 * 戻る・ログアウトは丸ごと作り直して初期値に戻す。モジュール変数を足すときは
 * ここに入れる（tests/session-reset.test.ts が最上位の let を検査する）。
 */
export interface LegacySessionState {
    // 担当割り振りで絞り込む前の全文献。
    // Storeの references は非管理者だと自分の担当分だけになるため、
    // 「どのセットが何件で誰の担当か」をレビュアー全員に同じ数字で見せる用途にはこちらを使う。
    allReferences: ReferenceWithStatus[];
    reviewHistoryRefIds: string[];
    reviewHistoryCursor: number;
    reviewHistoryReturnRefId: string | null;
    // noteInputに現在表示されているメモがどの文献のものかを追跡する。
    // 別文献にメモが流出して保存される事故（"幽霊pending判定"）を防ぐためのガード。
    lastRenderedRefId: string | null;
    // インポート統計（Configシート import_stats、PRISMA自動記入用）
    importStats: ImportStatsMap;
    // レビュー基準（Configシート review_criteria、未設定は null）
    reviewCriteria: ReviewCriteria | null;
    // フルテキスト除外理由リスト（Configシート fulltext_exclude_reasons、未設定は null = 既定の7区分）
    excludeReasonConfig: ExcludeReasonConfig | null;
    // LLM関連
    batchAbortController: AbortController | null;
    currentExecutionId: string;
    // Run/Batch の一覧キャッシュ。バッチ対象件数を Run 単位で計算する際、
    // UI 操作のたびに Sheets を読むとクォータを消費するため loadExecutionHistory の取得結果を保持する
    llmRuns: LlmRun[];
    llmExecutions: LlmExecution[];
    // 「新規にやり直す」モード。ONの間は既存 Run を再利用せず、新しい Run として全文献を対象にする
    forceNewLlmRun: boolean;
    // AI一括判定の対象の決め方（'all'=従来どおり全件 / 'selection'=担当セット・個別選択で限定）
    llmTargetMode: LlmTargetMode;
    // selection モード時に対象とする ref_id 集合
    llmTargetRefIds: Set<string>;
    // 合議モード（-human-consensus）。ONの間の判定は client_version に -human-consensus サフィックスを付けて
    // 保存する。合議はブラインド中に成立しないため isKeyOpened===true のときだけUIに出す（handleKeyToggle の
    // CLOSE 経路で false に戻す）。戻る・ログアウトでも必ず false に戻す（落とし忘れると、次に開く
    // プロジェクトで -human-consensus が保存され続ける事故になる）。既定は false（従来どおりの -human）。
    consensusMode: boolean;
}

export function createLegacySessionState(): LegacySessionState {
    return {
        allReferences: [],
        reviewHistoryRefIds: [],
        reviewHistoryCursor: -1,
        reviewHistoryReturnRefId: null,
        lastRenderedRefId: null,
        importStats: {},
        reviewCriteria: null,
        excludeReasonConfig: null,
        batchAbortController: null,
        currentExecutionId: '',
        llmRuns: [],
        llmExecutions: [],
        forceNewLlmRun: false,
        llmTargetMode: DEFAULT_LLM_TARGET_MODE,
        llmTargetRefIds: new Set(),
        consensusMode: false,
    };
}

let _session: LegacySessionState = createLegacySessionState();

/** テスト用: 現在の legacy セッション状態の実体を返す */
export function _getLegacySessionStateForTest(): LegacySessionState {
    return _session;
}

// ========== State Object with Getters/Setters ==========

export const state = {
    // ----- References -----
    get references() { return getState().data.references; },

    /** 担当割り振りで絞り込む前の全文献（未設定時は references と同じ内容） */
    get allReferences() { return _session.allReferences.length > 0 ? _session.allReferences : getState().data.references; },
    setAllReferences(refs: ReferenceWithStatus[]) { _session.allReferences = refs; },

    get currentIndex() { return getState().ui.screening.currentIndex; },

    get currentFilter() { return getState().ui.screening.currentFilter; },

    get searchQuery() { return getState().ui.screening.searchQuery; },

    // ----- Review History -----
    get reviewHistoryRefIds() { return _session.reviewHistoryRefIds; },
    setReviewHistoryRefIds(refIds: string[]) {
        _session.reviewHistoryRefIds = Array.from(new Set(refIds.filter(Boolean))).slice(0, 5);
    },
    pushReviewHistoryRefId(refId: string) {
        if (!refId) return;
        _session.reviewHistoryRefIds = [refId, ..._session.reviewHistoryRefIds.filter(id => id !== refId)].slice(0, 5);
    },

    get reviewHistoryCursor() { return _session.reviewHistoryCursor; },
    setReviewHistoryCursor(cursor: number) { _session.reviewHistoryCursor = cursor; },

    get reviewHistoryReturnRefId() { return _session.reviewHistoryReturnRefId; },
    setReviewHistoryReturnRefId(refId: string | null) { _session.reviewHistoryReturnRefId = refId; },

    isReviewHistoryActive() {
        return _session.reviewHistoryCursor >= 0 && _session.reviewHistoryCursor < _session.reviewHistoryRefIds.length;
    },
    getCurrentReviewHistoryRefId() {
        if (_session.reviewHistoryCursor < 0 || _session.reviewHistoryCursor >= _session.reviewHistoryRefIds.length) {
            return null;
        }
        return _session.reviewHistoryRefIds[_session.reviewHistoryCursor];
    },
    resetReviewHistoryNavigation() {
        _session.reviewHistoryCursor = -1;
        _session.reviewHistoryReturnRefId = null;
    },
    clearReviewHistory() {
        _session.reviewHistoryRefIds = [];
        _session.reviewHistoryCursor = -1;
        _session.reviewHistoryReturnRefId = null;
    },

    // ----- Last Rendered Reference (note input ownership tracking) -----
    get lastRenderedRefId() { return _session.lastRenderedRefId; },
    setLastRenderedRefId(refId: string | null) { _session.lastRenderedRefId = refId; },

    // ----- Spreadsheet/User -----
    get spreadsheetId() { return getState().data.spreadsheetId; },

    get userEmail() { return getState().data.userEmail; },

    // ----- Keywords/Permissions -----
    get highlightKeywords() { return getState().data.highlightKeywords; },

    get isKeyOpened() { return getState().ui.screening.isKeyOpened; },

    get isAdmin() { return getState().data.isAdmin; },

    get sheetEditAccess() { return getState().data.sheetEditAccess; },

    get unsentCount() { return getState().data.unsentCount; },

    get fulltextPoolRule() { return getState().data.fulltextPoolRule; },

    get fulltextAssignment() { return getState().data.fulltextAssignment; },

    // ----- Source File Filters -----
    get sourceFiles() { return getState().data.sourceFiles; },

    get selectedSourceFiles() { return getState().data.selectedSourceFiles; },

    // ----- Import Stats (PRISMA自動記入用) -----
    get importStats() { return _session.importStats; },
    setImportStats(stats: ImportStatsMap) { _session.importStats = stats; },

    // ----- Review Criteria (組入・除外基準) -----
    get reviewCriteria() { return _session.reviewCriteria; },
    setReviewCriteria(criteria: ReviewCriteria | null) { _session.reviewCriteria = criteria; },

    // ----- Exclude Reasons (フルテキスト除外理由リスト) -----
    get excludeReasonConfig() { return _session.excludeReasonConfig; },
    setExcludeReasonConfig(config: ExcludeReasonConfig | null) { _session.excludeReasonConfig = config; },
    /** 実際に使う理由リスト（未設定なら既定のPICO7区分）。表示・集計・裁定は必ずこれを使う。 */
    get excludeReasonItems(): readonly ExcludeReasonItem[] { return resolveExcludeReasonItems(_session.excludeReasonConfig); },

    // ----- Assignment Filters -----
    get assignmentConfig() { return getState().data.assignmentConfig; },

    get assignmentSets() { return getState().data.assignmentSets; },

    get selectedAssignmentSets() { return getState().data.selectedAssignmentSets; },

    // ----- Fulltext Assignment Filters -----
    get selectedFulltextSets() { return getState().data.selectedFulltextSets; },

    // ----- User Settings -----
    get autoNavigateAfterDecision() { return getState().ui.settings.autoNavigateAfterDecision; },

    get showRecordCountBelow() { return getState().ui.settings.showRecordCountBelow; },

    get termFilterUseAnd() { return getState().ui.settings.termFilterUseAnd; },

    get abstractSubsectionBreakEnabled() { return getState().ui.settings.abstractSubsectionBreakEnabled; },

    get abstractSubsectionHeadings() { return getState().ui.settings.abstractSubsectionHeadings; },

    // ----- Term Filters -----
    get activeTermFilters() { return getState().ui.screening.activeTermFilters; },

    // ----- LLM State -----
    get currentTab() { return getState().ui.currentTab; },

    get llmConfig() { return getState().data.llmConfig; },

    get batchAbortController() { return _session.batchAbortController; },
    setBatchAbortController(controller: AbortController | null) {
        _session.batchAbortController = controller;
    },

    get currentExecutionId() { return _session.currentExecutionId; },
    setCurrentExecutionId(id: string) { _session.currentExecutionId = id; },

    get currentBatchDecisions() { return getState().data.currentBatchDecisions; },

    get activeLlmExecutionIds() { return getState().data.activeLlmExecutionIds; },

    get llmRuns() { return _session.llmRuns; },
    get llmExecutions() { return _session.llmExecutions; },
    setLlmRunsAndExecutions(runs: LlmRun[], executions: LlmExecution[]) {
        _session.llmRuns = runs;
        _session.llmExecutions = executions;
    },

    get forceNewLlmRun() { return _session.forceNewLlmRun; },
    setForceNewLlmRun(force: boolean) { _session.forceNewLlmRun = force; },

    get llmTargetMode() { return _session.llmTargetMode; },
    setLlmTargetMode(mode: LlmTargetMode) { _session.llmTargetMode = mode; },

    get llmTargetRefIds() { return _session.llmTargetRefIds; },
    setLlmTargetRefIds(refIds: Set<string>) { _session.llmTargetRefIds = refIds; },

    get failedRefIds() { return getState().data.failedRefIds; },
    get failedSourceExecutionId() { return getState().data.failedSourceExecutionId; },

    // ----- Reviewer Filtering -----
    get enabledReviewers() { return getState().data.enabledReviewers; },

    get availableReviewers() { return getState().data.availableReviewers; },

    get showAiHighlights() { return getState().ui.settings.showAiHighlights; },

    get consensusMode() { return _session.consensusMode; },
    setConsensusMode(value: boolean) { _session.consensusMode = value; },

    get aiDecisionFilter() { return getState().ui.settings.aiDecisionFilter; },

    get treatMlAsManual() { return getState().ui.settings.treatMlAsManual; },

    // ----- ML State -----
    get mlState() { return getState().data.mlState; },

    // ----- Reset Functions -----
    // どちらも16項目すべてを初期値に戻す（残すものは無い）
    resetForLogout() {
        _session = createLegacySessionState();
    },

    resetForBack() {
        _session = createLegacySessionState();
    },
};

export type AppState = typeof state;
