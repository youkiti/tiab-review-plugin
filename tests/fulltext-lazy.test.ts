import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeStore } from '../src/sidepanel/store';
import { changeView, changeTab, setSpreadsheetId } from '../src/sidepanel/store/compat';
import {
    loadFulltextFeature, setupFulltextTabListeners, activateFulltextTab, getFulltextEnabledJudges,
} from '../src/sidepanel/features/fulltext/lazy';

test('フルテキスト入口: 読み込みの合流・離脱時の破棄・失敗後の再試行', async context => {
    const attributes = new Map<string, string>();
    const status = { textContent: '', classList: { toggle() {} } };
    const toast = { textContent: '', classList: { add() {}, remove() {} } };
    const section = {
        querySelector: () => status,
        setAttribute: (key: string, value: string) => attributes.set(key, value),
        prepend: () => {},
    };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            getElementById: (id: string) => id === 'fulltext-section' ? section : toast,
            createElement: () => ({ classList: { toggle() {} } }),
        },
    });
    context.mock.timers.enable({ apis: ['setTimeout'] });

    // 本体の代わりに配線境界を差し替え、通信やブラウザAPI無しで入口の競合を再現する。
    const modulePath = require.resolve('../src/sidepanel/features/fulltext/tab');
    const originalModule = require.cache[modulePath];
    let setupCalls = 0;
    let shouldFail = true;
    const initializeCallsWithIsCurrent: Array<() => boolean> = [];
    let enabledJudges: Set<string> | null = null;
    const feature = {
        setupFulltextTabListeners: () => {
            if (shouldFail) {
                const error = new Error('Loading chunk fulltext-feature failed');
                error.name = 'ChunkLoadError';
                throw error;
            }
            setupCalls++;
        },
        initializeFulltextSection: (isCurrent: () => boolean) => {
            initializeCallsWithIsCurrent.push(isCurrent);
        },
        getEnabledJudgesSnapshot: () => enabledJudges,
    };
    require.cache[modulePath] = { exports: feature } as NodeModule;
    try {
        initializeStore();
        changeView('screening');
        setSpreadsheetId('project-a');
        setupFulltextTabListeners();
        // 本体未ロード時は常に null（未訪問＝全員集計、manuscript.ts の既定と一致）。
        assert.equal(getFulltextEnabledJudges(), null);
        assert.equal(setupCalls, 0);
        assert.equal(initializeCallsWithIsCurrent.length, 0);

        await context.test('連打は合流し、読込失敗は表示を解除して次の選択で再試行する', async () => {
            const first = activateFulltextTab();
            assert.equal(activateFulltextTab(), first);
            assert.equal(attributes.get('aria-busy'), 'true');
            await first;
            assert.equal(attributes.get('aria-busy'), 'false');
            assert.equal(toast.textContent, 'fulltext_featureLoadFailed');
            assert.equal(initializeCallsWithIsCurrent.length, 0);

            shouldFail = false;
            await activateFulltextTab();
            assert.equal(setupCalls, 1);
            assert.equal(initializeCallsWithIsCurrent.length, 1);
            assert.equal(initializeCallsWithIsCurrent[0](), true);
            // 一度ロードした本体は再利用される（読込は1回だけ）。
            assert.equal(loadFulltextFeature(), loadFulltextFeature());
        });

        await context.test('本体ロード後は結果ビューの判定者選択の現在値を返す', () => {
            enabledJudges = new Set(['a@example.com']);
            assert.deepEqual(getFulltextEnabledJudges(), new Set(['a@example.com']));
        });

        await context.test('タブ離脱・プロジェクト往復後は本体初期化を呼ばない', async () => {
            const beforeCalls = initializeCallsWithIsCurrent.length;
            const tabLoad = activateFulltextTab();
            changeTab('screening');
            await tabLoad;
            assert.equal(initializeCallsWithIsCurrent.length, beforeCalls);

            const projectLoad = activateFulltextTab();
            setSpreadsheetId('project-b');
            setSpreadsheetId('project-a');
            await projectLoad;
            // プロジェクトが往復して同じ値に戻っても、離脱の事実自体は取り消されない。
            assert.equal(initializeCallsWithIsCurrent.length, beforeCalls);
        });

        await context.test('通常の初期化失敗（Workerエラー等）も次の選択で再試行できる', async () => {
            const originalInit = feature.initializeFulltextSection;
            feature.initializeFulltextSection = () => { throw new Error('初期化エラー'); };
            await activateFulltextTab();
            assert.equal(toast.textContent, 'fulltext_activationFailed');
            feature.initializeFulltextSection = originalInit;
            const beforeSetup = setupCalls;
            await activateFulltextTab();
            // 本体は既にロード済みなのでチャンク読込・setupは再実行されない。
            assert.equal(setupCalls, beforeSetup);
        });
    } finally {
        if (originalModule) require.cache[modulePath] = originalModule;
        else delete require.cache[modulePath];
        if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});
