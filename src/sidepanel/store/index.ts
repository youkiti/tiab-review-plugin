/**
 * Store: 状態管理の中核
 * Redux-like なシンプルなStore実装
 */

import type { AppState, Action, Store, Dispatch } from './types';
import { reducer, initialState } from './reducer';

/**
 * Store を作成
 */
export function createStore(initial: AppState = initialState): Store {
    let state = initial;
    const listeners = new Set<(state: AppState) => void>();

    return {
        /**
         * 現在の状態を取得
         */
        getState: () => state,

        /**
         * アクションをディスパッチして状態を更新
         */
        dispatch: (action: Action) => {
            const prevState = state;
            state = reducer(state, action);

            // 状態が変更された場合のみリスナーを呼び出す
            if (prevState !== state) {
                listeners.forEach(listener => listener(state));
            }
        },

        /**
         * 状態変更を購読
         * @returns 購読解除関数
         */
        subscribe: (listener: (state: AppState) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

// ========== グローバルStore（シングルトン） ==========

let globalStore: Store | null = null;

/**
 * グローバルStoreを初期化
 */
export function initializeStore(initial?: AppState): Store {
    globalStore = createStore(initial);
    return globalStore;
}

/**
 * グローバルStoreを取得
 */
export function getStore(): Store {
    if (!globalStore) {
        throw new Error('Store is not initialized. Call initializeStore() first.');
    }
    return globalStore;
}

/**
 * グローバルStoreにdispatch
 */
export function dispatch(action: Action): void {
    getStore().dispatch(action);
}

/**
 * グローバルStoreの状態を取得
 */
export function getState(): AppState {
    return getStore().getState();
}

/**
 * グローバルStoreを購読
 */
export function subscribe(listener: (state: AppState) => void): () => void {
    return getStore().subscribe(listener);
}

// ========== 型のre-export ==========
export type { AppState, Action, Store, Dispatch, View, Tab, TermFilter, SheetInfo } from './types';
export { initialState } from './reducer';

// ========== Selectorsのre-export ==========
export {
    getFilteredReferences,
    getCurrentReference,
    getProgressStats,
    getFilterCounts,
    getMlFilteredRanking,
    getCurrentMlReference,
    getAiEvidenceList,
    getEncourageMessage,
    getMyManualDecisionStatus,
} from './selectors';
