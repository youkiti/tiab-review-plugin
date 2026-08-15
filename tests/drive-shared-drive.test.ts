import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { withSharedDriveParams } from '../src/lib/drive-shared-drive';
import { getDriveFileMetadata, listAccessibleFileIdsInFolder, downloadDriveFile } from '../src/lib/drive-api';

// 共有ドライブ（Shared drives）配下のファイルは、Drive API v3 の
// supportsAllDrives / includeItemsFromAllDrives が無いと扱えない（2026-08-15 実測）。
// 特に files.list は 200 + 0件（silent）を返し「フォルダが空」と区別が付かないため、
// パラメータが落ちても既存テストは緑のまま通ってしまう。ここで実際に飛ぶURLを見張る。

const mockPlatform: PlatformAdapter = {
    getAuthToken: async () => 'test-token',
    forceReauth: async () => 'test-token',
    clearAuth: async () => {},
    storageGet: async () => ({}),
    storageSet: async () => {},
    storageRemove: async () => {},
    storageClear: async () => {},
    onMessage: () => {},
    emitMessage: () => {},
    getMessage: (key: string) => key,
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
setPlatform(mockPlatform);

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** 呼ばれたURLを記録しつつ body を返すfetchスタブ */
function stubFetchRecording(body: unknown): { urls: string[] } {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input.toString());
        return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { urls };
}

// ---------------------------------------------------------------------------
// withSharedDriveParams: 純粋関数
// ---------------------------------------------------------------------------

test('withSharedDriveParams: item は supportsAllDrives のみ付ける', () => {
    assert.equal(
        withSharedDriveParams('https://x/files/abc?fields=id'),
        'https://x/files/abc?fields=id&supportsAllDrives=true'
    );
});

test('withSharedDriveParams: list は includeItemsFromAllDrives も付ける', () => {
    assert.equal(
        withSharedDriveParams('https://x/files?q=a', 'list'),
        'https://x/files?q=a&supportsAllDrives=true&includeItemsFromAllDrives=true'
    );
});

test('withSharedDriveParams: クエリが無いURLには ? で繋ぐ', () => {
    assert.equal(
        withSharedDriveParams('https://x/files/abc'),
        'https://x/files/abc?supportsAllDrives=true'
    );
});

// ---------------------------------------------------------------------------
// 実際の呼び出し経路（パラメータが落ちると silent に壊れるもの）
// ---------------------------------------------------------------------------

test('listAccessibleFileIdsInFolder: files.list に共有ドライブ用パラメータを付ける', async () => {
    const { urls } = stubFetchRecording({ files: [{ id: 'f1' }] });
    const ids = await listAccessibleFileIdsInFolder('folder-1');

    assert.deepEqual([...ids], ['f1']);
    assert.equal(urls.length, 1);
    // 欠けると 200 + 0件（＝「フォルダが空」と誤読）になるため、両方必須
    assert.ok(urls[0].includes('supportsAllDrives=true'), urls[0]);
    assert.ok(urls[0].includes('includeItemsFromAllDrives=true'), urls[0]);
});

test('getDriveFileMetadata: files.get に supportsAllDrives を付ける', async () => {
    const { urls } = stubFetchRecording({ id: 'file-1', name: 'a.pdf', mimeType: 'application/pdf', trashed: false });
    await getDriveFileMetadata('file-1');

    assert.equal(urls.length, 1);
    // 欠けると共有ドライブ上のファイルが 404 になり、Picker で選び直しても直らない
    assert.ok(urls[0].includes('supportsAllDrives=true'), urls[0]);
});

test('downloadDriveFile: alt=media にも一律で付ける（実測上は不要だが害も無い）', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(typeof input === 'string' ? input : input.toString());
        return new Response('%PDF-1.4', { status: 200 });
    }) as typeof fetch;

    await downloadDriveFile('file-1');

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('alt=media'), urls[0]);
    assert.ok(urls[0].includes('supportsAllDrives=true'), urls[0]);
});
