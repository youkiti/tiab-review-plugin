import type { Decision } from '../../lib/types';
import { platform } from '../../platform';

const LOCAL_QUEUE_LIMIT = 100;
const LOCAL_QUEUE_PREFIX = 'offlineQueue:';
const DB_NAME = 'tiab-review-plugin';
const DB_VERSION = 1;
const STORE_NAME = 'offlineQueue';

type QueueRecord = {
    queueKey: string;
    items: Decision[];
};

function buildQueueKey(spreadsheetId: string, userEmail: string): string {
    return `${spreadsheetId}::${userEmail}`;
}

function buildLocalKey(queueKey: string): string {
    return `${LOCAL_QUEUE_PREFIX}${queueKey}`;
}

function sortQueue(items: Decision[]): Decision[] {
    return items
        .slice()
        .sort((a, b) => a.decided_at.localeCompare(b.decided_at));
}

/**
 * キュー内の重複判定キー（ref_id/reviewer_id/screening_phase、phase省略時は 'tiab' 扱い）。
 * sheets-api.ts の decisionRowKey() と同じ「同一判定キー」の概念のため、ref_id/reviewer_id の
 * trim 正規化も揃える。
 */
function decisionQueueKey(decision: Decision): string {
    return `${(decision.ref_id || '').trim()}::${(decision.reviewer_id || '').trim()}::${decision.screening_phase ?? 'tiab'}`;
}

/**
 * オフラインキューへ判定を積む。
 * decision_id は追記専用化により毎回新規発番されるため、代わりに
 * (ref_id, reviewer_id, screening_phase) をキーに既存要素を探して置換する。
 * これによりオフライン中の途中変更は履歴に残さず、最新の1件だけを送信する。
 */
function upsertDecision(items: Decision[], decision: Decision): Decision[] {
    const next = items.slice();
    const key = decisionQueueKey(decision);
    const index = next.findIndex(item => decisionQueueKey(item) === key);
    if (index >= 0) {
        next[index] = decision;
    } else {
        next.push(decision);
    }
    return sortQueue(next);
}

function openQueueDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'queueKey' });
            }
        };
        request.onsuccess = () => resolve(request.result);
    });
}

async function readQueueFromDb(queueKey: string): Promise<Decision[]> {
    const db = await openQueueDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(queueKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const record = request.result as QueueRecord | undefined;
            resolve(record?.items ?? []);
        };
        tx.oncomplete = () => db.close();
    });
}

async function writeQueueToDb(queueKey: string, items: Decision[]): Promise<void> {
    const db = await openQueueDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put({ queueKey, items } satisfies QueueRecord);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
        tx.oncomplete = () => db.close();
    });
}

async function deleteQueueFromDb(queueKey: string): Promise<void> {
    const db = await openQueueDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(queueKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
        tx.oncomplete = () => db.close();
    });
}

async function loadQueue(queueKey: string): Promise<Decision[]> {
    const localKey = buildLocalKey(queueKey);
    const localResult = await platform().storageGet([localKey]);
    const localItems = localResult[localKey] as Decision[] | undefined;
    if (localItems && localItems.length > 0) {
        return sortQueue(localItems);
    }
    try {
        const dbItems = await readQueueFromDb(queueKey);
        return sortQueue(dbItems);
    } catch {
        return [];
    }
}

async function saveQueue(queueKey: string, items: Decision[]): Promise<void> {
    const localKey = buildLocalKey(queueKey);
    if (items.length <= LOCAL_QUEUE_LIMIT) {
        await platform().storageSet({ [localKey]: items });
        await deleteQueueFromDb(queueKey);
        return;
    }

    await platform().storageRemove(localKey);
    await writeQueueToDb(queueKey, items);
}

export async function enqueueDecision(
    spreadsheetId: string,
    userEmail: string,
    decision: Decision
): Promise<void> {
    if (!spreadsheetId || !userEmail) return;
    const queueKey = buildQueueKey(spreadsheetId, userEmail);
    const items = await loadQueue(queueKey);
    const next = upsertDecision(items, decision);
    await saveQueue(queueKey, next);
}

export async function flushDecisionQueue(
    spreadsheetId: string,
    userEmail: string,
    saveDecision: (decision: Decision) => Promise<void>
): Promise<{ flushedCount: number; remainingCount: number }> {
    if (!spreadsheetId || !userEmail) {
        return { flushedCount: 0, remainingCount: 0 };
    }
    const queueKey = buildQueueKey(spreadsheetId, userEmail);
    const items = await loadQueue(queueKey);
    if (items.length === 0) {
        return { flushedCount: 0, remainingCount: 0 };
    }

    let flushedCount = 0;
    let remaining: Decision[] = [];

    for (let i = 0; i < items.length; i += 1) {
        const decision = items[i];
        try {
            await saveDecision(decision);
            flushedCount += 1;
        } catch {
            remaining = items.slice(i);
            break;
        }
    }

    await saveQueue(queueKey, remaining);
    return { flushedCount, remainingCount: remaining.length };
}
