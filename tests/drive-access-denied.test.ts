import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform, platform } from '../src/platform';
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
    downloadDriveFile,
    isDriveRateLimitBody,
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
const originalPlatform = platform();
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
// sheets/config.ts: Config読み取りの握り潰し分離（B-3）
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
        // 共有ドライブ対応パラメータ（withSharedDriveParams）が末尾に付くため前方一致で見る
        if (method === 'POST' && url.startsWith(`${DRIVE_API_BASE}/files?fields=id`)) {
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

test('ensureFulltextFolder: 保存済みIDがinaccessible(404)なら保存済みIDをそのまま返し、フォルダを作り直さない', async () => {
    // drive.file は所有権やDrive共有では付与されないため、共同研究者にとってこの
    // フォルダは常にinaccessible(404)になる。実測で親フォルダへの付与が無くても
    // アップロード自体は可能と確定しているため、fail-fastせず保存済みIDを再利用する
    // （src/lib/drive-api.ts の ensureFulltextFolder 内コメント参照）。
    const { calls } = buildDriveMock({ fulltextFolderId: 'existing-folder', fulltextFolderStatus: 404 });

    const folderId = await ensureFulltextFolder('sheet-1');

    // 別のフォルダを作って返しているのではなく、Configに保存されていた値そのものであること
    assert.equal(folderId, 'existing-folder');

    // setupProjectFolder（createFolder）・moveFileToFolderへ絶対に進んでいないことを確認する
    // （PR #61 の「trashed以外では作り直さない」保護がここでも維持されていることの検証）
    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    const moveCalls = calls.filter(c => c.startsWith('PATCH') && c.includes('addParents='));
    assert.equal(createCalls.length, 0, 'inaccessible の場合に createFolder が呼ばれてはならない');
    assert.equal(moveCalls.length, 0, 'inaccessible の場合に moveFileToFolder が呼ばれてはならない');
});

test('ensureFulltextFolder: 保存済みIDがauth-error(401)なら型付きエラーをthrowし、フォルダを作り直さない', async () => {
    const { calls } = buildDriveMock({ fulltextFolderId: 'existing-folder', fulltextFolderStatus: 401 });

    await assert.rejects(
        () => ensureFulltextFolder('sheet-1'),
        (error: unknown) => error instanceof DriveAuthError
    );

    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    assert.equal(createCalls.length, 0, 'auth-error の場合に createFolder が呼ばれてはならない');
});

test('ensureFulltextFolder: 保存済みIDがtransient-error(500)なら型付きエラーをthrowし、フォルダを作り直さない', async () => {
    const { calls } = buildDriveMock({ fulltextFolderId: 'existing-folder', fulltextFolderStatus: 500 });

    await assert.rejects(
        () => ensureFulltextFolder('sheet-1'),
        (error: unknown) => error instanceof DriveTransientError
    );

    const createCalls = calls.filter(c => c.startsWith('POST') && c.includes('/files?fields=id'));
    assert.equal(createCalls.length, 0, 'transient-error の場合に createFolder が呼ばれてはならない');
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

// ---------------------------------------------------------------------------
// isDriveRateLimitBody: 403本文からレート制限を判定する純粋関数（Issue #69追加分）
// ---------------------------------------------------------------------------

test('isDriveRateLimitBody: errors[].reason が該当reasonならtrue（各reasonを確認）', () => {
    for (const reason of [
        'userRateLimitExceeded',
        'rateLimitExceeded',
        'quotaExceeded',
        'dailyLimitExceeded',
        'sharingRateLimitExceeded',
    ]) {
        const body = { error: { errors: [{ domain: 'usageLimits', reason, message: 'x' }] } };
        assert.equal(isDriveRateLimitBody(body), true, `reason=${reason} で true になるはず`);
    }
});

test('isDriveRateLimitBody: 通常の権限エラー(insufficientFilePermissions)はfalse', () => {
    const body = {
        error: {
            errors: [{ domain: 'global', reason: 'insufficientFilePermissions', message: 'The user does not have sufficient permissions for file.' }],
        },
    };
    assert.equal(isDriveRateLimitBody(body), false);
});

test('isDriveRateLimitBody: error.status はSCREAMING_SNAKE_CASEの語彙のみを拾う（camelCaseのreason語彙は拾わない）', () => {
    // error.status は gRPC 由来の SCREAMING_SNAKE_CASE（RESOURCE_EXHAUSTED等）であり、
    // errors[].reason の camelCase（rateLimitExceeded等）とは語彙が異なる。
    // 実際のDriveレスポンスに 'rateLimitExceeded' という値の error.status は現れないため、
    // camelCaseをそのまま status に入れても拾わないことを固定する。
    assert.equal(isDriveRateLimitBody({ error: { status: 'rateLimitExceeded' } }), false);
});

test('isDriveRateLimitBody: error.status=RESOURCE_EXHAUSTEDはtrue（errors[]を含まない新形式403）', () => {
    // Drive が errors[] を含まない {"error":{"code":403,"status":"RESOURCE_EXHAUSTED",...}} 形式で
    // 403を返した場合でも一時エラーとして検出できることを固定する。
    assert.equal(
        isDriveRateLimitBody({ error: { code: 403, message: 'x', status: 'RESOURCE_EXHAUSTED' } }),
        true
    );
});

test('isDriveRateLimitBody: error.status=PERMISSION_DENIEDはfalse（権限エラーを一時エラーへ倒さない）', () => {
    assert.equal(
        isDriveRateLimitBody({ error: { code: 403, message: 'x', status: 'PERMISSION_DENIED' } }),
        false
    );
});

test('isDriveRateLimitBody: errors[].domain="usageLimits"は未知のreasonでもtrue（domainの方が安定したsignal）', () => {
    // reason は今後増える可能性があるが、Drive のレート制限系エラーはdomain: 'usageLimits'が定型のため、
    // 未知のreason名でもdomainだけで拾えることを固定する。
    assert.equal(
        isDriveRateLimitBody({ error: { errors: [{ domain: 'usageLimits', reason: 'someNewUnknownReason' }] } }),
        true
    );
});

test('isDriveRateLimitBody: errors[].domain="global"はfalse（usageLimits以外のdomainでは倒さない）', () => {
    assert.equal(
        isDriveRateLimitBody({ error: { errors: [{ domain: 'global', reason: 'insufficientFilePermissions' }] } }),
        false
    );
});

test('isDriveRateLimitBody: error.message からも補助的に判定する', () => {
    assert.equal(isDriveRateLimitBody({ error: { message: 'User Rate Limit Exceeded' } }), false); // 大文字小文字違いは拾わない仕様の確認
    assert.equal(isDriveRateLimitBody({ error: { message: 'Rate limit exceeded: userRateLimitExceeded for this user' } }), true);
});

test('isDriveRateLimitBody: null/非オブジェクト/errorフィールド無しはfalse（安全側）', () => {
    assert.equal(isDriveRateLimitBody(null), false);
    assert.equal(isDriveRateLimitBody(undefined), false);
    assert.equal(isDriveRateLimitBody('not-json-shaped'), false);
    assert.equal(isDriveRateLimitBody(123), false);
    assert.equal(isDriveRateLimitBody({}), false);
    assert.equal(isDriveRateLimitBody({ error: null }), false);
    assert.equal(isDriveRateLimitBody({ error: {} }), false);
});

// ---------------------------------------------------------------------------
// downloadDriveFile: 403のレート制限誤案内防止・auth-error分離・text/htmlガード（Issue #69）
// ---------------------------------------------------------------------------

function stubDownloadFetch(handler: (url: string) => Response | Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        return handler(url);
    }) as typeof fetch;
}

test('downloadDriveFile: 403+userRateLimitExceeded本文はDriveTransientError（「未付与」と誤案内しない）', async () => {
    // 本拡張は最大3並列でプリフェッチするため、付与済みのオーナーでもレート制限403を
    // 現実に踏む。ここをDriveAccessDeniedErrorのままにすると「未付与または削除済み」と
    // 断定表示され、再試行ボタンも出ず、直しようのないPickerフローだけが主導線になる
    // （このPRが防ごうとしている誤案内そのもの）。
    stubDownloadFetch(() => new Response(
        JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }] } }),
        { status: 403 }
    ));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('downloadDriveFile: 403+errors[]を含まない新形式(status:RESOURCE_EXHAUSTED)本文はDriveTransientError', async () => {
    // Drive が errors[] を含まない {"error":{"code":403,"status":"RESOURCE_EXHAUSTED",...}} 形式で
    // 403を返した場合でも、レート制限として検出できDriveTransientErrorになることを固定する
    // （errors[].reason の語彙で error.status を照合していた旧実装では検出できなかった）。
    stubDownloadFetch(() => new Response(
        JSON.stringify({ error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Rate limit exceeded' } }),
        { status: 403 }
    ));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('downloadDriveFile: 403+通常の権限エラー本文(insufficientFilePermissions)はDriveAccessDeniedError', async () => {
    stubDownloadFetch(() => new Response(
        JSON.stringify({ error: { errors: [{ reason: 'insufficientFilePermissions', message: 'The user does not have sufficient permissions for file.' }] } }),
        { status: 403 }
    ));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
});

test('downloadDriveFile: 403+本文がJSONとして壊れている場合はDriveAccessDeniedError（安全側）', async () => {
    // 本文の読み取り/パースに失敗した場合にレート制限と誤判定して再試行だけを促すと、
    // 本当に未付与のケースで直しようのない「再試行」を繰り返させてしまう。安全側に倒す。
    stubDownloadFetch(() => new Response('not-json', { status: 403 }));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
});

test('downloadDriveFile: 404はDriveAccessDeniedError（本文を読まない。レート制限は403でしか来ない）', async () => {
    stubDownloadFetch(() => new Response(
        JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
        { status: 404 }
    ));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveAccessDeniedError
    );
});

test('downloadDriveFile: getAuthToken()が失敗したらDriveAuthError（素のErrorを漏らさない）', async () => {
    // downloadDriveFile() は docstring で「失敗は必ず型付きエラーで投げる」と宣言しているのに
    // getAuthToken() がtryの外にあると、トークン失効時に素のErrorが抜けて呼び出し側で
    // kind:'unknown'（「時間をおいて再試行」）に落ちてしまう。本来はauth-error（再ログイン案内）。
    setPlatform({
        ...mockPlatform,
        getAuthToken: async () => { throw new Error('token expired'); },
    });
    try {
        await assert.rejects(
            () => downloadDriveFile('file-1'),
            (error: unknown) => error instanceof DriveAuthError
        );
    } finally {
        // 他のテストに影響しないよう必ず元のプラットフォームへ戻す
        setPlatform(originalPlatform);
    }
});

test('downloadDriveFile: 200+text/htmlはDriveAuthError（サインインページを掴んだ場合。未付与と断定しない）', async () => {
    stubDownloadFetch(() => new Response('<html>sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveAuthError
    );
});

test('downloadDriveFile: 200+application/pdfはBlobを返す（正常系の退行防止）', async () => {
    stubDownloadFetch(() => new Response(new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
    }));
    const blob = await downloadDriveFile('file-1');
    assert.ok(blob instanceof Blob);
    assert.equal(blob.type, 'application/pdf');
});

test('downloadDriveFile: 5xxはDriveTransientError', async () => {
    stubDownloadFetch(() => new Response('{}', { status: 500 }));
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});

test('downloadDriveFile: ネットワーク例外はDriveTransientError', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    await assert.rejects(
        () => downloadDriveFile('file-1'),
        (error: unknown) => error instanceof DriveTransientError
    );
});
