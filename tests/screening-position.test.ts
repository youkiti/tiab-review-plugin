import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SCREENING_STATUS_FILTERS,
    isScreeningStatusFilter,
    parseScreeningPosition,
    resolveRestoredIndex,
} from '../src/lib/screening-position';
import { getLastScreeningPosition, setLastScreeningPosition } from '../src/lib/storage';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// screening-position.ts / storage.ts の TiAb 表示位置の記憶・復元（Issue #140）のユニットテスト。
// キー開封中に「最後に表示した文献」をプロジェクトごとにローカル保存し、次回読み込み時に
// ステータスフィルターごと復元する機能の純関数部分と、ストレージ関数の書き込み回避ロジックを検証する。

function createMemoryPlatform(): PlatformAdapter {
    // chrome.storage.local 相当のインメモリストア
    // （tests/offline-queue.test.ts の createMemoryPlatform と同じパターン）。
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

test('isScreeningStatusFilter: 許可リストの7値はすべて true', () => {
    for (const value of SCREENING_STATUS_FILTERS) {
        assert.equal(isScreeningStatusFilter(value), true);
    }
});

test('isScreeningStatusFilter: 許可リスト外・非文字列は false', () => {
    assert.equal(isScreeningStatusFilter('foo'), false);
    assert.equal(isScreeningStatusFilter(''), false);
    assert.equal(isScreeningStatusFilter(undefined), false);
    assert.equal(isScreeningStatusFilter(1), false);
});

test('parseScreeningPosition: 正常値を通す', () => {
    const raw = { filter: 'conflict', refId: 'ref-1', index: 3 };
    assert.deepEqual(parseScreeningPosition(raw), { filter: 'conflict', refId: 'ref-1', index: 3 });
});

test('parseScreeningPosition: filter が許可リスト外なら null', () => {
    assert.equal(parseScreeningPosition({ filter: 'unknown', refId: 'ref-1', index: 0 }), null);
});

test('parseScreeningPosition: refId が空文字・非文字列なら null', () => {
    assert.equal(parseScreeningPosition({ filter: 'pending', refId: '', index: 0 }), null);
    assert.equal(parseScreeningPosition({ filter: 'pending', refId: 123, index: 0 }), null);
});

test('parseScreeningPosition: index が負・小数・文字列なら null', () => {
    assert.equal(parseScreeningPosition({ filter: 'pending', refId: 'ref-1', index: -1 }), null);
    assert.equal(parseScreeningPosition({ filter: 'pending', refId: 'ref-1', index: 1.5 }), null);
    assert.equal(parseScreeningPosition({ filter: 'pending', refId: 'ref-1', index: '0' }), null);
});

test('parseScreeningPosition: null・非オブジェクトなら null', () => {
    assert.equal(parseScreeningPosition(null), null);
    assert.equal(parseScreeningPosition(undefined), null);
    assert.equal(parseScreeningPosition('pending'), null);
    assert.equal(parseScreeningPosition(42), null);
});

test('resolveRestoredIndex: ref_id が見つかればそのインデックス（先頭・末尾とも）', () => {
    const ids = ['a', 'b', 'c'];
    assert.equal(resolveRestoredIndex(ids, { filter: 'pending', refId: 'a', index: 999 }), 0);
    assert.equal(resolveRestoredIndex(ids, { filter: 'pending', refId: 'c', index: 999 }), 2);
});

test('resolveRestoredIndex: ref_id が見つからなければ index をクランプする', () => {
    const ids = ['a', 'b', 'c'];
    // index が長さ以上 → 末尾にクランプ
    assert.equal(resolveRestoredIndex(ids, { filter: 'pending', refId: 'missing', index: 10 }), 2);
    // 単体では負の index も 0 にクランプする（parseScreeningPosition では既に弾かれる値）
    assert.equal(resolveRestoredIndex(ids, { filter: 'pending', refId: 'missing', index: -5 }), 0);
});

test('resolveRestoredIndex: 空配列なら 0', () => {
    assert.equal(resolveRestoredIndex([], { filter: 'pending', refId: 'missing', index: 5 }), 0);
});

test('getLastScreeningPosition: 未保存・壊れた値は null', async () => {
    const platform = createMemoryPlatform();
    setPlatform(platform);

    assert.equal(await getLastScreeningPosition('sheet-1'), null);

    await platform.storageSet({ tiab_last_position: { 'sheet-1': { filter: 'not-a-filter', refId: 'r', index: 0 } } });
    assert.equal(await getLastScreeningPosition('sheet-1'), null);
});

test('setLastScreeningPosition: 同一内容の連続保存は storageSet が1回しか呼ばれない', async () => {
    const platform = createMemoryPlatform();
    setPlatform(platform);

    let calls = 0;
    const originalStorageSet = platform.storageSet.bind(platform);
    platform.storageSet = async (items: Record<string, unknown>) => {
        calls += 1;
        await originalStorageSet(items);
    };

    const position = { filter: 'pending' as const, refId: 'ref-1', index: 0 };
    await setLastScreeningPosition('sheet-1', position);
    await setLastScreeningPosition('sheet-1', position);
    await setLastScreeningPosition('sheet-1', { ...position });

    assert.equal(calls, 1);
    assert.deepEqual(await getLastScreeningPosition('sheet-1'), position);

    // 内容が変われば再び書き込まれる
    await setLastScreeningPosition('sheet-1', { ...position, index: 1 });
    assert.equal(calls, 2);
});

test('setLastScreeningPosition: await せずに連続で呼んでも書き込みが直列化され、重複が交錯しない', async () => {
    // _lastSavedKey は await 完了後にしか更新されないため、直列化していないと
    // 同一内容を await せずに連続で呼んだときに両方が重複チェックを通過し、
    // read-modify-write が交錯して storageSet が2回走ってしまう（Issue #140 レビュー対応）。
    const platform = createMemoryPlatform();
    setPlatform(platform);

    let calls = 0;
    const originalStorageSet = platform.storageSet.bind(platform);
    platform.storageSet = async (items: Record<string, unknown>) => {
        calls += 1;
        await originalStorageSet(items);
    };

    // 前のテストで残る _lastSavedKey（モジュール内変数）に依存しないよう、別プロジェクトIDを使う
    const position = { filter: 'pending' as const, refId: 'ref-1', index: 0 };
    const p1 = setLastScreeningPosition('sheet-2', position);
    const p2 = setLastScreeningPosition('sheet-2', { ...position });
    await Promise.all([p1, p2]);

    assert.equal(calls, 1);
    assert.deepEqual(await getLastScreeningPosition('sheet-2'), position);

    // 内容の異なる呼び出しを await せずに重ねても、最後の呼び出しの内容が残る
    const later = { ...position, index: 2 };
    const p3 = setLastScreeningPosition('sheet-2', { ...position, index: 1 });
    const p4 = setLastScreeningPosition('sheet-2', later);
    await Promise.all([p3, p4]);

    assert.equal(calls, 3);
    assert.deepEqual(await getLastScreeningPosition('sheet-2'), later);
});
