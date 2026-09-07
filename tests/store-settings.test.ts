import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, parseUserSettings } from '../src/lib/user-settings';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../src/lib/fulltext-assignment';
import { DEFAULT_LLM_CONFIG } from '../src/lib/sheets-api';
import { createInitialMlState } from '../src/lib/ml/types';
import { createStore, initializeStore, initialState } from '../src/sidepanel/store';
import { state } from '../src/sidepanel/state';
import { updateSettings, updateAbstractSubsectionHeadings } from '../src/sidepanel/store/compat';
import * as compat from '../src/sidepanel/store/compat';

test('Storeの初期設定は共通の既定値から導出する', () => {
    assert.deepEqual(initialState.ui.settings, DEFAULT_USER_SETTINGS);
});

test('設定の一括反映は一度だけ通知し、他領域を変更しない', () => {
    const store = createStore();
    const before = store.getState();
    let notifications = 0;
    store.subscribe(() => { notifications++; });
    const patch = { showRecordCountBelow: false, abstractSubsectionHeadings: ['結果:'] };
    store.dispatch({ type: 'settings/patch', patch });
    const after = store.getState();
    assert.deepEqual(after.ui.settings, { ...before.ui.settings, ...patch });
    assert.equal(after.data, before.data);
    assert.equal(after.ui.screening, before.ui.screening);
    assert.deepEqual(before.ui.settings, DEFAULT_USER_SETTINGS);
    assert.equal(notifications, 1);
});

test('既存の設定アクションもStoreの設定だけを更新する', () => {
    const store = createStore();
    store.dispatch({ type: 'settings/setShowAiHighlights', value: false });
    assert.deepEqual(store.getState().ui.settings, { ...DEFAULT_USER_SETTINGS, showAiHighlights: false });
});

test('旧stateの設定は読み取り専用でStoreの更新を直ちに参照する', () => {
    const store = initializeStore();
    try {
        const next = parseUserSettings({ autoNavigateAfterDecision: false, abstractSubsectionHeadings: [] });
        store.dispatch({ type: 'settings/patch', patch: next });
        for (const key of Object.keys(next) as (keyof typeof next)[]) {
            assert.deepEqual(state[key], next[key]);
            const descriptor = Object.getOwnPropertyDescriptor(state, key);
            assert.equal(typeof descriptor?.get, 'function');
            assert.equal(descriptor?.set, undefined);
            assert.equal(`set${key[0].toUpperCase()}${key.slice(1)}` in state, false);
        }
        updateSettings('showAiHighlights', false);
        updateSettings('aiDecisionFilter', { 'llm:test': { include: true, exclude: false, maybe: false } });
        updateAbstractSubsectionHeadings(['結論:']);
        assert.equal(state.showAiHighlights, false);
        assert.deepEqual(state.aiDecisionFilter, store.getState().ui.settings.aiDecisionFilter);
        assert.deepEqual(state.abstractSubsectionHeadings, ['結論:']);
    } finally {
        initializeStore();
    }
});

test('互換レイヤーの双方向同期はresetForLogout/resetForBackだけに限定される', () => {
    const store = initializeStore();
    try {
        // Issue #154 工程3 で legacyToAppState/syncToLegacyState/initializeFromLegacy を削除した。
        // LLM/MLバッチ領域（llmConfig・mlState・activeLlmExecutionIds・currentBatchDecisions・
        // failedRefIds）もStore所有に一本化し、双方向同期（legacy setterとdispatchの両方を呼ぶ）は
        // 一つも残っていないことを固定する。
        for (const name of ['legacyToAppState', 'syncToLegacyState', 'initializeFromLegacy']) {
            assert.equal(name in compat, false);
        }

        updateSettings('autoNavigateAfterDecision', false);
        updateSettings('showAiHighlights', false);
        const settings = store.getState().ui.settings;

        // Store所有になった領域のcompatラッパーはStoreのみを更新し、設定を上書きしない。
        compat.setSpreadsheetId('sheet-1');
        compat.setUserEmail('user@example.test');
        compat.setKeywords({ include: ['a'], exclude: [] });
        compat.setIsAdmin(true);
        compat.setFulltextPoolRule(null);
        compat.setFulltextAssignment({ ...DEFAULT_FULLTEXT_ASSIGNMENT });
        compat.setAvailableReviewers(new Set(['user@example.test']));
        compat.setEnabledReviewers(new Set(['user@example.test']));
        compat.changeTab('llm');
        assert.equal(store.getState().ui.settings, settings);
        assert.equal(state.autoNavigateAfterDecision, false);
        assert.equal(state.showAiHighlights, false);

        // compatラッパーはStoreを更新し、state.Xのgetterで直ちに同じ値が読める。
        assert.equal(state.spreadsheetId, 'sheet-1');
        assert.equal(state.userEmail, 'user@example.test');
        assert.deepEqual(state.highlightKeywords, { include: ['a'], exclude: [] });
        assert.equal(state.isAdmin, true);
        assert.equal(state.currentTab, 'llm');
    } finally {
        initializeStore();
    }
});

test('LLM/MLバッチ領域はlegacy setterを持たずcompat経由でStoreだけを更新する', () => {
    const store = initializeStore();
    try {
        // Issue #154 工程3 で LLM/ML バッチ領域を Store 所有へ移した。5領域とも state.ts 側に legacy setter が無いことを固定する。
        for (const name of [
            'setLlmConfig', 'setMlState', 'setActiveLlmExecutionIds',
            'setCurrentBatchDecisions', 'setFailedRefIds', 'clearFailedRefIds',
        ]) {
            assert.equal(name in state, false);
        }
        for (const name of ['llmConfig', 'mlState', 'activeLlmExecutionIds', 'currentBatchDecisions', 'failedRefIds'] as const) {
            const descriptor = Object.getOwnPropertyDescriptor(state, name);
            assert.equal(typeof descriptor?.get, 'function');
            assert.equal(descriptor?.set, undefined);
        }

        const settings = store.getState().ui.settings;
        const llmConfig = { ...DEFAULT_LLM_CONFIG, llm_enabled: true };
        const mlState = { ...createInitialMlState(), status: 'ready' as const, currentIndex: 3 };
        const decision = {
            decision_id: 'd1', ref_id: 'r1', reviewer_id: 'llm:test',
            decision: 'include' as const, decided_at: '2026-01-01T00:00:00.000Z',
        };

        // compatラッパーはStoreだけを更新し、設定など他領域を上書きしない。
        compat.setLlmConfig(llmConfig);
        compat.setMlState(mlState);
        compat.setActiveLlmExecutionIds(new Set(['exec-1', 'exec-2']));
        compat.setCurrentBatchDecisions([decision]);
        compat.setFailedRefIds(['r-failed']);
        assert.equal(store.getState().ui.settings, settings);

        // compatラッパーはStoreを更新し、state.Xのgetterで直ちに同じ値が読める。
        assert.deepEqual(state.llmConfig, llmConfig);
        assert.deepEqual(state.mlState, mlState);
        assert.deepEqual(state.activeLlmExecutionIds, new Set(['exec-1', 'exec-2']));
        assert.deepEqual(state.currentBatchDecisions, [decision]);
        assert.deepEqual(state.failedRefIds, ['r-failed']);

        compat.clearFailedRefIds();
        assert.deepEqual(state.failedRefIds, []);
    } finally {
        initializeStore();
    }
});

test('reset/back後はLLM/MLバッチ領域のうちmlStateだけが初期化される', () => {
    const store = initializeStore();
    try {
        const llmConfig = { ...DEFAULT_LLM_CONFIG, llm_enabled: true };
        compat.setLlmConfig(llmConfig);
        compat.setMlState({ ...createInitialMlState(), status: 'ready' as const, currentIndex: 5 });
        compat.setActiveLlmExecutionIds(new Set(['exec-1']));
        compat.setCurrentBatchDecisions([{
            decision_id: 'd1', ref_id: 'r1', reviewer_id: 'llm:test',
            decision: 'include' as const, decided_at: '2026-01-01T00:00:00.000Z',
        }]);
        compat.setFailedRefIds(['r-failed']);

        store.dispatch({ type: 'reset/back' });

        // mlStateはreset/backで明示的に初期化される（他プロジェクトのML状態を持ち越さないため）。
        assert.deepEqual(state.mlState, createInitialMlState());
        // 残り4領域はreset/backでは戻らない（次のプロジェクト読み込みで上書きされる想定）。
        assert.deepEqual(state.llmConfig, llmConfig);
        assert.deepEqual(state.activeLlmExecutionIds, new Set(['exec-1']));
        assert.equal(state.currentBatchDecisions.length, 1);
        assert.deepEqual(state.failedRefIds, ['r-failed']);
    } finally {
        initializeStore();
    }
});

test('reset/logout後はLLM/MLバッチ領域が全て既定値に戻る', () => {
    const store = initializeStore();
    try {
        compat.setLlmConfig({ ...DEFAULT_LLM_CONFIG, llm_enabled: true });
        compat.setMlState({ ...createInitialMlState(), status: 'ready' as const, currentIndex: 5 });
        compat.setActiveLlmExecutionIds(new Set(['exec-1']));
        compat.setCurrentBatchDecisions([{
            decision_id: 'd1', ref_id: 'r1', reviewer_id: 'llm:test',
            decision: 'include' as const, decided_at: '2026-01-01T00:00:00.000Z',
        }]);
        compat.setFailedRefIds(['r-failed']);

        store.dispatch({ type: 'reset/logout' });

        assert.deepEqual(state.llmConfig, DEFAULT_LLM_CONFIG);
        assert.deepEqual(state.mlState, createInitialMlState());
        assert.deepEqual(state.activeLlmExecutionIds, new Set());
        assert.deepEqual(state.currentBatchDecisions, []);
        assert.deepEqual(state.failedRefIds, []);
    } finally {
        initializeStore();
    }
});

test('ログアウトとプロジェクト切替で個人設定を保持する', () => {
    const store = createStore();
    store.dispatch({ type: 'settings/patch', patch: { autoNavigateAfterDecision: false } });
    const settings = store.getState().ui.settings;
    store.dispatch({ type: 'reset/back' });
    assert.equal(store.getState().ui.settings, settings);
    store.dispatch({ type: 'reset/logout' });
    assert.equal(store.getState().ui.settings, settings);
});
