import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import {
    listAccessibleFileIdsInFolder,
    buildFolderChildrenQuery,
    DriveAccessDeniedError,
    DriveAuthError,
    DriveTransientError,
} from '../src/lib/drive-api';

// Issue #60 実測（scripts/drive-file-probe/, 2026-08-08）に基づく回帰テスト:
// - files.list は権限が無くても HTTP 200 + files: [] を返す（HTTPステータスでは判定できない）
// - 親フォルダ自体が未付与でも、files.list は付与済みの子ファイルを返す
// - PDFが1000件超のプロジェクトで取りこぼさないよう nextPageToken を最後まで追う

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

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return handler(url);
    }) as typeof fetch;
}

test('listAccessibleFileIdsInFolder: files配列のIDをSetにして返す', async () => {
    stubFetch(() => new Response(
        JSON.stringify({ files: [{ id: 'a' }, { id: 'b' }] }),
        { status: 200 }
    ));
    const ids = await listAccessibleFileIdsInFolder('folder-1');
    assert.deepEqual(Array.from(ids).sort(), ['a', 'b']);
});

test('listAccessibleFileIdsInFolder: 権限が無い(=filesが空配列)場合はHTTP200のまま空Setを返す（例外を投げない）', async () => {
    stubFetch(() => new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const ids = await listAccessibleFileIdsInFolder('folder-1');
    assert.equal(ids.size, 0);
});

test('listAccessibleFileIdsInFolder: nextPageTokenを最後まで追ってページをまたいでIDを集約する', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
        calls.push(url);
        const params = new URL(url).searchParams;
        const pageToken = params.get('pageToken');
        if (!pageToken) {
            return new Response(
                JSON.stringify({ files: [{ id: 'page1-a' }], nextPageToken: 'tok-2' }),
                { status: 200 }
            );
        }
        if (pageToken === 'tok-2') {
            return new Response(
                JSON.stringify({ files: [{ id: 'page2-a' }], nextPageToken: 'tok-3' }),
                { status: 200 }
            );
        }
        if (pageToken === 'tok-3') {
            return new Response(JSON.stringify({ files: [{ id: 'page3-a' }] }), { status: 200 });
        }
        throw new Error(`unexpected pageToken: ${pageToken}`);
    });

    const ids = await listAccessibleFileIdsInFolder('folder-1');
    assert.deepEqual(Array.from(ids).sort(), ['page1-a', 'page2-a', 'page3-a']);
    assert.equal(calls.length, 3, '3ページとも呼ばれること');
});

test('listAccessibleFileIdsInFolder: 401はDriveAuthError', async () => {
    stubFetch(() => new Response('{}', { status: 401 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-1'),
        (error: unknown) => error instanceof DriveAuthError
    );
});

test('listAccessibleFileIdsInFolder: 403/404はDriveAccessDeniedError', async () => {
    stubFetch(() => new Response('{}', { status: 403 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-1'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
    stubFetch(() => new Response('{}', { status: 404 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-2'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
});

test('listAccessibleFileIdsInFolder: 500/429はDriveTransientError', async () => {
    stubFetch(() => new Response('{}', { status: 500 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
    stubFetch(() => new Response('{}', { status: 429 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-2'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('listAccessibleFileIdsInFolder: ネットワーク例外はDriveTransientError', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('listAccessibleFileIdsInFolder: JSONパース失敗はDriveTransientError', async () => {
    stubFetch(() => new Response('not-json', { status: 200 }));
    await assert.rejects(
        () => listAccessibleFileIdsInFolder('folder-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('listAccessibleFileIdsInFolder: クエリにフォルダIDを親とするtrashed=false条件を含める', async () => {
    let capturedUrl = '';
    stubFetch((url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });
    await listAccessibleFileIdsInFolder('folder-xyz');
    const q = new URL(capturedUrl).searchParams.get('q');
    assert.equal(q, "'folder-xyz' in parents and trashed=false");
});

test('listAccessibleFileIdsInFolder: Driveが同じnextPageTokenを返し続けても無限ループにならず打ち切る', async () => {
    // 異常応答で nextPageToken が終わらないケースのシミュレーション。
    // 例外にはせず、そこまでに集めたIDで打ち切って返すこと（呼び出し回数に上限があること）を確認する。
    let callCount = 0;
    stubFetch(() => {
        callCount += 1;
        return new Response(
            JSON.stringify({ files: [{ id: `page-${callCount}` }], nextPageToken: 'always-more' }),
            { status: 200 }
        );
    });

    const ids = await listAccessibleFileIdsInFolder('folder-1');

    // 上限に達して打ち切られるため、実際のプロジェクト規模ではありえない大量ページには到達しない
    assert.ok(callCount > 0 && callCount <= 50, `呼び出し回数が上限で打ち切られること（実際: ${callCount}）`);
    assert.equal(ids.size, callCount, '打ち切りまでに集めたIDはそのまま返ること');
});

// ---------------------------------------------------------------------------
// buildFolderChildrenQuery（旧 fulltext-access.ts から移動。循環import解消のため drive-api.ts へ集約）
// ---------------------------------------------------------------------------

test('buildFolderChildrenQuery: フォルダIDを親とするtrashed=falseクエリを組み立てる', () => {
    assert.equal(
        buildFolderChildrenQuery('folder-123'),
        "'folder-123' in parents and trashed=false"
    );
});

test('buildFolderChildrenQuery: シングルクォート・バックスラッシュをエスケープする（buildImportedCopyQueryと同じ方式）', () => {
    assert.equal(
        buildFolderChildrenQuery(String.raw`fo'lder\1`),
        String.raw`'fo\'lder\\1' in parents and trashed=false`
    );
});
