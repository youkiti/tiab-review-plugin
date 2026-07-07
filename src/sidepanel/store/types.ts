/**
 * Store 型定義
 * 状態管理の中核となる型を定義
 */

import type {
    ReferenceWithStatus,
    DecisionStatus,
    Decision,
    LlmConfig,
} from '../../lib/types';
import type { MlState } from '../../lib/ml/types';
import type { HighlightKeywords } from '../../lib/sheets-api';
import type { FulltextPoolRule } from '../../lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../../lib/fulltext-assignment';

// ========== View型（画面遷移の真実） ==========
export type View = 'login' | 'project' | 'screening' | 'llm' | 'ml' | 'settings';

// ========== Tab型（screening/llm/ml/fulltext内の切替） ==========
export type Tab = 'screening' | 'llm' | 'ml' | 'fulltext';

// ========== SheetInfo型 ==========
export interface SheetInfo {
    id: string;
    name: string;
    lastOpened?: string;
}

// ========== TermFilter型 ==========
export interface TermFilter {
    term: string;
    type: 'include' | 'exclude';
}

// ========== AppState ==========
export interface AppState {
    // データ層: APIから取得した純粋なデータ
    data: {
        references: ReferenceWithStatus[];
        spreadsheetId: string;
        userEmail: string;
        highlightKeywords: HighlightKeywords;
        llmConfig: LlmConfig;
        mlState: MlState;
        recentSheets: SheetInfo[];
        isAdmin: boolean;
        // フルテキスト候補ルール（Configシート共有設定、未設定はnull）
        fulltextPoolRule: FulltextPoolRule | null;
        // フルテキスト担当割り振り（Configシート共有設定、未設定は status 'none'）
        fulltextAssignment: FulltextAssignmentConfig;
        // ソースファイル
        sourceFiles: Set<string>;
        selectedSourceFiles: Set<string>;
        // レビュアー
        availableReviewers: Set<string>;
        enabledReviewers: Set<string>;
        // LLMバッチ関連
        activeLlmExecutionIds: Set<string>;
        currentBatchDecisions: Decision[];
        failedRefIds: string[];
    };

    // UI層: 画面表示に直結する状態
    ui: {
        // 画面遷移（hidden競合の根本解決）
        view: View;
        currentTab: Tab;

        // スクリーニング
        screening: {
            currentIndex: number;
            currentFilter: DecisionStatus | 'all' | 'fulltext_candidates';
            searchQuery: string;
            isKeyOpened: boolean;
            activeTermFilters: TermFilter[];
        };

        // ML
        ml: {
            currentIndex: number;
            searchQuery: string;
        };

        // LLM
        llm: {
            batchRunning: boolean;
            currentExecutionId: string;
        };

        // 一時UI（メニュー開閉/モーダル）
        flags: {
            loading: boolean;
            exportMenuOpen: boolean;
            shareInputOpen: boolean;
            settingsOpen: boolean;
        };

        // ユーザー設定
        settings: {
            autoNavigateAfterDecision: boolean;
            showRecordCountBelow: boolean;
            termFilterUseAnd: boolean;
            treatMlAsManual: boolean;
            showAiHighlights: boolean;
            aiDecisionFilter: Record<string, { include: boolean; exclude: boolean; maybe?: boolean }>;
            abstractSubsectionBreakEnabled: boolean;
            abstractSubsectionHeadings: string[];
        };

        // トースト/フィードバック
        toast: { message: string; duration: number } | null;
    };
}

// ========== Action型 ==========
export type Action =
    // 画面遷移
    | { type: 'view/change'; view: View }
    | { type: 'tab/change'; tab: Tab }

    // データ操作
    | { type: 'data/setReferences'; refs: ReferenceWithStatus[] }
    | { type: 'data/updateReference'; refId: string; updates: Partial<ReferenceWithStatus> }
    | { type: 'data/setSpreadsheetId'; id: string }
    | { type: 'data/setUserEmail'; email: string }
    | { type: 'data/setKeywords'; keywords: HighlightKeywords }
    | { type: 'data/addKeyword'; keywordType: 'include' | 'exclude'; word: string }
    | { type: 'data/removeKeyword'; keywordType: 'include' | 'exclude'; word: string }
    | { type: 'data/setLlmConfig'; config: LlmConfig }
    | { type: 'data/setMlState'; mlState: MlState }
    | { type: 'data/setRecentSheets'; sheets: SheetInfo[] }
    | { type: 'data/setIsAdmin'; isAdmin: boolean }
    | { type: 'data/setFulltextPoolRule'; rule: FulltextPoolRule | null }
    | { type: 'data/setFulltextAssignment'; config: FulltextAssignmentConfig }
    | { type: 'data/setSourceFiles'; files: Set<string> }
    | { type: 'data/setSelectedSourceFiles'; files: Set<string> }
    | { type: 'data/toggleSourceFile'; file: string }
    | { type: 'data/addSelectedSourceFile'; file: string }
    | { type: 'data/removeSelectedSourceFile'; file: string }
    | { type: 'data/deleteSourceFile'; file: string }
    | { type: 'data/setAvailableReviewers'; reviewers: Set<string> }
    | { type: 'data/setEnabledReviewers'; reviewers: Set<string> }
    | { type: 'data/toggleReviewer'; reviewerId: string }
    | { type: 'data/setFailedRefIds'; ids: string[] }
    | { type: 'data/setCurrentBatchDecisions'; decisions: Decision[] }
    | { type: 'data/addActiveLlmExecutionId'; id: string }
    | { type: 'data/clearActiveLlmExecutionIds' }

    // スクリーニングUI
    | { type: 'screening/navigate'; direction: 1 | -1 }
    | { type: 'screening/setIndex'; index: number }
    | { type: 'screening/setFilter'; filter: AppState['ui']['screening']['currentFilter'] }
    | { type: 'screening/setSearch'; query: string }
    | { type: 'screening/toggleKeyOpen' }
    | { type: 'screening/setKeyOpened'; opened: boolean }
    | { type: 'screening/addTermFilter'; filter: TermFilter }
    | { type: 'screening/removeTermFilter'; term: string; termType: string }
    | { type: 'screening/clearTermFilters' }

    // ML UI
    | { type: 'ml/navigate'; direction: 1 | -1 }
    | { type: 'ml/setIndex'; index: number }
    | { type: 'ml/setSearch'; query: string }

    // LLM UI
    | { type: 'llm/setBatchRunning'; running: boolean }
    | { type: 'llm/setExecutionId'; id: string }

    // 一時UI
    | { type: 'ui/setLoading'; loading: boolean }
    | { type: 'ui/toggleExportMenu' }
    | { type: 'ui/closeExportMenu' }
    | { type: 'ui/toggleShareInput' }
    | { type: 'ui/closeShareInput' }
    | { type: 'ui/toggleSettings' }
    | { type: 'ui/closeSettings' }
    | { type: 'ui/closeAllMenus' }
    | { type: 'ui/showToast'; message: string; duration?: number }
    | { type: 'ui/hideToast' }

    // 設定
    | { type: 'settings/setAutoNavigate'; value: boolean }
    | { type: 'settings/setShowRecordCountBelow'; value: boolean }
    | { type: 'settings/setTermFilterUseAnd'; value: boolean }
    | { type: 'settings/setTreatMlAsManual'; value: boolean }
    | { type: 'settings/setShowAiHighlights'; value: boolean }
    | { type: 'settings/setAiDecisionFilter'; filter: Record<string, { include: boolean; exclude: boolean }> }
    | { type: 'settings/setAbstractSubsectionBreakEnabled'; value: boolean }
    | { type: 'settings/setAbstractSubsectionHeadings'; value: string[] }

    // リセット
    | { type: 'reset/logout' }
    | { type: 'reset/back' };

// ========== Store型 ==========
export interface Store {
    getState: () => AppState;
    dispatch: (action: Action) => void;
    subscribe: (listener: (state: AppState) => void) => () => void;
}

// ========== Dispatch型（イベントハンドラ用） ==========
export type Dispatch = (action: Action) => void;
