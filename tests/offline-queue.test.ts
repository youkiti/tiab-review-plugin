import test from 'node:test';
import assert from 'node:assert/strict';
import {
    enqueueDecision,
    flushDecisionQueue,
    getQueuedDecisions,
    countQueuedDecisions,
} from '../src/sidepanel/utils/offline-queue';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision } from '../src/lib/types';

// offline-queue.ts のユニットテスト。
// 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応で判明した2つの不具合
// （並走flushによる重複追記、flush中のenqueueがスナップショット書き戻しで消える）の回帰防止。

function createMemoryPlatform(): PlatformAdapter {
    // chrome.storage.local 相当のインメモリストア。
    // indexedDB は Node のテスト環境には存在しないため、キューは常にこちら経由になる
    // （saveQueue の「IndexedDBが無ければローカルストレージにそのまま保存する」分岐の検証も兼ねる）。
    const store = new Map<string, unknown>();
    return {
        getAuthToken: async () => 'test-token',
        forceReauth: async () => 'test-token',
        clearAuth: async () => {},
        storageGet: async (keys: string[]) => {
            const result: Record<string, unknown> = {};
            keys.forEach((key) => {
                if (store.has(key)) result[key] = store.get(key);
            });
            return result;
        },
        storageSet: async (items: Record<string, unknown>) => {
            Object.entries(items).forEach(([key, value]) => store.set(key, value));
        },
        storageRemove: async (keys: string | string[]) => {
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => store.delete(key));
        },
        storageClear: async () => { store.clear(); },
        onMessage: () => {},
        emitMessage: () => {},
        getMessage: (key: string) => key,
        openExternal: () => {},
        getVersionString: () => 'test',
        capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
    };
}

function makeDecision(spreadsheetId: string, userEmail: string, n: number): Decision {
    return {
        decision_id: `d-${spreadsheetId}-${n}`,
        ref_id: `ref-${spreadsheetId}-${n}`,
        reviewer_id: userEmail,
        decision: 'include',
        decided_at: `2026-09-0${n}T00:00:00Z`,
        screening_phase: 'tiab',
    };
}

test('並走 flush は各判定をちょうど1回だけ送信する', async () => {
    setPlatform(createMemoryPlatform());
    const spreadsheetId = 'sheet-concurrent';
    const userEmail = 'alice@example.com';
    const decisions = [1, 2, 3].map((n) => makeDecision(spreadsheetId, userEmail, n));
    for (const decision of decisions) {
        await enqueueDecision(spreadsheetId, userEmail, decision);
    }

    const calls: string[] = [];
    const saveDecision = async (decision: Decision) => {
        calls.push(decision.decision_id);
        await new Promise((resolve) => setTimeout(resolve, 5));
    };

    // await せずに2回同時に呼ぶ（同一タスク内で両方の同期部分が走り、2回目は1回目に合流するはず）
    const [result1, result2] = await Promise.all([
        flushDecisionQueue(spreadsheetId, userEmail, saveDecision),
        flushDecisionQueue(spreadsheetId, userEmail, saveDecision),
    ]);

    assert.equal(calls.length, 3, '合流していれば送信は合計3回で済むはず');
    const sentCounts = new Map<string, number>();
    calls.forEach((id) => sentCounts.set(id, (sentCounts.get(id) ?? 0) + 1));
    decisions.forEach((decision) => {
        assert.equal(sentCounts.get(decision.decision_id), 1, `${decision.decision_id} はちょうど1回送信されること`);
    });
    assert.deepEqual(result1, { flushedCount: 3, remainingCount: 0 });
    assert.deepEqual(result2, { flushedCount: 3, remainingCount: 0 });
    assert.equal(await countQueuedDecisions(spreadsheetId, userEmail), 0);
});

test('flush 中に enqueue された項目は書き戻しで消えない', async () => {
    setPlatform(createMemoryPlatform());
    const spreadsheetId = 'sheet-mid-enqueue';
    const userEmail = 'alice@example.com';
    const decisions = [1, 2, 3].map((n) => makeDecision(spreadsheetId, userEmail, n));
    for (const decision of decisions) {
        await enqueueDecision(spreadsheetId, userEmail, decision);
    }
    const fourth = makeDecision(spreadsheetId, userEmail, 4);

    let firstCallSeen = false;
    const saveDecision = async (decision: Decision) => {
        if (!firstCallSeen) {
            firstCallSeen = true;
            // 1回目の送信中（flushの完了前）に4件目を積む
            await enqueueDecision(spreadsheetId, userEmail, fourth);
        }
        void decision;
    };

    const result = await flushDecisionQueue(spreadsheetId, userEmail, saveDecision);
    assert.equal(result.flushedCount, 3);

    const remaining = await getQueuedDecisions(spreadsheetId, userEmail);
    assert.equal(remaining.length, 1, '送信済み3件は消え、flush中に積まれた4件目だけが残ること');
    assert.equal(remaining[0].decision_id, fourth.decision_id);
});

test('途中で失敗した場合はそこで打ち切り、残りは次回へ持ち越される', async () => {
    setPlatform(createMemoryPlatform());
    const spreadsheetId = 'sheet-partial-failure';
    const userEmail = 'alice@example.com';
    const decisions = [1, 2, 3].map((n) => makeDecision(spreadsheetId, userEmail, n));
    for (const decision of decisions) {
        await enqueueDecision(spreadsheetId, userEmail, decision);
    }

    let callCount = 0;
    const saveDecision = async () => {
        callCount += 1;
        if (callCount === 2) throw new Error('save failed');
    };

    const result = await flushDecisionQueue(spreadsheetId, userEmail, saveDecision);
    assert.deepEqual(result, { flushedCount: 1, remainingCount: 2 });

    const remaining = await getQueuedDecisions(spreadsheetId, userEmail);
    assert.equal(remaining.length, 2);
    assert.equal(await countQueuedDecisions(spreadsheetId, userEmail), 2);
});

test('countQueuedDecisions はキューの件数を返す', async () => {
    setPlatform(createMemoryPlatform());
    const spreadsheetId = 'sheet-count';
    const userEmail = 'alice@example.com';

    assert.equal(await countQueuedDecisions(spreadsheetId, userEmail), 0);

    await enqueueDecision(spreadsheetId, userEmail, makeDecision(spreadsheetId, userEmail, 1));
    await enqueueDecision(spreadsheetId, userEmail, makeDecision(spreadsheetId, userEmail, 2));

    assert.equal(await countQueuedDecisions(spreadsheetId, userEmail), 2);
});

test('flush は decided_at 昇順で送信する', async () => {
    setPlatform(createMemoryPlatform());
    const spreadsheetId = 'sheet-order';
    const userEmail = 'alice@example.com';
    const d1 = makeDecision(spreadsheetId, userEmail, 1);
    const d2 = makeDecision(spreadsheetId, userEmail, 2);
    const d3 = makeDecision(spreadsheetId, userEmail, 3);
    // わざと逆順でキューへ積む
    await enqueueDecision(spreadsheetId, userEmail, d3);
    await enqueueDecision(spreadsheetId, userEmail, d1);
    await enqueueDecision(spreadsheetId, userEmail, d2);

    const order: string[] = [];
    await flushDecisionQueue(spreadsheetId, userEmail, async (decision) => {
        order.push(decision.decision_id);
    });

    assert.deepEqual(order, [d1.decision_id, d2.decision_id, d3.decision_id]);
});
