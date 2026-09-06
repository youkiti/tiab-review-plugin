import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_SETTINGS, parseUserSettings } from '../src/lib/user-settings';
import { createStore, initializeStore, initialState } from '../src/sidepanel/store';
import { state } from '../src/sidepanel/state';
import {
    initializeFromLegacy, legacyToAppState, syncToLegacyState, updateSettings,
    updateAbstractSubsectionHeadings,
} from '../src/sidepanel/store/compat';

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

test('互換同期でStore所有の設定を上書きしない', () => {
    const store = initializeStore();
    try {
        updateSettings('autoNavigateAfterDecision', false);
        updateSettings('showAiHighlights', false);
        const settings = store.getState().ui.settings;
        assert.equal('settings' in legacyToAppState().ui, false);
        syncToLegacyState(initialState);
        initializeFromLegacy();
        assert.equal(store.getState().ui.settings, settings);
        assert.equal(state.autoNavigateAfterDecision, false);
        assert.equal(state.showAiHighlights, false);
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
