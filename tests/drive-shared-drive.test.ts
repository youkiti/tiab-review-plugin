import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { withSharedDriveParams, driveFetch } from '../src/lib/drive-shared-drive';
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
// driveFetch: Drive API を叩く唯一の入口
// ---------------------------------------------------------------------------

/** driveFetch へ渡した (url, init) を記録するfetchスタブ */
function stubFetchCapturing(): { calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} });
        return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { calls };
}

test('driveFetch: 共有ドライブ用パラメータと Authorization ヘッダを必ず付ける', async () => {
    const { calls } = stubFetchCapturing();
    await driveFetch('https://x/files/abc?fields=id', {}, { token: 'tok' });

    assert.equal(calls[0].url, 'https://x/files/abc?fields=id&supportsAllDrives=true');
    assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer tok');
});

test('driveFetch: kind に list を渡すと includeItemsFromAllDrives も付く', async () => {
    const { calls } = stubFetchCapturing();
    await driveFetch('https://x/files?q=a', {}, { token: 'tok', kind: 'list' });

    assert.equal(calls[0].url, 'https://x/files?q=a&supportsAllDrives=true&includeItemsFromAllDrives=true');
});

test('driveFetch: 呼び出し側の method / headers / body はそのまま透過する', async () => {
    const { calls } = stubFetchCapturing();
    await driveFetch(
        'https://x/files',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
        { token: 'tok' }
    );

    const { init } = calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.body, '{"a":1}');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    // Authorization を上書き注入しても他のヘッダは落ちないこと
    assert.equal(headers.get('Authorization'), 'Bearer tok');
});

// ---------------------------------------------------------------------------
// 直呼びの禁止（Issue #95 の完了条件）
//
// パラメータ付与を呼び出し側の判断に委ねると、新しく増えた経路で必ず取りこぼす。
// しかも files.list の欠落は HTTP 200 + 0件という「エラーにならない壊れ方」をするため、
// 通常のテストではすり抜ける。ソースを直接見張って、経路が増えた瞬間に落とす。
// ---------------------------------------------------------------------------

test('Drive モジュール（drive-api.ts / drive-permissions.ts / drive-recent-files.ts）に fetch() の直呼びが残っていない（driveFetch 経由のみ）', () => {
    for (const name of ['drive-api.ts', 'drive-permissions.ts', 'drive-recent-files.ts']) {
        const source = readFileSync(join(process.cwd(), 'src', 'lib', name), 'utf8');
        // コメント中の記述を拾わないよう除去する。URL の "://" を先に退避してから
        // 行コメントを落とす（https:// を行コメント開始と誤認しないため）。
        const code = source
            .replace(/:\/\//g, ':__SCHEME__')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        // driveFetch( / getResp = await driveFetch( などは前方に識別子文字が付くため除外される
        const directCalls = code.match(/(?<![A-Za-z0-9_$])fetch\s*\(/g) ?? [];

        assert.deepEqual(
            directCalls,
            [],
            `${name}: Drive API は driveFetch() 経由で呼ぶこと（supportsAllDrives が落ちると共有ドライブで silent に壊れる）`
        );
    }
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
