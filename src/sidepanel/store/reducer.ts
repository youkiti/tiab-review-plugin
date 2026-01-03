/**
 * Reducer: 状態遷移ロジック
 * すべての状態変更はここを通る
 */

import type { AppState, Action } from './types';
import { getFilteredReferences } from './selectors';
import { createInitialMlState } from '../../lib/ml/types';
import { DEFAULT_LLM_CONFIG } from '../../lib/sheets-api';

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
        settings: {
            autoNavigateAfterDecision: true,
            showRecordCountBelow: true,
            termFilterUseAnd: true,
            treatMlAsManual: true,
            showAiHighlights: false,
            aiDecisionFilter: { include: true, exclude: true },
        },
        toast: null,
    },
};

/**
 * Reducer関数
 */
export function reducer(state: AppState, action: Action): AppState {
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

        // ========== データ操作 ==========
        case 'data/setReferences':
            return {
                ...state,
                data: { ...state.data, references: action.refs },
            };

        case 'data/updateReference': {
            const refs = state.data.references.map(r =>
                r.ref_id === action.refId ? { ...r, ...action.updates } : r
            );
            return {
                ...state,
                data: { ...state.data, references: refs },
            };
        }

        case 'data/setSpreadsheetId':
            return {
                ...state,
                data: { ...state.data, spreadsheetId: action.id },
            };

        case 'data/setUserEmail':
            return {
                ...state,
                data: { ...state.data, userEmail: action.email },
            };

        case 'data/setKeywords':
            return {
                ...state,
                data: { ...state.data, highlightKeywords: action.keywords },
            };

        case 'data/addKeyword': {
            const keywords = state.data.highlightKeywords;
            const list = keywords[action.keywordType];
            if (list.includes(action.word)) {
                return state; // 既に存在する
            }
            return {
                ...state,
                data: {
                    ...state.data,
                    highlightKeywords: {
                        ...keywords,
                        [action.keywordType]: [...list, action.word],
                    },
                },
            };
        }

        case 'data/removeKeyword': {
            const keywords = state.data.highlightKeywords;
            return {
                ...state,
                data: {
                    ...state.data,
                    highlightKeywords: {
                        ...keywords,
                        [action.keywordType]: keywords[action.keywordType].filter(w => w !== action.word),
                    },
                },
            };
        }

        case 'data/setLlmConfig':
            return {
                ...state,
                data: { ...state.data, llmConfig: action.config },
            };

        case 'data/setMlState':
            return {
                ...state,
                data: { ...state.data, mlState: action.mlState },
            };

        case 'data/setRecentSheets':
            return {
                ...state,
                data: { ...state.data, recentSheets: action.sheets },
            };

        case 'data/setIsAdmin':
            return {
                ...state,
                data: { ...state.data, isAdmin: action.isAdmin },
            };

        case 'data/setSourceFiles':
            return {
                ...state,
                data: { ...state.data, sourceFiles: action.files },
            };

        case 'data/setSelectedSourceFiles':
            return {
                ...state,
                data: { ...state.data, selectedSourceFiles: action.files },
            };

        case 'data/toggleSourceFile': {
            const newSelected = new Set(state.data.selectedSourceFiles);
            if (newSelected.has(action.file)) {
                newSelected.delete(action.file);
            } else {
                newSelected.add(action.file);
            }
            return {
                ...state,
                data: { ...state.data, selectedSourceFiles: newSelected },
                // ソースファイル切替時はインデックスリセット
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: 0 },
                },
            };
        }

        case 'data/addSelectedSourceFile': {
            const newSelected = new Set(state.data.selectedSourceFiles);
            newSelected.add(action.file);
            return {
                ...state,
                data: { ...state.data, selectedSourceFiles: newSelected },
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: 0 },
                },
            };
        }

        case 'data/removeSelectedSourceFile': {
            const newSelected = new Set(state.data.selectedSourceFiles);
            newSelected.delete(action.file);
            return {
                ...state,
                data: { ...state.data, selectedSourceFiles: newSelected },
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: 0 },
                },
            };
        }

        case 'data/deleteSourceFile': {
            const newSourceFiles = new Set(state.data.sourceFiles);
            newSourceFiles.delete(action.file);
            const newSelectedSourceFiles = new Set(state.data.selectedSourceFiles);
            newSelectedSourceFiles.delete(action.file);
            return {
                ...state,
                data: {
                    ...state.data,
                    sourceFiles: newSourceFiles,
                    selectedSourceFiles: newSelectedSourceFiles,
                },
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: 0 },
                },
            };
        }

        case 'data/setAvailableReviewers':
            return {
                ...state,
                data: { ...state.data, availableReviewers: action.reviewers },
            };

        case 'data/setEnabledReviewers':
            return {
                ...state,
                data: { ...state.data, enabledReviewers: action.reviewers },
            };

        case 'data/toggleReviewer': {
            const newEnabled = new Set(state.data.enabledReviewers);
            if (newEnabled.has(action.reviewerId)) {
                newEnabled.delete(action.reviewerId);
            } else {
                newEnabled.add(action.reviewerId);
            }
            return {
                ...state,
                data: { ...state.data, enabledReviewers: newEnabled },
            };
        }

        case 'data/setFailedRefIds':
            return {
                ...state,
                data: { ...state.data, failedRefIds: action.ids },
            };

        case 'data/setCurrentBatchDecisions':
            return {
                ...state,
                data: { ...state.data, currentBatchDecisions: action.decisions },
            };

        case 'data/addActiveLlmExecutionId': {
            const newIds = new Set(state.data.activeLlmExecutionIds);
            newIds.add(action.id);
            return {
                ...state,
                data: { ...state.data, activeLlmExecutionIds: newIds },
            };
        }

        case 'data/clearActiveLlmExecutionIds':
            return {
                ...state,
                data: { ...state.data, activeLlmExecutionIds: new Set() },
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
            return {
                ...state,
                ui: {
                    ...state.ui,
                    screening: { ...state.ui.screening, currentIndex: action.index },
                },
            };

        case 'screening/setFilter':
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
