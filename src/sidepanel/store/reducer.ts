/**
 * Reducer: 状態遷移ロジック
 * すべての状態変更はここを通る
 */

import { reduceData } from './reducers/data';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../../lib/assignment-set';
import { parseUserSettings } from '../../lib/user-settings';
import type { AppState, Action } from './types';
import { getFilteredReferences } from './selectors';
import { createInitialMlState } from '../../lib/ml/types';
import { DEFAULT_LLM_CONFIG } from '../../lib/sheets-api';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../../lib/fulltext-assignment';

/**
 * 初期状態
 */
export const initialState: AppState = {
    data: {
        references: [],
        spreadsheetId: '',
        userEmail: '',
        highlightKeywords: { include: [], exclude: [] },
        llmConfig: { ...DEFAULT_LLM_CONFIG },
        mlState: createInitialMlState(),
        recentSheets: [],
        isAdmin: false,
        fulltextPoolRule: null,
        fulltextAssignment: { ...DEFAULT_FULLTEXT_ASSIGNMENT },
        assignmentConfig: { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} },
        assignmentSets: new Set(),
        selectedAssignmentSets: new Set(),
        selectedFulltextSets: new Set(),
        sourceFiles: new Set(),
        selectedSourceFiles: new Set(),
        availableReviewers: new Set(),
        enabledReviewers: new Set(),
        activeLlmExecutionIds: new Set(),
        currentBatchDecisions: [],
        failedRefIds: [],
    },
    ui: {
        view: 'login',
        currentTab: 'screening',
        screening: {
            currentIndex: 0,
            currentFilter: 'pending',
            searchQuery: '',
            isKeyOpened: false,
            activeTermFilters: [],
        },
        ml: {
            currentIndex: 0,
            searchQuery: '',
        },
        llm: {
            batchRunning: false,
            currentExecutionId: '',
        },
        flags: {
            loading: false,
            exportMenuOpen: false,
            shareInputOpen: false,
            settingsOpen: false,
        },
        settings: parseUserSettings({}),
        toast: null,
    },
};

/**
 * Reducer関数
 */
export function reducer(state: AppState, action: Action): AppState {
    const dataState = reduceData(state, action);
    if (dataState) return dataState;

    switch (action.type) {
        // ========== 画面遷移 ==========
        case 'view/change':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    view: action.view,
                    // 画面遷移時は一時UIを閉じる（矛盾防止）
                    flags: {
                        ...state.ui.flags,
                        exportMenuOpen: false,
                        shareInputOpen: false,
                        settingsOpen: false,
                    },
                },
            };

        case 'tab/change':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    currentTab: action.tab,
                    // タブ切替時も一時UIを閉じる
                    flags: {
                        ...state.ui.flags,
                        exportMenuOpen: false,
                        shareInputOpen: false,
                    },
                },
            };

        // ========== スクリーニングUI ==========
        case 'screening/navigate': {
            const filtered = getFilteredReferences(state);
            let newIndex = state.ui.screening.currentIndex + action.direction;
            // ループナビゲーション
            if (newIndex < 0) {
                newIndex = filtered.length - 1;
            } else if (newIndex >= filtered.length) {
                newIndex = 0;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: newIndex },
                },
            };
        }

        case 'screening/setIndex':
            if (state.ui.screening.currentIndex === action.index) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: action.index },
                },
            };

        case 'screening/setFilter':
            if (state.ui.screening.currentFilter === action.filter && state.ui.screening.currentIndex === 0) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        currentFilter: action.filter,
                        currentIndex: 0, // フィルター変更時はリセット
                    },
                },
            };

        case 'screening/setSearch':
            if (state.ui.screening.searchQuery === action.query && state.ui.screening.currentIndex === 0) return state;
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        searchQuery: action.query,
                        currentIndex: 0, // 検索変更時はリセット
                    },
                },
            };

        case 'screening/toggleKeyOpen':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        isKeyOpened: !state.ui.screening.isKeyOpened,
                    },
                },
            };

        case 'screening/setKeyOpened':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, isKeyOpened: action.opened },
                },
            };

        case 'screening/addTermFilter': {
            // 既存チェック
            const exists = state.ui.screening.activeTermFilters.some(
                f => f.term.toLowerCase() === action.filter.term.toLowerCase() && f.type === action.filter.type
            );
            if (exists) return state;

            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        activeTermFilters: [...state.ui.screening.activeTermFilters, action.filter],
                        currentIndex: 0,
                    },
                },
            };
        }

        case 'screening/removeTermFilter':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        activeTermFilters: state.ui.screening.activeTermFilters.filter(
                            f => !(f.term === action.term && f.type === action.termType)
                        ),
                        currentIndex: 0,
                    },
                },
            };

        case 'screening/clearTermFilters':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: {
                        ...state.ui.screening,
                        activeTermFilters: [],
                        currentIndex: 0,
                    },
                },
            };

        // ========== ML UI ==========
        case 'ml/navigate': {
            const ranking = state.data.mlState.ranking;
            let newIndex = state.ui.ml.currentIndex + action.direction;
            if (newIndex < 0) {
                newIndex = ranking.length - 1;
            } else if (newIndex >= ranking.length) {
                newIndex = 0;
            }
            return {
                ...state,
                ui: {
                    ...state.ui,
                    ml: { ...state.ui.ml, currentIndex: newIndex },
                },
            };
        }

        case 'ml/setIndex':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    ml: { ...state.ui.ml, currentIndex: action.index },
                },
            };

        case 'ml/setSearch':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    ml: {
                        ...state.ui.ml,
                        searchQuery: action.query,
                        currentIndex: 0,
                    },
                },
            };

        // ========== LLM UI ==========
        case 'llm/setBatchRunning':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    llm: { ...state.ui.llm, batchRunning: action.running },
                },
            };

        case 'llm/setExecutionId':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    llm: { ...state.ui.llm, currentExecutionId: action.id },
                },
            };

        // ========== 一時UI ==========
        case 'ui/setLoading':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: { ...state.ui.flags, loading: action.loading },
                },
            };

        case 'ui/toggleExportMenu':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: {
                        ...state.ui.flags,
                        exportMenuOpen: !state.ui.flags.exportMenuOpen,
                        shareInputOpen: false, // 排他制御
                    },
                },
            };

        case 'ui/closeExportMenu':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: { ...state.ui.flags, exportMenuOpen: false },
                },
            };

        case 'ui/toggleShareInput':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: {
                        ...state.ui.flags,
                        shareInputOpen: !state.ui.flags.shareInputOpen,
                        exportMenuOpen: false, // 排他制御
                    },
                },
            };

        case 'ui/closeShareInput':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: { ...state.ui.flags, shareInputOpen: false },
                },
            };

        case 'ui/toggleSettings':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: { ...state.ui.flags, settingsOpen: !state.ui.flags.settingsOpen },
                },
            };

        case 'ui/closeSettings':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: { ...state.ui.flags, settingsOpen: false },
                },
            };

        case 'ui/closeAllMenus':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    flags: {
                        ...state.ui.flags,
                        exportMenuOpen: false,
                        shareInputOpen: false,
                    },
                },
            };

        case 'ui/showToast':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    toast: { message: action.message, duration: action.duration ?? 3000 },
                },
            };

        case 'ui/hideToast':
            return {
                ...state,
                ui: { ...state.ui, toast: null },
            };

        // ========== 設定 ==========
        case 'settings/patch':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, ...action.patch },
                },
            };

        case 'settings/setAutoNavigate':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, autoNavigateAfterDecision: action.value },
                },
            };

        case 'settings/setShowRecordCountBelow':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, showRecordCountBelow: action.value },
                },
            };

        case 'settings/setTermFilterUseAnd':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, termFilterUseAnd: action.value },
                },
            };

        case 'settings/setTreatMlAsManual':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, treatMlAsManual: action.value },
                },
            };

        case 'settings/setShowAiHighlights':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, showAiHighlights: action.value },
                },
            };

        case 'settings/setAiDecisionFilter':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, aiDecisionFilter: action.filter },
                },
            };

        case 'settings/setAbstractSubsectionBreakEnabled':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, abstractSubsectionBreakEnabled: action.value },
                },
            };

        case 'settings/setAbstractSubsectionHeadings':
            return {
                ...state,
                ui: {
                    ...state.ui,
                    settings: { ...state.ui.settings, abstractSubsectionHeadings: action.value },
                },
            };

        // ========== リセット ==========
        case 'reset/logout':
            return {
                ...initialState,
                // 設定は維持
                ui: {
                    ...initialState.ui,
                    settings: state.ui.settings,
                },
            };

        case 'reset/back':
            return {
                ...state,
                data: {
                    ...state.data,
                    spreadsheetId: '',
                    references: [],
                    fulltextPoolRule: null,
                    fulltextAssignment: { ...DEFAULT_FULLTEXT_ASSIGNMENT },
                    assignmentConfig: { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} },
                    assignmentSets: new Set(),
                    selectedAssignmentSets: new Set(),
                    selectedFulltextSets: new Set(),
                    sourceFiles: new Set(),
                    selectedSourceFiles: new Set(),
                    enabledReviewers: new Set(),
                    availableReviewers: new Set(),
                    mlState: createInitialMlState(),
                },
                ui: {
                    ...state.ui,
                    view: 'project',
                    screening: {
                        ...state.ui.screening,
                        currentIndex: 0,
                        activeTermFilters: [],
                    },
                },
            };

        default:
            return state;
    }
}
