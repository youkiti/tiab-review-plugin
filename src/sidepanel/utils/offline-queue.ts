import type { Decision } from '../../lib/types';
import { platform } from '../../platform';
import { createAsyncCoalescer } from '../../lib/async-coalesce';

const LOCAL_QUEUE_LIMIT = 100;
const LOCAL_QUEUE_PREFIX = 'offlineQueue:';
const DB_NAME = 'tiab-review-plugin';
const DB_VERSION = 1;
const STORE_NAME = 'offlineQueue';

type QueueRecord = {
    queueKey: string;
    items: Decision[];
};

// lastError は失敗があった場合のみキーごと付与する（付与しない場合はプロパティ自体を持たない）。
// node:assert/strict の deepEqual は「値が undefined のプロパティ」と「プロパティ自体が無い」を
// 区別するため、成功のみの flush 結果を deepEqual({ flushedCount, remainingCount }) と比較する
// 既存テストを壊さないよう、失敗が無いときは lastError キー自体を付けない
// （PR #138 レビュー指摘: 合流した flush の失敗種別が呼び出し元に伝わらない問題への対応）。
export type FlushResult = { flushedCount: number; remainingCount: number; lastError?: unknown };

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

/**
 * Node（テスト環境）や IndexedDB を無効化したブラウザでは `indexedDB` が未定義になる。
 * その場合は IndexedDB 側の read/write/delete を丸ごとスキップし、
 * chrome.storage.local 相当のローカルストレージだけで完結させる。
 */
function hasIndexedDb(): boolean {
    return typeof indexedDB !== 'undefined';
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
    if (!hasIndexedDb()) return [];
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
    if (!hasIndexedDb()) return;
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
    if (!hasIndexedDb()) return;
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
    // IndexedDB が使えない環境（Node のテスト環境、IndexedDBを無効化したブラウザ等）では
    // 100件を超えてもローカルストレージ側にそのまま保存する。chrome.storage.local の5MB上限を
    // 超えて書き込みエラーになる可能性はあるが、IndexedDBへ逃がせないからといって黙って
    // 保存自体を諦める（＝キューが消える）よりはましという判断（消失回避を優先する）。
    if (items.length <= LOCAL_QUEUE_LIMIT || !hasIndexedDb()) {
        await platform().storageSet({ [localKey]: items });
        await deleteQueueFromDb(queueKey);
        return;
    }

    await platform().storageRemove(localKey);
    await writeQueueToDb(queueKey, items);
}

// queueKey ごとの書き込み系操作（load→加工→save のread-modify-write）を1本の Promise チェーンで
// 直列化する。enqueueDecision のRMWと、flush末尾の再読込→saveが交差すると、後勝ちの書き戻しで
// 片方の変更が消える（2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応で判明した
// データ消失経路の一つ）。sheets-api.ts の saveDecisionChain と同じ「チェーンに積んで順番に流す」
// 流儀を queueKey 単位に一般化したもの。
const queueWriteChains = new Map<string, Promise<void>>();

function chainQueueWrite<T>(queueKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = queueWriteChains.get(queueKey) ?? Promise.resolve();
    const run = previous.then(fn);
    // 次に積まれる操作は、この操作の成否に関わらず実行できるようにする
    // （前段の失敗で後続の書き込みまで止めない）。
    queueWriteChains.set(queueKey, run.then(() => undefined, () => undefined));
    return run;
}

export async function enqueueDecision(
    spreadsheetId: string,
    userEmail: string,
    decision: Decision
): Promise<void> {
    if (!spreadsheetId || !userEmail) return;
    const queueKey = buildQueueKey(spreadsheetId, userEmail);
    await chainQueueWrite(queueKey, async () => {
        const items = await loadQueue(queueKey);
        const next = upsertDecision(items, decision);
        await saveQueue(queueKey, next);
    });
}

/** 未送信キューの内容を decided_at 昇順のコピーで返す（呼び出し元が配列を書き換えても影響しない） */
export async function getQueuedDecisions(spreadsheetId: string, userEmail: string): Promise<Decision[]> {
    if (!spreadsheetId || !userEmail) return [];
    const queueKey = buildQueueKey(spreadsheetId, userEmail);
    return loadQueue(queueKey);
}

export async function countQueuedDecisions(spreadsheetId: string, userEmail: string): Promise<number> {
    const items = await getQueuedDecisions(spreadsheetId, userEmail);
    return items.length;
}

// queueKey ごとの「直近に渡された saveDecision 実装」を保持するスロット。
// flushDecisionQueue が呼ばれるたびに最新のものへ上書きし、runFlush は各項目の送信直前に
// このスロットから取り出して呼ぶ。コールセーサー（下記 flushCoalescers）を永続させたまま
// 実装だけ差し替えるための仕組み。
const flushSaveDecisionSlots = new Map<string, (decision: Decision) => Promise<void>>();

/**
 * flush の実処理。同一 queueKey に対して同時に1本しか走らせないよう、呼び出し側
 * （flushDecisionQueue）で createAsyncCoalescer により合流させた上で呼ぶ。
 */
async function runFlush(queueKey: string): Promise<FlushResult> {
    const items = await loadQueue(queueKey);
    if (items.length === 0) {
        return { flushedCount: 0, remainingCount: 0 };
    }

    const sentIds = new Set<string>();
    let flushedCount = 0;
    let hasError = false;
    let lastError: unknown;

    for (const decision of items) {
        try {
            // 各項目の送信直前にスロットから取り出す。呼び出し中に更新されても
            // （合流していない）次の項目からは最新の実装が使われる。
            const saveDecision = flushSaveDecisionSlots.get(queueKey);
            if (!saveDecision) break;
            await saveDecision(decision);
            sentIds.add(decision.decision_id);
            flushedCount += 1;
        } catch (error) {
            // decided_at 昇順で送信し、失敗した時点で打ち切る（残りは次回のflushへ持ち越す）。
            // PR #138 レビュー指摘（合流した flush の失敗種別が呼び出し元に伝わらない問題）:
            // 失敗種別はコールバックのクロージャではなく戻り値へ載せる。flushDecisionQueue は
            // 呼び出しごとに saveDecision をスロットへ上書きするため、対話的flush中に
            // バックグラウンドflushが合流すると「どのコールバックが例外を投げたか」で
            // 失敗の記録先が変わってしまう。合流した呼び出しは全員この同じ結果オブジェクトを
            // 受け取るので、戻り値に載せておけば誰が観測しても届く。
            lastError = error;
            hasError = true;
            break;
        }
    }

    // スナップショット（items）由来の「残り」をそのまま書き戻すのではなく、キューを再読込して
    // 送信に成功した decision_id だけを取り除いて保存する。こうすることで、flush の送信中に
    // enqueueDecision で新たに積まれた項目が書き戻しで消えることを防ぐ
    // （2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応）。
    const remaining = await chainQueueWrite(queueKey, async () => {
        const current = await loadQueue(queueKey);
        if (sentIds.size === 0) return current;
        const next = current.filter(item => !sentIds.has(item.decision_id));
        await saveQueue(queueKey, next);
        return next;
    });

    return hasError
        ? { flushedCount, remainingCount: remaining.length, lastError }
        : { flushedCount, remainingCount: remaining.length };
}

// queueKey ごとの flush 合流用コールセーサー。進行中の flush があれば新規に loadQueue からやり直さず
// 同じ Promise に合流させる（saveDecision の重複防止キャッシュは60秒TTLのため、並走 flush が
// あるとそれを超える送信時間で同一判定が複数回追記されてしまっていた）。
//
// このコールセーサーは完了後も Map から削除せず、queueKey ごとに永続させる。
// createAsyncCoalescer 内部の inFlight は factory 完了直後（呼び出し元の continuation が
// 走るより先）にクリアされるため、「完了時に呼び出し元側で Map のエントリを削除する」実装だと、
// そのクリアと削除の間の一瞬の隙間で別の呼び出しが「進行中ではない」と誤認して新しい
// コールセーサーを作ってしまい、直後に元の呼び出しの後始末がそれを消す形で直列化の保証が
// 崩れる（2本の flush が並走しうる）。エントリを消さず使い回せば、この窓は生じない。
const flushCoalescers = new Map<string, () => Promise<FlushResult>>();

export async function flushDecisionQueue(
    spreadsheetId: string,
    userEmail: string,
    saveDecision: (decision: Decision) => Promise<void>
): Promise<FlushResult> {
    if (!spreadsheetId || !userEmail) {
        return { flushedCount: 0, remainingCount: 0 };
    }
    const queueKey = buildQueueKey(spreadsheetId, userEmail);

    // 直近の呼び出しの実装を常に最新としてスロットへ反映する。進行中の flush があっても、
    // まだ送っていない項目から新しい実装が使われる。
    flushSaveDecisionSlots.set(queueKey, saveDecision);

    let coalesced = flushCoalescers.get(queueKey);
    if (!coalesced) {
        coalesced = createAsyncCoalescer(() => runFlush(queueKey));
        flushCoalescers.set(queueKey, coalesced);
    }
    return coalesced();
}
