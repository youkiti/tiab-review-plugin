/**
 * アプリケーション状態の集約管理
 * 設定・絞り込み・現在文献はStoreを読むgetterのみ。未移行領域は従来のsetterを維持する。
 */

import { getState } from './store';

import type { ReferenceWithStatus, LlmConfig, Decision, ImportStatsMap, LlmRun, LlmExecution } from '../lib/types';
import type { HighlightKeywords } from '../lib/sheets-api';
import type { ReviewCriteria } from '../lib/review-criteria';
import type { ExcludeReasonConfig } from '../lib/exclude-reason-config';
import { resolveExcludeReasonItems } from '../lib/exclude-reason-config';
import type { ExcludeReasonItem } from '../lib/exclude-reasons';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../lib/fulltext-assignment';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../lib/fulltext-assignment';
import { DEFAULT_LLM_CONFIG } from '../lib/sheets-api';
import type { LlmTargetMode } from '../lib/llm-target-selection';
import { DEFAULT_LLM_TARGET_MODE } from '../lib/llm-target-selection';

// ========== Private State Variables ==========

// 基本状態
// 担当割り振りで絞り込む前の全文献。
// Storeの references は非管理者だと自分の担当分だけになるため、
// 「どのセットが何件で誰の担当か」をレビュアー全員に同じ数字で見せる用途にはこちらを使う。
let _allReferences: ReferenceWithStatus[] = [];
let _reviewHistoryRefIds: string[] = [];
let _reviewHistoryCursor = -1;
let _reviewHistoryReturnRefId: string | null = null;
// noteInputに現在表示されているメモがどの文献のものかを追跡する。
// 別文献にメモが流出して保存される事故（"幽霊pending判定"）を防ぐためのガード。
let _lastRenderedRefId: string | null = null;


let _spreadsheetId = '';
let _userEmail = '';

// キーワード・権限
let _highlightKeywords: HighlightKeywords = { include: [], exclude: [] };
let _isAdmin = false;

// フルテキスト候補ルール（Configシート共有設定、未設定はnull）
let _fulltextPoolRule: FulltextPoolRule | null = null;

// フルテキスト担当割り振り（Configシート共有設定、未設定は status 'none'）
let _fulltextAssignment: FulltextAssignmentConfig = { ...DEFAULT_FULLTEXT_ASSIGNMENT };

// インポート統計（Configシート import_stats、PRISMA自動記入用）
let _importStats: ImportStatsMap = {};

// レビュー基準（Configシート review_criteria、未設定は null）
let _reviewCriteria: ReviewCriteria | null = null;

// フルテキスト除外理由リスト（Configシート fulltext_exclude_reasons、未設定は null = 既定の7区分）
let _excludeReasonConfig: ExcludeReasonConfig | null = null;

// LLM関連
let _currentTab: 'screening' | 'llm' | 'ml' | 'fulltext' = 'screening';
let _llmConfig: LlmConfig = { ...DEFAULT_LLM_CONFIG };
let _batchAbortController: AbortController | null = null;
let _currentExecutionId = '';
let _currentBatchDecisions: Decision[] = [];
let _activeLlmExecutionIds: Set<string> = new Set();
// Run/Batch の一覧キャッシュ。バッチ対象件数を Run 単位で計算する際、
// UI 操作のたびに Sheets を読むとクォータを消費するため loadExecutionHistory の取得結果を保持する
let _llmRuns: LlmRun[] = [];
let _llmExecutions: LlmExecution[] = [];
// 「新規にやり直す」モード。ONの間は既存 Run を再利用せず、新しい Run として全文献を対象にする
let _forceNewLlmRun = false;
// AI一括判定の対象の決め方（'all'=従来どおり全件 / 'selection'=担当セット・個別選択で限定）
let _llmTargetMode: LlmTargetMode = DEFAULT_LLM_TARGET_MODE;
// selection モード時に対象とする ref_id 集合
let _llmTargetRefIds: Set<string> = new Set();
let _failedRefIds: string[] = [];  // リトライ対象の失敗ref_id
let _enabledReviewers: Set<string> = new Set(); // 表示対象のレビュアーID
let _availableReviewers: Set<string> = new Set(); // 利用可能な全レビュアーID
// 合議モード（-human-consensus）。ONの間の判定は client_version に -human-consensus サフィックスを付けて
// 保存する。合議はブラインド中に成立しないため、isKeyOpened===true のときだけUIに出す（handleKeyToggle の
// CLOSE 経路で false に戻す）。既定は false（従来どおりの -human）。
let _consensusMode = false;

import { createInitialMlState, MlState } from '../lib/ml/types';
let _mlState: MlState = createInitialMlState();

// ========== State Object with Getters/Setters ==========

export const state = {
    // ----- References -----
    get references() { return getState().data.references; },

    /** 担当割り振りで絞り込む前の全文献（未設定時は references と同じ内容） */
    get allReferences() { return _allReferences.length > 0 ? _allReferences : getState().data.references; },
    setAllReferences(refs: ReferenceWithStatus[]) { _allReferences = refs; },

    get currentIndex() { return getState().ui.screening.currentIndex; },

    get currentFilter() { return getState().ui.screening.currentFilter; },

    get searchQuery() { return getState().ui.screening.searchQuery; },

    // ----- Review History -----
    get reviewHistoryRefIds() { return _reviewHistoryRefIds; },
    setReviewHistoryRefIds(refIds: string[]) {
        _reviewHistoryRefIds = Array.from(new Set(refIds.filter(Boolean))).slice(0, 5);
    },
    pushReviewHistoryRefId(refId: string) {
        if (!refId) return;
        _reviewHistoryRefIds = [refId, ..._reviewHistoryRefIds.filter(id => id !== refId)].slice(0, 5);
    },

    get reviewHistoryCursor() { return _reviewHistoryCursor; },
    setReviewHistoryCursor(cursor: number) { _reviewHistoryCursor = cursor; },

    get reviewHistoryReturnRefId() { return _reviewHistoryReturnRefId; },
    setReviewHistoryReturnRefId(refId: string | null) { _reviewHistoryReturnRefId = refId; },

    isReviewHistoryActive() {
        return _reviewHistoryCursor >= 0 && _reviewHistoryCursor < _reviewHistoryRefIds.length;
    },
    getCurrentReviewHistoryRefId() {
        if (_reviewHistoryCursor < 0 || _reviewHistoryCursor >= _reviewHistoryRefIds.length) {
            return null;
        }
        return _reviewHistoryRefIds[_reviewHistoryCursor];
    },
    resetReviewHistoryNavigation() {
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
    },
    clearReviewHistory() {
        _reviewHistoryRefIds = [];
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
    },

    // ----- Last Rendered Reference (note input ownership tracking) -----
    get lastRenderedRefId() { return _lastRenderedRefId; },
    setLastRenderedRefId(refId: string | null) { _lastRenderedRefId = refId; },

    // ----- Spreadsheet/User -----
    get spreadsheetId() { return _spreadsheetId; },
    setSpreadsheetId(id: string) { _spreadsheetId = id; },

    get userEmail() { return _userEmail; },
    setUserEmail(email: string) { _userEmail = email; },

    // ----- Keywords/Permissions -----
    get highlightKeywords() { return _highlightKeywords; },
    setHighlightKeywords(keywords: HighlightKeywords) { _highlightKeywords = keywords; },
    addIncludeKeyword(word: string) {
        if (!_highlightKeywords.include.includes(word)) {
            _highlightKeywords.include.push(word);
        }
    },
    removeIncludeKeyword(word: string) {
        _highlightKeywords.include = _highlightKeywords.include.filter(w => w !== word);
    },
    addExcludeKeyword(word: string) {
        if (!_highlightKeywords.exclude.includes(word)) {
            _highlightKeywords.exclude.push(word);
        }
    },
    removeExcludeKeyword(word: string) {
        _highlightKeywords.exclude = _highlightKeywords.exclude.filter(w => w !== word);
    },

    get isKeyOpened() { return getState().ui.screening.isKeyOpened; },

    get isAdmin() { return _isAdmin; },
    setIsAdmin(admin: boolean) { _isAdmin = admin; },

    get fulltextPoolRule() { return _fulltextPoolRule; },
    setFulltextPoolRule(rule: FulltextPoolRule | null) { _fulltextPoolRule = rule; },

    get fulltextAssignment() { return _fulltextAssignment; },
    setFulltextAssignment(config: FulltextAssignmentConfig) { _fulltextAssignment = config; },

    // ----- Source File Filters -----
    get sourceFiles() { return getState().data.sourceFiles; },

    get selectedSourceFiles() { return getState().data.selectedSourceFiles; },

    // ----- Import Stats (PRISMA自動記入用) -----
    get importStats() { return _importStats; },
    setImportStats(stats: ImportStatsMap) { _importStats = stats; },

    // ----- Review Criteria (組入・除外基準) -----
    get reviewCriteria() { return _reviewCriteria; },
    setReviewCriteria(criteria: ReviewCriteria | null) { _reviewCriteria = criteria; },

    // ----- Exclude Reasons (フルテキスト除外理由リスト) -----
    get excludeReasonConfig() { return _excludeReasonConfig; },
    setExcludeReasonConfig(config: ExcludeReasonConfig | null) { _excludeReasonConfig = config; },
    /** 実際に使う理由リスト（未設定なら既定のPICO7区分）。表示・集計・裁定は必ずこれを使う。 */
    get excludeReasonItems(): readonly ExcludeReasonItem[] { return resolveExcludeReasonItems(_excludeReasonConfig); },

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
    get currentTab() { return _currentTab; },
    setCurrentTab(tab: 'screening' | 'llm' | 'ml' | 'fulltext') { _currentTab = tab; },

    get llmConfig() { return _llmConfig; },
    setLlmConfig(config: LlmConfig) { _llmConfig = config; },

    get batchAbortController() { return _batchAbortController; },
    setBatchAbortController(controller: AbortController | null) {
        _batchAbortController = controller;
    },

    get currentExecutionId() { return _currentExecutionId; },
    setCurrentExecutionId(id: string) { _currentExecutionId = id; },

    get currentBatchDecisions() { return _currentBatchDecisions; },
    setCurrentBatchDecisions(decisions: Decision[]) { _currentBatchDecisions = decisions; },

    get activeLlmExecutionIds() { return _activeLlmExecutionIds; },
    setActiveLlmExecutionIds(ids: Set<string>) { _activeLlmExecutionIds = ids; },
    addActiveLlmExecutionId(id: string) { _activeLlmExecutionIds.add(id); },
    clearActiveLlmExecutionIds() { _activeLlmExecutionIds.clear(); },

    get llmRuns() { return _llmRuns; },
    get llmExecutions() { return _llmExecutions; },
    setLlmRunsAndExecutions(runs: LlmRun[], executions: LlmExecution[]) {
        _llmRuns = runs;
        _llmExecutions = executions;
    },

    get forceNewLlmRun() { return _forceNewLlmRun; },
    setForceNewLlmRun(force: boolean) { _forceNewLlmRun = force; },

    get llmTargetMode() { return _llmTargetMode; },
    setLlmTargetMode(mode: LlmTargetMode) { _llmTargetMode = mode; },

    get llmTargetRefIds() { return _llmTargetRefIds; },
    setLlmTargetRefIds(refIds: Set<string>) { _llmTargetRefIds = refIds; },

    get failedRefIds() { return _failedRefIds; },
    setFailedRefIds(ids: string[]) { _failedRefIds = ids; },
    clearFailedRefIds() { _failedRefIds = []; },

    // ----- Reviewer Filtering -----
    get enabledReviewers() { return _enabledReviewers; },
    setEnabledReviewers(reviewers: Set<string>) { _enabledReviewers = reviewers; },
    addEnabledReviewer(id: string) { _enabledReviewers.add(id); },
    removeEnabledReviewer(id: string) { _enabledReviewers.delete(id); },

    get availableReviewers() { return _availableReviewers; },
    setAvailableReviewers(reviewers: Set<string>) { _availableReviewers = reviewers; },

    get showAiHighlights() { return getState().ui.settings.showAiHighlights; },

    get consensusMode() { return _consensusMode; },
    setConsensusMode(value: boolean) { _consensusMode = value; },

    get aiDecisionFilter() { return getState().ui.settings.aiDecisionFilter; },

    get treatMlAsManual() { return getState().ui.settings.treatMlAsManual; },

    // ----- ML State -----
    get mlState() { return _mlState; },
    setMlState(newState: MlState) { _mlState = newState; },

    // ----- Reset Functions -----
    resetForLogout() {
        _spreadsheetId = '';
        _userEmail = '';
        _allReferences = [];
        _isAdmin = false;
        _fulltextPoolRule = null;
        _fulltextAssignment = { ...DEFAULT_FULLTEXT_ASSIGNMENT };
        _reviewHistoryRefIds = [];
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
        _importStats = {};
        _reviewCriteria = null;
        _excludeReasonConfig = null;
        _currentTab = 'screening';
        _llmConfig = { ...DEFAULT_LLM_CONFIG };
        _batchAbortController = null;
        _currentExecutionId = '';
        _currentBatchDecisions = [];
        _activeLlmExecutionIds.clear();
        _llmRuns = [];
        _llmExecutions = [];
        _forceNewLlmRun = false;
        _llmTargetMode = DEFAULT_LLM_TARGET_MODE;
        _llmTargetRefIds = new Set();
        _failedRefIds = [];
        _mlState = createInitialMlState();
        // 合議はブラインド中に成立しないため、ログアウト時も必ず解除する（次に開くプロジェクトへ
        // 持ち越して -human-consensus が誤って保存される事故の防止。handleKeyToggle のCLOSE経路と
        // 同じ理由）
        _consensusMode = false;
    },

    resetForBack() {
        _spreadsheetId = '';
        _allReferences = [];
        _fulltextPoolRule = null;
        _fulltextAssignment = { ...DEFAULT_FULLTEXT_ASSIGNMENT };
        _reviewHistoryRefIds = [];
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
        _importStats = {};
        _reviewCriteria = null;
        _excludeReasonConfig = null;
        _enabledReviewers.clear();
        _availableReviewers.clear();
        _llmTargetMode = DEFAULT_LLM_TARGET_MODE;
        _llmTargetRefIds = new Set();
        _mlState = createInitialMlState();  // ML状態もリセット
        // 合議はブラインド中に成立しないため、プロジェクト切替（Back）でも必ず解除する。
        // 落とし忘れると、次に接続したブラインドプロジェクトで合議トグルが非表示のまま
        // -human-consensus として判定が保存され続ける（合議前κの切り出しが壊れる）
        _consensusMode = false;
    },
};

export type AppState = typeof state;
