/**
 * アプリケーション状態の集約管理
 * getter/setter パターンで副作用を制御し、状態変更の影響範囲を限定
 */

import type { ReferenceWithStatus, DecisionStatus, LlmConfig, Decision } from '../lib/types';
import type { HighlightKeywords } from '../lib/sheets-api';
import { DEFAULT_LLM_CONFIG } from '../lib/sheets-api';

// ========== Private State Variables ==========

// 基本状態
let _references: ReferenceWithStatus[] = [];
let _currentIndex = 0;
let _currentFilter: DecisionStatus | 'all' = 'pending';
let _spreadsheetId = '';
let _userEmail = '';

// キーワード・権限
let _highlightKeywords: HighlightKeywords = { include: [], exclude: [] };
let _isKeyOpened = false;
let _isAdmin = false;

// ソースファイルフィルター
let _sourceFiles: Set<string> = new Set();
let _selectedSourceFiles: Set<string> = new Set();

// ユーザー設定
let _autoNavigateAfterDecision = true;
let _showRecordCountBelow = true;
let _termFilterUseAnd = true;

// タームフィルター
let _activeTermFilters: { term: string; type: 'include' | 'exclude' }[] = [];

// LLM関連
let _currentTab: 'screening' | 'llm' = 'screening';
let _llmConfig: LlmConfig = { ...DEFAULT_LLM_CONFIG };
let _batchAbortController: AbortController | null = null;
let _currentExecutionId = '';
let _currentBatchDecisions: Decision[] = [];
let _activeLlmExecutionIds: Set<string> = new Set();
let _failedRefIds: string[] = [];  // リトライ対象の失敗ref_id

// ========== State Object with Getters/Setters ==========

export const state = {
    // ----- References -----
    get references() { return _references; },
    setReferences(refs: ReferenceWithStatus[]) { _references = refs; },

    get currentIndex() { return _currentIndex; },
    setCurrentIndex(idx: number) { _currentIndex = idx; },

    get currentFilter() { return _currentFilter; },
    setCurrentFilter(filter: DecisionStatus | 'all') { _currentFilter = filter; },

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

    // ----- Source File Filters -----
    get sourceFiles() { return _sourceFiles; },
    setSourceFiles(files: Set<string>) { _sourceFiles = files; },
    clearSourceFiles() { _sourceFiles.clear(); },
    addSourceFile(file: string) { _sourceFiles.add(file); },

    get selectedSourceFiles() { return _selectedSourceFiles; },
    setSelectedSourceFiles(files: Set<string>) { _selectedSourceFiles = files; },
    addSelectedSourceFile(file: string) { _selectedSourceFiles.add(file); },
    removeSelectedSourceFile(file: string) { _selectedSourceFiles.delete(file); },

    // ----- User Settings -----
    get autoNavigateAfterDecision() { return _autoNavigateAfterDecision; },
    setAutoNavigateAfterDecision(value: boolean) { _autoNavigateAfterDecision = value; },

    get showRecordCountBelow() { return _showRecordCountBelow; },
    setShowRecordCountBelow(value: boolean) { _showRecordCountBelow = value; },

    get termFilterUseAnd() { return _termFilterUseAnd; },
    setTermFilterUseAnd(value: boolean) { _termFilterUseAnd = value; },

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
    setCurrentTab(tab: 'screening' | 'llm') { _currentTab = tab; },

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

    get failedRefIds() { return _failedRefIds; },
    setFailedRefIds(ids: string[]) { _failedRefIds = ids; },
    clearFailedRefIds() { _failedRefIds = []; },

    // ----- Reset Functions -----
    resetForLogout() {
        _spreadsheetId = '';
        _userEmail = '';
        _references = [];
        _isKeyOpened = false;
        _isAdmin = false;
        _currentIndex = 0;
        _currentFilter = 'pending';
        _sourceFiles.clear();
        _selectedSourceFiles.clear();
        _activeTermFilters = [];
        _currentTab = 'screening';
        _llmConfig = { ...DEFAULT_LLM_CONFIG };
        _batchAbortController = null;
        _currentExecutionId = '';
        _currentBatchDecisions = [];
        _activeLlmExecutionIds.clear();
        _failedRefIds = [];
    },

    resetForBack() {
        _spreadsheetId = '';
        _references = [];
        _currentIndex = 0;
        _sourceFiles.clear();
        _selectedSourceFiles.clear();
        _activeTermFilters = [];
    },
};

export type AppState = typeof state;
