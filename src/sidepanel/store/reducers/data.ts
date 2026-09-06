/** データ領域の状態遷移。担当セットの更新では既存どおり表示位置を変更しない。 */
import type { AppState, Action } from '../types';
import { DEFAULT_ASSIGNMENT_CONFIG } from '../../../lib/assignment-set';

export function reduceData(state: AppState, action: Action): AppState | undefined {
    switch (action.type) {
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

        case 'data/setFulltextPoolRule':
            return {
                ...state,
                data: { ...state.data, fulltextPoolRule: action.rule },
            };

        case 'data/setFulltextAssignment':
            return {
                ...state,
                data: { ...state.data, fulltextAssignment: action.config },
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

        // toggleReviewerと異なり、呼び出し側が持つ真偽値をそのまま反映する（現在の集合に対する
        // 反転ではない）。混在レビュアー（人手＋ML）のチェックボックス切替では、同じ enabled 値を
        // 独立した2キー（本体キーと ::ml キー）へ適用するため、片方が既にその状態でも
        // toggleReviewer だと意図せず反転してしまう。
        case 'data/addReviewer': {
            const newEnabled = new Set(state.data.enabledReviewers);
            newEnabled.add(action.reviewerId);
            return {
                ...state,
                data: { ...state.data, enabledReviewers: newEnabled },
            };
        }

        case 'data/removeReviewer': {
            const newEnabled = new Set(state.data.enabledReviewers);
            newEnabled.delete(action.reviewerId);
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

        case 'data/setAssignmentConfig':
            return { ...state, data: { ...state.data, assignmentConfig: action.config } };
        case 'data/resetAssignmentConfig':
            return { ...state, data: { ...state.data, assignmentConfig: { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} } } };
        case 'data/addSourceFile':
            return { ...state, data: { ...state.data, sourceFiles: new Set([...state.data.sourceFiles, action.file]) } };
        case 'data/clearSourceFiles':
            return { ...state, data: { ...state.data, sourceFiles: new Set() } };
        case 'data/setAssignmentSets':
            return { ...state, data: { ...state.data, assignmentSets: action.sets } };
        case 'data/addAssignmentSet':
            return { ...state, data: { ...state.data, assignmentSets: new Set([...state.data.assignmentSets, action.setId]) } };
        case 'data/removeAssignmentSet': {
            const sets = new Set(state.data.assignmentSets);
            sets.delete(action.setId);
            return { ...state, data: { ...state.data, assignmentSets: sets } };
        }
        case 'data/clearAssignmentSets':
            return { ...state, data: { ...state.data, assignmentSets: new Set() } };
        case 'data/setSelectedAssignmentSets':
            return { ...state, data: { ...state.data, selectedAssignmentSets: action.sets } };
        case 'data/addSelectedAssignmentSet':
            return { ...state, data: { ...state.data, selectedAssignmentSets: new Set([...state.data.selectedAssignmentSets, action.setId]) } };
        case 'data/removeSelectedAssignmentSet': {
            const sets = new Set(state.data.selectedAssignmentSets);
            sets.delete(action.setId);
            return { ...state, data: { ...state.data, selectedAssignmentSets: sets } };
        }
        case 'data/clearSelectedAssignmentSets':
            return { ...state, data: { ...state.data, selectedAssignmentSets: new Set() } };
        case 'data/setSelectedFulltextSets':
            return { ...state, data: { ...state.data, selectedFulltextSets: action.sets } };
        case 'data/addSelectedFulltextSet':
            return { ...state, data: { ...state.data, selectedFulltextSets: new Set([...state.data.selectedFulltextSets, action.setId]) } };
        case 'data/removeSelectedFulltextSet': {
            const sets = new Set(state.data.selectedFulltextSets);
            sets.delete(action.setId);
            return { ...state, data: { ...state.data, selectedFulltextSets: sets } };
        }
        case 'data/clearSelectedFulltextSets':
            return { ...state, data: { ...state.data, selectedFulltextSets: new Set() } };
        default:
            return undefined;
    }
}
