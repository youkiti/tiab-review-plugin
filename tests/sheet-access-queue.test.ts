import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision, ReferenceWithStatus } from '../src/lib/types';
import { initializeStore } from '../src/sidepanel/store';
import { setSpreadsheetId, setUserEmail, setSheetEditAccess, setReferences } from '../src/sidepanel/store/compat';
import { state } from '../src/sidepanel/state';
import { initUnsentQueue, refreshUnsentBadge, saveDecisionOrQueue, flushUnsentQueue } from '../src/sidepanel/features/unsent-queue';
import { handleDecision } from '../src/sidepanel/features/screening/actions';

test('権限不足の帯・送信成功・プロジェクト切替・読み取り専用ガードを偽物の保存先で検証する', async () => {
    const originalFetch = globalThis.fetch;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const storage: Record<string, unknown> = {};
    const elements = new Map<string, ReturnType<typeof makeElement>>();
    function makeElement() {
        const classes = new Set(['hidden']);
        return {
            textContent: '', title: '', addEventListener: () => {},
            classList: {
                add: (name: string) => classes.add(name),
                remove: (name: string) => classes.delete(name),
                contains: (name: string) => classes.has(name),
                toggle: (name: string, force: boolean) => force ? classes.add(name) : classes.delete(name),
            },
        };
    }
    const element = (id: string) => {
        if (!elements.has(id)) {
            elements.set(id, makeElement());
        }
        return elements.get(id)!;
    };
    const adapter: PlatformAdapter = {
        getAuthToken: async () => 'test-token', forceReauth: async () => 'test-token',
        clearAuth: async () => {}, storageGet: async () => structuredClone(storage),
        storageSet: async data => { Object.assign(storage, structuredClone(data)); },
        storageRemove: async () => {}, storageClear: async () => {}, onMessage: () => {},
        emitMessage: () => {}, getMessage: (key, args) => [key, ...(args ?? [])].join(':'), openExternal: () => {},
        getVersionString: () => 'test',
        capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
    };
    let status = 403;
    let requests = 0;
    let redraws = 0;
    const decision = (id: string): Decision => ({
        decision_id: id, ref_id: id, reviewer_id: 'self', decision: 'include',
        client_version: 'test-human', decided_at: '2026-01-01T00:00:00Z',
    });
    try {
        mock.method(console, 'error', () => {});
        mock.method(console, 'warn', () => {});
        mock.timers.enable({ apis: ['setTimeout'] });
        Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: element } });
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
        globalThis.fetch = async () => {
            requests += 1;
            return Response.json(status === 200 ? { updates: { updatedRange: 'Decisions!A2:L2' } } : {
                error: { message: 'アクセス拒否' },
            }, { status });
        };
        setPlatform(adapter);
        initializeStore();
        setSpreadsheetId('sheet');
        setUserEmail('self');
        initUnsentQueue(() => { redraws += 1; });
        await refreshUnsentBadge();
        const banner = element('sheet-access-banner');
        assert.equal(banner.classList.contains('hidden'), true);

        await saveDecisionOrQueue(decision('first'), { notifyOnFailure: false });
        assert.equal(state.unsentCount, 1);
        assert.equal(banner.textContent, 'screening_sheetDeniedUnsent:1');
        assert.equal(banner.classList.contains('hidden'), false);
        // 権限不足の後のオフラインの失敗で、権限不足の帯を消さない（PR #289 の codex レビュー指摘）
        (globalThis.navigator as { onLine: boolean }).onLine = false;
        await saveDecisionOrQueue(decision('second'), { notifyOnFailure: false });
        (globalThis.navigator as { onLine: boolean }).onLine = true;
        assert.equal(state.unsentCount, 2);
        assert.equal(banner.textContent, 'screening_sheetDeniedUnsent:2');
        await refreshUnsentBadge();
        assert.equal(banner.classList.contains('hidden'), false);

        status = 200;
        const flushed = await flushUnsentQueue({ interactive: false });
        assert.equal(flushed.flushedCount, 2);
        assert.equal(state.unsentCount, 0);
        assert.equal(banner.classList.contains('hidden'), true);
        assert.equal(redraws, 3);

        status = 403;
        await saveDecisionOrQueue(decision('third'), { notifyOnFailure: false });
        setUserEmail('other');
        await refreshUnsentBadge();
        assert.equal(state.unsentCount, 0);
        assert.equal(banner.classList.contains('hidden'), true);
        setUserEmail('self');
        await refreshUnsentBadge();
        assert.equal(state.unsentCount, 1);
        assert.equal(banner.classList.contains('hidden'), true);

        setSheetEditAccess('readonly');
        const reference: ReferenceWithStatus = { ref_id: 'untouched', title: '未判定の文献', status: 'pending' };
        setReferences([reference]);
        await refreshUnsentBadge();
        assert.equal(banner.textContent, 'screening_sheetReadonly:self');
        const before = requests;
        await handleDecision('exclude');
        assert.equal(element('toast').textContent, 'screening_sheetReadonly:self');
        assert.equal(requests, before);
        assert.equal(state.unsentCount, 1);
        assert.equal(state.references[0], reference);
        assert.equal(state.references[0].myDecision, undefined);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [name, descriptor] of [['document', originalDocument], ['navigator', originalNavigator]] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
        mock.timers.reset();
        mock.restoreAll();
    }
});
