import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import {
    classifyDriveApiStatus,
    resolveFolderState,
    describeDriveAccessError,
    DriveAccessDeniedError,
    DriveAuthError,
    DriveTransientError,
    ensureFulltextFolder,
    setupProjectFolder,
} from '../src/lib/drive-api';
import { getProjectDriveFolderId, getFulltextDriveFolderId, SheetsAccessDeniedError } from '../src/lib/sheets-api';

// Issue #60: drive.file は「アプリ×ユーザー×ファイル」単位でしか付与されないため、
// PDFをアップロードした本人以外がプロジェクトのDriveフォルダ/スプレッドシートを
// GETすると403/404になりうる。これを「存在しない」と誤認してフォルダを作り直し・
// 他人のスプレッドシートを移動してしまう経路を塞ぐための回帰テスト。

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
    getMessage: (key: string) => key, // ここでは分岐の検証が目的なのでメッセージ内容は問わない
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
setPlatform(mockPlatform);

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// classifyDriveApiStatus: 純粋関数のステータス分類
// ---------------------------------------------------------------------------

test('classifyDriveApiStatus: 200番台はok', () => {
    assert.equal(classifyDriveApiStatus(200), 'ok');
    assert.equal(classifyDriveApiStatus(204), 'ok');
    assert.equal(classifyDriveApiStatus(299), 'ok');
});

test('classifyDriveApiStatus: 401はauth-error', () => {
    assert.equal(classifyDriveApiStatus(401), 'auth-error');
});

test('classifyDriveApiStatus: 403/404はinaccessible', () => {
    assert.equal(classifyDriveApiStatus(403), 'inaccessible');
    assert.equal(classifyDriveApiStatus(404), 'inaccessible');
});

test('classifyDriveApiStatus: 500/429はtransient-error', () => {
    assert.equal(classifyDriveApiStatus(500), 'transient-error');
    assert.equal(classifyDriveApiStatus(429), 'transient-error');
});

// ---------------------------------------------------------------------------
// エラークラス: フィールド保持
// ---------------------------------------------------------------------------

test('DriveAccessDeniedError: fileIdとstatusを保持する', () => {
    const error = new DriveAccessDeniedError('folder-1', 404);
    assert.equal(error.name, 'DriveAccessDeniedError');
    assert.equal(error.fileId, 'folder-1');
    assert.equal(error.status, 404);
    assert.ok(error instanceof Error);
});

test('DriveAuthError: fileIdを保持する', () => {
    const error = new DriveAuthError('file-2');
    assert.equal(error.name, 'DriveAuthError');
    assert.equal(error.fileId, 'file-2');
});

test('DriveTransientError: fileIdを保持する', () => {
    const error = new DriveTransientError('file-3');
    assert.equal(error.name, 'DriveTransientError');
    assert.equal(error.fileId, 'file-3');
});

test('describeDriveAccessError: 型付きエラーのみ非nullを返し、それ以外はnull', () => {
    assert.notEqual(describeDriveAccessError(new DriveAccessDeniedError('f')), null);
    assert.notEqual(describeDriveAccessError(new DriveAuthError('f')), null);
    assert.notEqual(describeDriveAccessError(new DriveTransientError('f')), null);
    assert.equal(describeDriveAccessError(new Error('other')), null);
    assert.equal(describeDriveAccessError('not an error'), null);
});

// ---------------------------------------------------------------------------
// resolveFolderState: HTTPステータス/ネットワーク例外/JSONパース失敗の分類
// （旧 folderExists() は catch { return false } で「見えない」を「無い」に潰していたため危険だった）
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return handler(url);
    }) as typeof fetch;
}

test('resolveFolderState: 200かつtrashed!==trueはaccessible', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'f1', trashed: false }), { status: 200 }));
    assert.equal(await resolveFolderState('f1'), 'accessible');
});

test('resolveFolderState: 200かつtrashed===trueはtrashed（確定した答えなので作り直してよい）', async () => {
    stubFetch(() => new Response(JSON.stringify({ id: 'f1', trashed: true }), { status: 200 }));
    assert.equal(await resolveFolderState('f1'), 'trashed');
});

test('resolveFolderState: 401はauth-error', async () => {
    stubFetch(() => new Response('{}', { status: 401 }));
    assert.equal(await resolveFolderState('f1'), 'auth-error');
});

test('resolveFolderState: 403/404はinaccessible', async () => {
    stubFetch(() => new Response('{}', { status: 403 }));
    assert.equal(await resolveFolderState('f1'), 'inaccessible');
    stubFetch(() => new Response('{}', { status: 404 }));
    assert.equal(await resolveFolderState('f2'), 'inaccessible');
});

test('resolveFolderState: 500/429はtransient-error', async () => {
    stubFetch(() => new Response('{}', { status: 500 }));
    assert.equal(await resolveFolderState('f1'), 'transient-error');
    stubFetch(() => new Response('{}', { status: 429 }));
    assert.equal(await resolveFolderState('f2'), 'transient-error');
});

test('resolveFolderState: ネットワーク例外はtransient-error', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    assert.equal(await resolveFolderState('f1'), 'transient-error');
});

test('resolveFolderState: 200だがJSONパース失敗はtransient-error', async () => {
    stubFetch(() => new Response('not-json', { status: 200 }));
    assert.equal(await resolveFolderState('f1'), 'transient-error');
});

// ---------------------------------------------------------------------------
// sheets-api.ts: Config読み取りの握り潰し分離（B-3）
// ---------------------------------------------------------------------------

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const CONFIG_RANGE = encodeURIComponent('Config!A:B');

test('getProjectDriveFolderId: Configタブが本当に無い場合はnullを返す', async () => {
    stubFetch((url) => {
        if (url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(
                JSON.stringify({ error: { code: 400, message: 'Unable to parse range: Config!A:B' } }),
                { status: 400 }
            );
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    assert.equal(await getProjectDriveFolderId('sheet-1'), null);
});

test('getProjectDriveFolderId: スプレッドシート自体へのアクセス拒否(404)はnullに潰さずthrowする', async () => {
    stubFetch((url) => {
        if (url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(
                JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }),
                { status: 404 }
            );
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    await assert.rejects(
        () => getProjectDriveFolderId('sheet-1'),
        (error: unknown) => error instanceof SheetsAccessDeniedError
    );
});

test('getFulltextDriveFolderId: 一時エラー(500)はnullに潰さずthrowする', async () => {
    stubFetch((url) => {
        if (url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(JSON.stringify({ error: { message: 'Internal error' } }), { status: 500 });
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    await assert.rejects(() => getFulltextDriveFolderId('sheet-1'));
});

test('getFulltextDriveFolderId: 設定済みならその値を返す', async () => {
    stubFetch((url) => {
        if (url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(
                JSON.stringify({ values: [['fulltext_drive_folder', 'folder-abc']] }),
                { status: 200 }
            );
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    assert.equal(await getFulltextDriveFolderId('sheet-1'), 'folder-abc');
});

// ---------------------------------------------------------------------------
// ensureFulltextFolder / setupProjectFolder: fail-fast と所有者ガード（B-2 / B-4）
// ---------------------------------------------------------------------------

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

/** テスト用の呼び出し記録付きfetchスタブを組み立てる */
function buildDriveMock(opts: {
    fulltextFolderId?: string | null;
    fulltextFolderStatus?: number; // resolveFolderState 用（files/{id}?fields=id,trashed）
    ownedByMe?: boolean;
    ownerCheckStatus?: number;
}) {
    const calls: string[] = [];
    const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        calls.push(`${method} ${url}`);

        // Config!A:B 読み取り（getFulltextDriveFolderId / getProjectDriveFolderId）
        if (url.includes(`/values/${CONFIG_RANGE}`)) {
            const row = opts.fulltextFolderId
                ? [['fulltext_drive_folder', opts.fulltextFolderId]]
                : [];
            return new Response(JSON.stringify({ values: row }), { status: 200 });
        }

        // resolveFolderState（保存済みfulltextフォルダの状態確認）
        if (opts.fulltextFolderId && url.includes(`/files/${opts.fulltextFolderId}?fields=id,trashed`)) {
            return new Response(JSON.stringify({ id: opts.fulltextFolderId, trashed: false }), {
                status: opts.fulltextFolderStatus ?? 200,
            });
        }

        // 所有者チェック（ownedByMe）
        if (url.includes('?fields=ownedByMe')) {
            return new Response(JSON.stringify({ ownedByMe: opts.ownedByMe }), {
                status: opts.ownerCheckStatus ?? 200,
            });
        }

        // フォルダ作成（createFolder）: 呼ばれたこと自体を calls で検証する
        if (method === 'POST' && url === `${DRIVE_API_BASE}/files?fields=id`) {
            return new Response(JSON.stringify({ id: 'new-folder-id' }), { status: 200 });
        }

        // moveFileToFolder の親取得
        if (method === 'GET' && url.includes('?fields=parents')) {
            return new Response(JSON.stringify({ parents: ['root'] }), { status: 200 });
        }
        // moveFileToFolder の移動本体
        if (method === 'PATCH' && url.includes('addParents=')) {
            return new Response(JSON.stringify({ id: 'sheet-1', parents: ['new-folder-id'] }), { status: 200 });
        }

        throw new Error(`unhandled mock fetch: ${method} ${url}`);
    };
    globalThis.fetch = handler as typeof fetch;
    return { calls };
}

test('ensureFulltextFolder: 保存済みIDがinaccessible(404)なら型付きエラーをthrowし、フォルダを作り直さない', async () => {
    const { calls } = buildDriveMock({ fulltextFolderId: 'existing-folder', fulltextFolderStatus: 404 });

    await assert.rejects(
        () => ensureFulltextFolder('sheet-1'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );

    // setupProjectFolder（createFolder）へ絶対に進んでいないことを確認する
    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    assert.equal(createCalls.length, 0, 'inaccessible の場合に createFolder が呼ばれてはならない');
});

test('ensureFulltextFolder: 保存済みIDがaccessibleならそのまま返し、作り直さない', async () => {
    const { calls } = buildDriveMock({ fulltextFolderId: 'existing-folder', fulltextFolderStatus: 200 });

    const folderId = await ensureFulltextFolder('sheet-1');

    assert.equal(folderId, 'existing-folder');
    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    assert.equal(createCalls.length, 0, 'accessible の場合に createFolder が呼ばれてはならない（退行防止）');
});

test('setupProjectFolder: ownedByMe===falseなら型付きエラーをthrowし、フォルダを作らない・移動しない', async () => {
    const { calls } = buildDriveMock({ ownedByMe: false });

    await assert.rejects(
        () => setupProjectFolder('sheet-1', 'Some Project'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );

    // createFolder（孤児フォルダ化しうる操作）・moveFileToFolder（他人のシート移動）が
    // どちらも呼ばれていないことを確認する（Issue #60 のレガシープロジェクトの穴のガード）
    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    const moveCalls = calls.filter(c => c.startsWith('PATCH') && c.includes('addParents='));
    assert.equal(createCalls.length, 0, 'ownedByMe===false のとき createFolder が呼ばれてはならない');
    assert.equal(moveCalls.length, 0, 'ownedByMe===false のとき moveFileToFolder が呼ばれてはならない');
});

test('setupProjectFolder: ownedByMeが取得できない(フィールド欠落)場合も安全側に倒してthrowする', async () => {
    const { calls } = buildDriveMock({ ownedByMe: undefined });

    await assert.rejects(
        () => setupProjectFolder('sheet-1', 'Some Project'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    assert.equal(createCalls.length, 0);
});

test('setupProjectFolder: 所有者チェックが401なら認証エラーとしてthrowする', async () => {
    buildDriveMock({ ownerCheckStatus: 401 });

    await assert.rejects(
        () => setupProjectFolder('sheet-1', 'Some Project'),
        (error: unknown) => error instanceof DriveAuthError
    );
});
