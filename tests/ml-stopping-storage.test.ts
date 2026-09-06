import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/sidepanel/state';
import { initializeStore } from '../src/sidepanel/store';
import { setSpreadsheetId as syncSetSpreadsheetId } from '../src/sidepanel/store/compat';
import { saveStoppingRuleToStorage } from '../src/sidepanel/features/ml/stopping-storage';

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
