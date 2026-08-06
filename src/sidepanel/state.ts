/**
 * アプリケーション状態の集約管理
 * getter/setter パターンで副作用を制御し、状態変更の影響範囲を限定
 */

import type { ReferenceWithStatus, DecisionStatus, LlmConfig, Decision, AssignmentConfig, ImportStatsMap, LlmRun, LlmExecution } from '../lib/types';
import type { HighlightKeywords } from '../lib/sheets-api';
import type { FulltextPoolRule } from '../lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../lib/fulltext-assignment';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../lib/fulltext-assignment';
import { DEFAULT_LLM_CONFIG } from '../lib/sheets-api';

// ========== Private State Variables ==========

const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

// 基本状態
let _references: ReferenceWithStatus[] = [];
// 担当割り振りで絞り込む前の全文献。
// _references は非管理者だと自分の担当分だけになるため、
// 「どのセットが何件で誰の担当か」をレビュアー全員に同じ数字で見せる用途にはこちらを使う。
let _allReferences: ReferenceWithStatus[] = [];
let _currentIndex = 0;
let _currentFilter: DecisionStatus | 'all' | 'fulltext_candidates' = 'pending';
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
let _isKeyOpened = false;
let _isAdmin = false;

// フルテキスト候補ルール（Configシート共有設定、未設定はnull）
let _fulltextPoolRule: FulltextPoolRule | null = null;

// フルテキスト担当割り振り（Configシート共有設定、未設定は status 'none'）
let _fulltextAssignment: FulltextAssignmentConfig = { ...DEFAULT_FULLTEXT_ASSIGNMENT };

// ソースファイルフィルター
let _sourceFiles: Set<string> = new Set();
let _selectedSourceFiles: Set<string> = new Set();

// インポート統計（Configシート import_stats、PRISMA自動記入用）
let _importStats: ImportStatsMap = {};

// 担当セットフィルター
let _assignmentConfig: AssignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG };
let _assignmentSets: Set<string> = new Set();
let _selectedAssignmentSets: Set<string> = new Set();

// ユーザー設定
let _autoNavigateAfterDecision = true;
let _showRecordCountBelow = true;
let _termFilterUseAnd = true;
let _abstractSubsectionBreakEnabled = false;
let _abstractSubsectionHeadings: string[] = [];

// タームフィルター
let _activeTermFilters: { term: string; type: 'include' | 'exclude' }[] = [];

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
let _failedRefIds: string[] = [];  // リトライ対象の失敗ref_id
let _enabledReviewers: Set<string> = new Set(); // 表示対象のレビュアーID
let _availableReviewers: Set<string> = new Set(); // 利用可能な全レビュアーID
let _showAiHighlights = true; // AIのEvidenceをハイライトするかどうか（デフォルトON）
let _aiDecisionFilter: Record<string, { include: boolean; exclude: boolean; maybe?: boolean }> = {}; // AI判定の表示フィルター（AIレビュアーID別）
let _treatMlAsManual = true; // ML判定を手動判定と同一視するか

import { createInitialMlState, MlState } from '../lib/ml/types';
let _mlState: MlState = createInitialMlState();

// ========== State Object with Getters/Setters ==========

export const state = {
    // ----- References -----
    get references() { return _references; },
    setReferences(refs: ReferenceWithStatus[]) { _references = refs; },

    /** 担当割り振りで絞り込む前の全文献（未設定時は references と同じ内容） */
    get allReferences() { return _allReferences.length > 0 ? _allReferences : _references; },
    setAllReferences(refs: ReferenceWithStatus[]) { _allReferences = refs; },

    get currentIndex() { return _currentIndex; },
    setCurrentIndex(idx: number) { _currentIndex = idx; },

    get currentFilter() { return _currentFilter; },
    setCurrentFilter(filter: DecisionStatus | 'all' | 'fulltext_candidates') { _currentFilter = filter; },

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

    get isKeyOpened() { return _isKeyOpened; },
    setIsKeyOpened(opened: boolean) { _isKeyOpened = opened; },

    get isAdmin() { return _isAdmin; },
    setIsAdmin(admin: boolean) { _isAdmin = admin; },

    get fulltextPoolRule() { return _fulltextPoolRule; },
    setFulltextPoolRule(rule: FulltextPoolRule | null) { _fulltextPoolRule = rule; },

    get fulltextAssignment() { return _fulltextAssignment; },
    setFulltextAssignment(config: FulltextAssignmentConfig) { _fulltextAssignment = config; },

    // ----- Source File Filters -----
    get sourceFiles() { return _sourceFiles; },
    setSourceFiles(files: Set<string>) { _sourceFiles = files; },
    clearSourceFiles() { _sourceFiles.clear(); },
    addSourceFile(file: string) { _sourceFiles.add(file); },

    get selectedSourceFiles() { return _selectedSourceFiles; },
    setSelectedSourceFiles(files: Set<string>) { _selectedSourceFiles = files; },
    addSelectedSourceFile(file: string) { _selectedSourceFiles.add(file); },
    removeSelectedSourceFile(file: string) { _selectedSourceFiles.delete(file); },

    // ----- Import Stats (PRISMA自動記入用) -----
    get importStats() { return _importStats; },
    setImportStats(stats: ImportStatsMap) { _importStats = stats; },

    // ----- Assignment Filters -----
    get assignmentConfig() { return _assignmentConfig; },
    setAssignmentConfig(config: AssignmentConfig) { _assignmentConfig = config; },
    resetAssignmentConfig() { _assignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG }; },

    get assignmentSets() { return _assignmentSets; },
    setAssignmentSets(sets: Set<string>) { _assignmentSets = sets; },
    clearAssignmentSets() { _assignmentSets.clear(); },
    addAssignmentSet(setId: string) { _assignmentSets.add(setId); },

    get selectedAssignmentSets() { return _selectedAssignmentSets; },
    setSelectedAssignmentSets(sets: Set<string>) { _selectedAssignmentSets = sets; },
    addSelectedAssignmentSet(setId: string) { _selectedAssignmentSets.add(setId); },
    removeSelectedAssignmentSet(setId: string) { _selectedAssignmentSets.delete(setId); },

    // ----- User Settings -----
    get autoNavigateAfterDecision() { return _autoNavigateAfterDecision; },
    setAutoNavigateAfterDecision(value: boolean) { _autoNavigateAfterDecision = value; },

    get showRecordCountBelow() { return _showRecordCountBelow; },
    setShowRecordCountBelow(value: boolean) { _showRecordCountBelow = value; },

    get termFilterUseAnd() { return _termFilterUseAnd; },
    setTermFilterUseAnd(value: boolean) { _termFilterUseAnd = value; },

    get abstractSubsectionBreakEnabled() { return _abstractSubsectionBreakEnabled; },
    setAbstractSubsectionBreakEnabled(value: boolean) { _abstractSubsectionBreakEnabled = value; },

    get abstractSubsectionHeadings() { return _abstractSubsectionHeadings; },
    setAbstractSubsectionHeadings(value: string[]) { _abstractSubsectionHeadings = value; },

    // ----- Term Filters -----
    get activeTermFilters() { return _activeTermFilters; },
    setActiveTermFilters(filters: { term: string; type: 'include' | 'exclude' }[]) {
        _activeTermFilters = filters;
    },
    addTermFilter(filter: { term: string; type: 'include' | 'exclude' }) {
        _activeTermFilters.push(filter);
    },
    removeTermFilter(term: string, type: string) {
        _activeTermFilters = _activeTermFilters.filter(
            f => !(f.term === term && f.type === type)
        );
    },
    clearTermFilters() { _activeTermFilters = []; },

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

    get showAiHighlights() { return _showAiHighlights; },
    setShowAiHighlights(show: boolean) { _showAiHighlights = show; },

    get aiDecisionFilter() { return _aiDecisionFilter; },
    setAiDecisionFilter(filter: Record<string, { include: boolean; exclude: boolean; maybe?: boolean }>) { _aiDecisionFilter = filter; },

    get treatMlAsManual() { return _treatMlAsManual; },
    setTreatMlAsManual(value: boolean) { _treatMlAsManual = value; },

    // ----- ML State -----
    get mlState() { return _mlState; },
    setMlState(newState: MlState) { _mlState = newState; },

    // ----- Reset Functions -----
    resetForLogout() {
        _spreadsheetId = '';
        _userEmail = '';
        _references = [];
        _allReferences = [];
        _isKeyOpened = false;
        _isAdmin = false;
        _fulltextPoolRule = null;
        _fulltextAssignment = { ...DEFAULT_FULLTEXT_ASSIGNMENT };
        _currentIndex = 0;
        _currentFilter = 'pending';
        _reviewHistoryRefIds = [];
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
        _sourceFiles.clear();
        _selectedSourceFiles.clear();
        _importStats = {};
        _assignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG };
        _assignmentSets.clear();
        _selectedAssignmentSets.clear();
        _activeTermFilters = [];
        _currentTab = 'screening';
        _llmConfig = { ...DEFAULT_LLM_CONFIG };
        _batchAbortController = null;
        _currentExecutionId = '';
        _currentBatchDecisions = [];
        _activeLlmExecutionIds.clear();
        _llmRuns = [];
        _llmExecutions = [];
        _forceNewLlmRun = false;
        _failedRefIds = [];
        _mlState = createInitialMlState();
    },

    resetForBack() {
        _spreadsheetId = '';
        _references = [];
        _allReferences = [];
        _fulltextPoolRule = null;
        _fulltextAssignment = { ...DEFAULT_FULLTEXT_ASSIGNMENT };
        _currentIndex = 0;
        _reviewHistoryRefIds = [];
        _reviewHistoryCursor = -1;
        _reviewHistoryReturnRefId = null;
        _sourceFiles.clear();
        _selectedSourceFiles.clear();
        _importStats = {};
        _assignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG };
        _assignmentSets.clear();
        _selectedAssignmentSets.clear();
        _activeTermFilters = [];
        _enabledReviewers.clear();
        _availableReviewers.clear();
        _mlState = createInitialMlState();  // ML状態もリセット
    },
};

export type AppState = typeof state;
