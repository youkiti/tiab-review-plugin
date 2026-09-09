import test from 'node:test';
import assert from 'node:assert/strict';
import { runRegrantPickerChunks } from '../src/lib/drive-regrant-picker';
import type { RegrantPickerOutcome } from '../src/lib/drive-regrant-picker';
import { REGRANT_PICKER_CHUNK_SIZE } from '../src/lib/picker-url';

// このファイルは runRegrantPickerChunks の「ループ制御」だけを検証する（Issue #203）。
// chunkRegrantFileIdsForUrl 自体の分割ロジックは tests/picker-url.test.ts でカバー済みのため、
// ここでは openPicker を差し替えて chrome.identity に一切触れずに検証する。
//
// fileIds が非空のときは runRegrantPickerChunks 内部でチャンク分割のためにURLを組み立てる
// （buildRegrantPickerUrl）ため、redirectUri が必要になる。省略時は chrome.identity.getRedirectURL
// を呼んでしまい Node 環境（chrome グローバル無し）で落ちるため、テストでは明示的に注入する
// （chrome.identity に一切触れないことの確認でもある）。
const TEST_REDIRECT_URI = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker';

// fileId を短い文字列（`id0`〜）にしてURL長を小さく保つことで、REGRANT_PICKER_CHUNK_SIZE
// （件数上限）がチャンク境界の決め手になる状況を作る。REGRANT_PICKER_CHUNK_SIZE * 2 + 1 件の
// fileIds なら、定数の実値が変わっても壊れないまま必ず3チャンク（[SIZE, SIZE, 1]）になる。
const TOTAL_FILE_IDS = REGRANT_PICKER_CHUNK_SIZE * 2 + 1;
const ALL_FILE_IDS = Array.from({ length: TOTAL_FILE_IDS }, (_, i) => `id${i}`);

type RecordedCall = { folderId: string; email: string | undefined; fileIds: string[]; redirectUri: string };
type RecordedProgress = { index: number; total: number; remaining: number };

/** 呼び出し順に status を返し分ける openPicker のスタブを作る。 */
function makeOpenPickerStub(statuses: RegrantPickerOutcome['status'][]) {
    const calls: RecordedCall[] = [];
    const openPicker = async (args: { folderId: string; email?: string; fileIds: string[]; redirectUri: string }): Promise<RegrantPickerOutcome> => {
        const callIndex = calls.length;
        calls.push({ folderId: args.folderId, email: args.email, fileIds: args.fileIds, redirectUri: args.redirectUri });
        const status = statuses[callIndex];
        if (status === 'granted') return { status: 'granted', granted: args.fileIds.length };
        if (status === 'cancelled') return { status: 'cancelled' };
        return { status: 'parse-error' };
    };
    return { openPicker, calls };
}

test('all chunks granted: total/opened/stoppedBy and the flattened fileIds round-trip (Issue #203)', async () => {
    const { openPicker, calls } = makeOpenPickerStub(['granted', 'granted', 'granted']);
    const outcome = await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: ALL_FILE_IDS,
        redirectUri: TEST_REDIRECT_URI,
        openPicker,
    });
    assert.deepEqual(outcome, { total: 3, opened: 3, stoppedBy: 'completed' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.flatMap((c) => c.fileIds), ALL_FILE_IDS);
});

test('a cancelled chunk stops the loop before opening the remaining chunk (Issue #203)', async () => {
    const { openPicker, calls } = makeOpenPickerStub(['granted', 'cancelled', 'granted']);
    const outcome = await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: ALL_FILE_IDS,
        redirectUri: TEST_REDIRECT_URI,
        openPicker,
    });
    assert.deepEqual(outcome, { total: 3, opened: 1, stoppedBy: 'cancelled' });
    // 3チャンク目が開かれていないことを回数で示す（開いていればここが3になる）
    assert.equal(calls.length, 2);
});

test('a parse-error on the first chunk stops immediately (Issue #203)', async () => {
    const { openPicker, calls } = makeOpenPickerStub(['parse-error', 'granted', 'granted']);
    const outcome = await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: ALL_FILE_IDS,
        redirectUri: TEST_REDIRECT_URI,
        openPicker,
    });
    assert.deepEqual(outcome, { total: 3, opened: 0, stoppedBy: 'parse-error' });
    assert.equal(calls.length, 1);
});

test('an empty fileIds array never opens the Picker (Issue #203)', async () => {
    const { openPicker, calls } = makeOpenPickerStub([]);
    const progress: RecordedProgress[] = [];
    const outcome = await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: [],
        openPicker,
        onChunkStart: (p) => progress.push(p),
    });
    assert.deepEqual(outcome, { total: 0, opened: 0, stoppedBy: 'completed' });
    assert.equal(calls.length, 0);
    assert.equal(progress.length, 0);
});

test('onChunkStart reports remaining as the count including the current chunk (Issue #203)', async () => {
    const { openPicker } = makeOpenPickerStub(['granted', 'granted', 'granted']);
    const progress: RecordedProgress[] = [];
    await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: ALL_FILE_IDS,
        redirectUri: TEST_REDIRECT_URI,
        openPicker,
        onChunkStart: (p) => progress.push(p),
    });
    // チャンクは [SIZE件, SIZE件, 1件]。remaining は「この回を含む未処理件数」。
    assert.deepEqual(progress, [
        { index: 0, total: 3, remaining: REGRANT_PICKER_CHUNK_SIZE * 2 + 1 },
        { index: 1, total: 3, remaining: REGRANT_PICKER_CHUNK_SIZE + 1 },
        { index: 2, total: 3, remaining: 1 },
    ]);
});

test('folderId/email/redirectUri are passed through to every chunk unchanged (Issue #203)', async () => {
    const { openPicker, calls } = makeOpenPickerStub(['granted', 'granted', 'granted']);
    await runRegrantPickerChunks({
        folderId: 'folder_42',
        email: 'reviewer@example.com',
        fileIds: ALL_FILE_IDS,
        redirectUri: TEST_REDIRECT_URI,
        openPicker,
    });
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.equal(call.folderId, 'folder_42');
        assert.equal(call.email, 'reviewer@example.com');
        // 分割時にURL長を測った redirectUri と、実際にPickerを開く際の redirectUri が
        // 一致していること（測るURLと開くURLを一致させる、という作業4の要）。
        assert.equal(call.redirectUri, TEST_REDIRECT_URI);
    }
});

test('omitting openPicker falls back to the real runRegrantPickerFlow without touching chrome.identity when fileIds is empty (Issue #203)', async () => {
    // openPicker/openPicker系の差し替え口を使わない呼び出しでも、fileIds が空なら
    // Picker を1回も開かない（=chrome.identityに触れない）ため、chromeグローバルの
    // スタブ無しでこの経路だけは検証できる。
    const outcome = await runRegrantPickerChunks({
        folderId: 'folder_1',
        fileIds: [],
    });
    assert.deepEqual(outcome, { total: 0, opened: 0, stoppedBy: 'completed' });
});
