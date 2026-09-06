import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeStore } from '../src/sidepanel/store';
import { changeView, setSpreadsheetId } from '../src/sidepanel/store/compat';
import {
    loadLlmFeature, setupLlmEventListeners, setHandleBack,
    setLoadDataAndShowScreening, switchToTab,
} from '../src/sidepanel/features/llm/lazy';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test('LLM入口: 読み込みの合流・再試行・離脱破棄と一度だけの配線', async context => {
    const attributes = new Map<string, string>();
    const status = { textContent: '', classList: { toggle() {} } };
    const toast = { textContent: '', classList: { add() {}, remove() {} } };
    const section = {
        querySelector: () => status,
        setAttribute: (key: string, value: string) => attributes.set(key, value),
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { getElementById: (id: string) => id === 'llm-section' ? section : toast },
    });
    context.mock.timers.enable({ apis: ['setTimeout'] });

    // 本体の代わりに配線境界を差し替え、通信やブラウザAPI無しで入口の競合を再現する。
    const modulePath = require.resolve('../src/sidepanel/features/llm/index');
    const originalModule = require.cache[modulePath];
    let setupCalls = 0;
    let shouldFail = true;
    let initializeCalls = 0;
    let initialize: (isCurrent: () => boolean) => Promise<void> = async () => {};
    let injectedBack: (() => void) | undefined;
    let injectedReload: (() => Promise<void>) | undefined;
    const feature = {
        setupLlmEventListeners: () => {
            if (shouldFail) {
                const error = new Error('Loading chunk llm-feature failed');
                error.name = 'ChunkLoadError';
                throw error;
            }
            setupCalls++;
        },
        setHandleBack: (fn: () => void) => { injectedBack = fn; },
        setLoadDataAndShowScreening: (fn: () => Promise<void>) => { injectedReload = fn; },
        initializeLlmSection: async (isCurrent: () => boolean) => {
            initializeCalls++;
            await initialize(isCurrent);
        },
    };
    require.cache[modulePath] = { exports: feature } as NodeModule;
    try {
        initializeStore();
        changeView('screening');
        setSpreadsheetId('project-a');
        const back = () => {};
        const reload = async () => {};
        setHandleBack(back);
        setLoadDataAndShowScreening(reload);
        setupLlmEventListeners();
        await switchToTab('fulltext');
        assert.equal(setupCalls, 0);
        assert.equal(initializeCalls, 0);

        await context.test('読込失敗は表示を解除し、次のタブ選択で再試行する', async () => {
            const first = switchToTab('llm');
            assert.equal(switchToTab('llm'), first);
            assert.equal(attributes.get('aria-busy'), 'true');
            await first;
            assert.equal(attributes.get('aria-busy'), 'false');
            assert.equal(toast.textContent, 'llm_featureLoadFailed');
            assert.equal(initializeCalls, 0);
            shouldFail = false;
            await switchToTab('llm');
            assert.equal(setupCalls, 1);
            assert.equal(initializeCalls, 1);
            assert.equal(injectedBack, back);
            assert.equal(injectedReload, reload);
            assert.equal(loadLlmFeature(), loadLlmFeature());
        });

        await context.test('タブ離脱・プロジェクト往復後は本体初期化を呼ばない', async () => {
            const tabLoad = switchToTab('llm');
            await switchToTab('screening');
            await tabLoad;
            const projectLoad = switchToTab('llm');
            setSpreadsheetId('project-b');
            setSpreadsheetId('project-a');
            await projectLoad;
            assert.equal(initializeCalls, 1);
        });

        await context.test('初期化中の離脱を本体へ伝え、古い完了で新しい読込表示を消さない', async () => {
            const oldReady = deferred();
            const oldDone = deferred();
            const newReady = deferred();
            const newDone = deferred();
            let applied = 0;
            initialize = async isCurrent => {
                oldReady.resolve();
                await oldDone.promise;
                if (isCurrent()) applied++;
            };
            const oldLoad = switchToTab('llm');
            await oldReady.promise;
            setSpreadsheetId('project-b');
            initialize = async isCurrent => {
                newReady.resolve();
                await newDone.promise;
                if (isCurrent()) applied++;
            };
            const newLoad = switchToTab('llm');
            await newReady.promise;
            oldDone.resolve();
            await oldLoad;
            assert.equal(applied, 0);
            assert.equal(attributes.get('aria-busy'), 'true');
            assert.equal(switchToTab('llm'), newLoad);
            newDone.resolve();
            await newLoad;
            assert.equal(applied, 1);
            assert.equal(attributes.get('aria-busy'), 'false');
            assert.equal(setupCalls, 1);
        });

        await context.test('ロード済みの依存注入を更新し、通常の初期化失敗も再試行する', async () => {
            const nextBack = () => {};
            setHandleBack(nextBack);
            assert.equal(injectedBack, nextBack);
            initialize = async () => { throw new Error('初期化エラー'); };
            await switchToTab('llm');
            assert.equal(toast.textContent, 'llm_activationFailed');
            initialize = async () => {};
            await switchToTab('llm');
            assert.equal(setupCalls, 1);
        });
    } finally {
        if (originalModule) require.cache[modulePath] = originalModule;
        else delete require.cache[modulePath];
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});
