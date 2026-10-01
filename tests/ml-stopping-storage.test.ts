import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/sidepanel/state';
import { initializeStore } from '../src/sidepanel/store';
import { setSpreadsheetId as syncSetSpreadsheetId } from '../src/sidepanel/store/compat';
import { loadStoppingRuleFromStorage, saveStoppingRuleToStorage } from '../src/sidepanel/features/ml/stopping-storage';

// state.spreadsheetId はIssue #154 工程3でStoreを読むgetterのみになったため、
// saveStoppingRuleToStorage() が内部で参照する前にStoreを初期化しておく必要がある。
initializeStore();

test('停止基準の保存先をプロジェクト間で分離し、保存完了まで待つ', async () => {
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const previousId = state.spreadsheetId;
    const writes: unknown[] = [];
    let complete: () => void = () => {};
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        storage: { local: { set: (data: unknown) => {
            writes.push(data);
            return new Promise<void>((resolve) => { complete = resolve; });
        } } },
    } });
    try {
        syncSetSpreadsheetId('project-a');
        let finished = false;
        const first = saveStoppingRuleToStorage(75).then(() => { finished = true; });
        await Promise.resolve();
        assert.equal(finished, false);
        complete();
        await first;
        syncSetSpreadsheetId('project-b');
        const second = saveStoppingRuleToStorage(120);
        complete();
        await second;
        assert.deepEqual(writes, [
            { 'mlStoppingRule_project-a': { confirmed: true, threshold: 75 } },
            { 'mlStoppingRule_project-b': { confirmed: true, threshold: 120 } },
        ]);
    } finally {
        syncSetSpreadsheetId(previousId);
        if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});

test('停止基準の保存失敗を呼び出し元へ返す', async () => {
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const failure = new Error('保存失敗');
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        storage: { local: { set: async () => { throw failure; } } },
    } });
    try {
        await assert.rejects(saveStoppingRuleToStorage(50), (error: unknown) => error === failure);
    } finally {
        if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});

test('停止基準の保存: 選んだ基準の種類（ruleType）も保存し、省略時は従来の形のまま', async () => {
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const previousId = state.spreadsheetId;
    const writes: unknown[] = [];
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        storage: { local: { set: async (data: unknown) => { writes.push(data); } } },
    } });
    try {
        syncSetSpreadsheetId('project-c');
        await saveStoppingRuleToStorage(500, 'cmh');
        await saveStoppingRuleToStorage(80, 'consecutive');
        await saveStoppingRuleToStorage(60);
        assert.deepEqual(writes, [
            { 'mlStoppingRule_project-c': { confirmed: true, threshold: 500, ruleType: 'cmh' } },
            { 'mlStoppingRule_project-c': { confirmed: true, threshold: 80, ruleType: 'consecutive' } },
            { 'mlStoppingRule_project-c': { confirmed: true, threshold: 60 } },
        ]);
    } finally {
        syncSetSpreadsheetId(previousId);
        if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});

test('停止基準の読み込み: プロジェクトごとのキーから読み、旧形式・新形式・未保存を区別する', async () => {
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const previousId = state.spreadsheetId;
    const store: Record<string, unknown> = {
        'mlStoppingRule_old': { confirmed: true, threshold: 500 },
        'mlStoppingRule_new': { confirmed: true, threshold: 500, ruleType: 'cmh' },
    };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        storage: { local: { get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])) } },
    } });
    try {
        syncSetSpreadsheetId('old');
        assert.deepEqual(await loadStoppingRuleFromStorage(), { confirmed: true, threshold: 500, ruleType: undefined });
        syncSetSpreadsheetId('new');
        assert.deepEqual(await loadStoppingRuleFromStorage(), { confirmed: true, threshold: 500, ruleType: 'cmh' });
        syncSetSpreadsheetId('none');
        assert.equal((await loadStoppingRuleFromStorage()).confirmed, false);
    } finally {
        syncSetSpreadsheetId(previousId);
        if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});
