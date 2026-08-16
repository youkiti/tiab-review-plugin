import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getReferenceFulltextState,
    getFulltextClaimsSnapshot,
    updateReferenceFulltextUrls,
    invalidateFulltextDriveColumnsMemo,
} from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { FulltextUrlUpdateEntry } from '../src/lib/fulltext-drive-write';

// Issue #73 Phase 2（データ層チャンク）のデータ層テスト。
// - getReferenceFulltextState: values:batchGet を1回だけ呼ぶこと、行対応の正しさ、
//   末尾の空セル・旧22列ヘッダーのシートで落ちないこと（戻り値は対象行の状態のみ。
//   bySourceId は使わないため組み立てない。逆引きマップの検証は getFulltextClaimsSnapshot 側）
// - updateReferenceFulltextUrls: 実際に送る HTTP body（data のレンジ構成）の検証、
//   ensureFulltextDriveColumnsOnce() のメモ化（usable=true は2回目以降ヘッダー系読み取りが
//   増えないこと。usable=false はキャッシュされず毎回再判定されること）
//
// fetch モックの方式は tests/decision-history.test.ts を踏襲する。

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
    invalidateFulltextDriveColumnsMemo();
});

// ---------------------------------------------------------------------------
// getReferenceFulltextState
// ---------------------------------------------------------------------------

interface BatchGetMockCall { method: string; url: string; }

/** getReferenceFulltextState 専用の軽量モック: values:batchGet(A:A, T:X) のみ扱う */
function installBatchGetMock(idColumnRows: string[][], twxRows: string[][]): BatchGetMockCall[] {
    const calls: BatchGetMockCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        calls.push({ method: 'GET', url });

        if (url.includes('/values:batchGet')) {
            const requestUrl = new URL(url);
            const ranges = requestUrl.searchParams.getAll('ranges');
            const valueRanges = ranges.map((range) => {
                if (range === 'References!A:A') return { values: idColumnRows };
                if (range === 'References!T:X') return { values: twxRows };
                throw new Error(`Unhandled mock batchGet range: ${range}`);
            });
            return new Response(JSON.stringify({ valueRanges }), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${url}`);
    }) as typeof fetch;
    return calls;
}

test('getReferenceFulltextState: values:batchGet を1回だけ呼ぶこと', async () => {
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['https://drive.google.com/file/d/copy-1/view', 'cached', '', 'source-1', 'copy-1'],
        ['', 'not_retrieved', '', '', ''],
    ];
    const calls = installBatchGetMock(idColumnRows, twxRows);

    await getReferenceFulltextState('sheet-a', 'ref1');

    const batchGetCalls = calls.filter((c) => c.url.includes('/values:batchGet'));
    assert.equal(batchGetCalls.length, 1);
});

test('getReferenceFulltextState: 行対応が正しく target に反映される', async () => {
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2'], ['ref3']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'source-1', 'copy-1'],
        ['url2', 'retrieved', '', 'source-2', 'copy-2'],
        ['', 'not_retrieved', '', '', ''],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const result = await getReferenceFulltextState('sheet-a', 'ref2');

    assert.deepEqual(result, {
        status: 'retrieved', url: 'url2', sourceFileId: 'source-2', copyFileId: 'copy-2',
    });
});

test('getReferenceFulltextState: 対象行が見つからない場合 undefined（従来契約の維持）', async () => {
    const idColumnRows = [['ref_id'], ['ref1']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'source-1', 'copy-1'],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const result = await getReferenceFulltextState('sheet-a', 'ref-not-exist');

    assert.equal(result, undefined);
});

test('getReferenceFulltextState: 末尾の空セル（Sheets が省いて返す短い行）でも落ちない', async () => {
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2']];
    // ref2 の行は T:X が全て空のため、Sheets の実挙動どおり末尾セルが省かれた短い配列として返る
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'source-1', 'copy-1'],
        [], // ref2: 完全に空（末尾トリムされた結果、要素が1つも無い）
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const result = await getReferenceFulltextState('sheet-a', 'ref2');

    assert.deepEqual(result, {
        status: 'not_retrieved', url: '', sourceFileId: '', copyFileId: '',
    });
});

test('getReferenceFulltextState: A:A より T:X の方が短い配列で返ってきても落ちない（行自体が欠落）', async () => {
    // idColumn には ref3 まであるが、T:X 側は ref2 相当の行までしか返ってこない
    // （Sheets は対象範囲内で完全に空の末尾行をまるごと省く）
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2'], ['ref3']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'source-1', 'copy-1'],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const result = await getReferenceFulltextState('sheet-a', 'ref3');

    assert.deepEqual(result, {
        status: 'not_retrieved', url: '', sourceFileId: '', copyFileId: '',
    });
});

test('getReferenceFulltextState: 旧22列ヘッダーのシート（W/X が存在しない）では sourceFileId/copyFileId が空になる', async () => {
    const idColumnRows = [['ref_id'], ['ref1']];
    // 旧シートは V列（fulltext_set）までしか存在しないため、T:X の読み取りでも3列しか返らない
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set'],
        ['url1', 'cached', ''],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const result = await getReferenceFulltextState('sheet-a', 'ref1');

    assert.deepEqual(result, {
        status: 'cached', url: 'url1', sourceFileId: '', copyFileId: '',
    });
});

// ---------------------------------------------------------------------------
// getFulltextClaimsSnapshot（Picker選択直後の再取得用。行スキャンはgetReferenceFulltextStateと共通化）
// ---------------------------------------------------------------------------

test('getFulltextClaimsSnapshot: values:batchGet を1回だけ呼ぶこと', async () => {
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2'], ['ref3']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'shared-source', 'copy-1'],
        ['url2', 'cached', '', 'shared-source', 'copy-2'],
        ['url3', 'cached', '', 'other-source', 'copy-3'],
    ];
    const calls = installBatchGetMock(idColumnRows, twxRows);

    const snapshot = await getFulltextClaimsSnapshot('sheet-a');

    const batchGetCalls = calls.filter((c) => c.url.includes('/values:batchGet'));
    assert.equal(batchGetCalls.length, 1);
    assert.equal(snapshot.bySourceId.get('shared-source')?.length, 2);
    assert.equal(snapshot.bySourceId.get('other-source')?.length, 1);
});

test('getFulltextClaimsSnapshot: bySourceId は同一 source ID の複数クレームを配列で保持する', async () => {
    // getReferenceFulltextState は対象行の状態しか返さなくなったため（bySourceId は組み立てない）、
    // この逆引きマップの詳細検証は唯一 bySourceId を返す getFulltextClaimsSnapshot 側で行う。
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2'], ['ref3']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        ['url1', 'cached', '', 'shared-source', 'copy-1'],
        ['url2', 'cached', '', 'shared-source', 'copy-2'],
        ['url3', 'cached', '', 'other-source', 'copy-3'],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const snapshot = await getFulltextClaimsSnapshot('sheet-a');

    const claims = snapshot.bySourceId.get('shared-source');
    assert.ok(claims);
    assert.equal(claims!.length, 2, '同一 source ID を持つ2文献分のクレームが両方保持されること');
    const byRefId = new Map(claims!.map((c) => [c.refId, c]));
    assert.deepEqual(byRefId.get('ref1'), { refId: 'ref1', copyId: 'copy-1', status: 'cached', url: 'url1' });
    assert.deepEqual(byRefId.get('ref2'), { refId: 'ref2', copyId: 'copy-2', status: 'cached', url: 'url2' });
    assert.equal(snapshot.bySourceId.get('other-source')?.length, 1);
});

test('getFulltextClaimsSnapshot: byRefId はW/X列が空の行も含め全行を対象にする（退行防止: 本Issue修正前に取り込まれた既存ファイル対策）', async () => {
    // すなわち byRefId は bySourceId 由来ではなく、行スキャン自体から独立に全行ぶん組み立てられる
    // ことを検証する（bySourceId は sourceFileId が空の行を除外するため、それ由来では作れない）。
    const idColumnRows = [['ref_id'], ['ref1'], ['ref2']];
    const twxRows = [
        ['fulltext_url', 'fulltext_status', 'fulltext_set', 'fulltext_drive_source_id', 'fulltext_drive_copy_id'],
        // ref1: 本Issue修正前にDrive取り込み済み。W/X列は空のまま（旧版クライアントの書き込み）
        ['https://drive.google.com/file/d/legacy-copy/view', 'cached', '', '', ''],
        // ref2: W/X列ありの新形式
        ['url2', 'cached', '', 'source-2', 'copy-2'],
    ];
    installBatchGetMock(idColumnRows, twxRows);

    const snapshot = await getFulltextClaimsSnapshot('sheet-a');

    assert.deepEqual(snapshot.byRefId.get('ref1'), {
        status: 'cached', url: 'https://drive.google.com/file/d/legacy-copy/view', sourceFileId: '', copyFileId: '',
    });
    assert.deepEqual(snapshot.byRefId.get('ref2'), {
        status: 'cached', url: 'url2', sourceFileId: 'source-2', copyFileId: 'copy-2',
    });
    // bySourceId には W/X が空の ref1 は登場しない（クレーム扱いされない）
    assert.equal(snapshot.bySourceId.has(''), false);
});

// ---------------------------------------------------------------------------
// updateReferenceFulltextUrls
// ---------------------------------------------------------------------------

const REFERENCES_HEADERS_ROW = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
    'fulltext_drive_source_id', 'fulltext_drive_copy_id',
];

const DECISIONS_HEADERS_ROW = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
];

interface UpdateMockState {
    referencesHeaderRow: string[];
    decisionsHeaderRow: string[];
    idColumnRows: string[][];
    calls: { method: string; url: string }[];
    batchUpdateBodies: any[];
}

function createUpdateMockState(overrides?: Partial<UpdateMockState>): UpdateMockState {
    return {
        referencesHeaderRow: [...REFERENCES_HEADERS_ROW],
        decisionsHeaderRow: [...DECISIONS_HEADERS_ROW],
        idColumnRows: [['ref_id'], ['ref1'], ['ref2'], ['ref3']],
        calls: [],
        batchUpdateBodies: [],
        ...overrides,
    };
}

function installUpdateMock(mockState: UpdateMockState) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        mockState.calls.push({ method, url });

        if (method === 'GET' && url.includes('/values/References!A1%3AZ1')) {
            return new Response(JSON.stringify({ values: [mockState.referencesHeaderRow] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/References!A1%3AX1')) {
            return new Response(JSON.stringify({ values: [mockState.referencesHeaderRow] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/Decisions!A1%3AZ1')) {
            return new Response(JSON.stringify({ values: [mockState.decisionsHeaderRow] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/References!A%3AA')) {
            return new Response(JSON.stringify({ values: mockState.idColumnRows }), { status: 200 });
        }
        if (method === 'POST' && url.includes('/values:batchUpdate')) {
            const body = JSON.parse((init!.body as string));
            mockState.batchUpdateBodies.push(body);
            return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;
}

function countCalls(mockState: UpdateMockState, matcher: (url: string) => boolean, method?: string): number {
    return mockState.calls.filter((c) => (!method || c.method === method) && matcher(c.url)).length;
}

test('updateReferenceFulltextUrls: 送信する HTTP body の data がT:UとW:Xの非連続レンジで構成される', async () => {
    const mockState = createUpdateMockState();
    installUpdateMock(mockState);

    const updates: FulltextUrlUpdateEntry[] = [
        {
            refId: 'ref1',
            fulltextUrl: 'https://drive.google.com/file/d/copy-1/view',
            status: 'cached',
            driveSource: { sourceFileId: 'source-1', copyFileId: 'copy-1' },
        },
        {
            refId: 'ref3',
            fulltextUrl: '',
            status: 'not_retrieved',
            driveSource: null,
        },
    ];

    await updateReferenceFulltextUrls('sheet-update-1', updates);

    assert.equal(mockState.batchUpdateBodies.length, 1, 'batchUpdate は1回だけ呼ばれること');
    const body = mockState.batchUpdateBodies[0];
    assert.equal(body.valueInputOption, 'RAW');
    assert.equal(body.data.length, 4, '2エントリ × (T:U, W:X) = 4件');

    const byRange = new Map(body.data.map((d: any) => [d.range, d.values]));
    assert.deepEqual(byRange.get('References!T2:U2'), [['https://drive.google.com/file/d/copy-1/view', 'cached']]);
    assert.deepEqual(byRange.get('References!W2:X2'), [['source-1', 'copy-1']]);
    assert.deepEqual(byRange.get('References!T4:U4'), [['', 'not_retrieved']]);
    assert.deepEqual(byRange.get('References!W4:X4'), [['', '']], 'driveSource: null は W/X を空文字でクリアすること');

    // V列（fulltext_set）に触れるレンジが無いこと
    for (const range of byRange.keys()) {
        assert.ok(!String(range).includes('V'), `V列を含むレンジが送られた: ${range}`);
    }
});

test('updateReferenceFulltextUrls: ensureFulltextDriveColumnsOnce はメモ化され、2回目以降はヘッダー系読み取りが増えない', async () => {
    const mockState = createUpdateMockState();
    installUpdateMock(mockState);

    await updateReferenceFulltextUrls('sheet-update-2', [
        { refId: 'ref1', fulltextUrl: 'u1', status: 'cached', driveSource: null },
    ]);
    const headerReadsAfterFirst = countCalls(mockState, (u) => u.includes('References!A1%3AZ1'), 'GET')
        + countCalls(mockState, (u) => u.includes('References!A1%3AX1'), 'GET')
        + countCalls(mockState, (u) => u.includes('Decisions!A1%3AZ1'), 'GET');
    assert.equal(headerReadsAfterFirst, 3, '初回はReferences/Decisionsのヘッダー読み取り+検証読み取りで3回');

    await updateReferenceFulltextUrls('sheet-update-2', [
        { refId: 'ref2', fulltextUrl: 'u2', status: 'cached', driveSource: null },
    ]);
    const headerReadsAfterSecond = countCalls(mockState, (u) => u.includes('References!A1%3AZ1'), 'GET')
        + countCalls(mockState, (u) => u.includes('References!A1%3AX1'), 'GET')
        + countCalls(mockState, (u) => u.includes('Decisions!A1%3AZ1'), 'GET');
    assert.equal(headerReadsAfterSecond, 3, '2回目の呼び出しではメモ化によりヘッダー系読み取りが増えないこと');

    assert.equal(mockState.batchUpdateBodies.length, 2, 'batchUpdate自体は毎回呼ばれること');
});

test('updateReferenceFulltextUrls: W/X列が別用途と衝突していても driveSource が全件 null なら T:U だけ書いて成功する（退行防止）', async () => {
    const mockState = createUpdateMockState({
        referencesHeaderRow: [
            ...REFERENCES_HEADERS_ROW.slice(0, 22),
            'my_custom_column', 'another_custom_column',
        ],
    });
    installUpdateMock(mockState);
    const warnCalls: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnCalls.push(args); };

    try {
        // OA検索・手動アップロード等はDrive直接取り込みではないため driveSource は必ず null。
        // W/X列がユーザー独自列と衝突していても、これらの経路まで丸ごと失敗させてはならない。
        await updateReferenceFulltextUrls('sheet-update-3', [
            { refId: 'ref1', fulltextUrl: 'u1', status: 'cached', driveSource: null },
            { refId: 'ref3', fulltextUrl: '', status: 'not_retrieved', driveSource: null },
        ]);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(mockState.batchUpdateBodies.length, 1, 'batchUpdate は例外にならず呼ばれること');
    const body = mockState.batchUpdateBodies[0];
    assert.equal(body.data.length, 2, 'T:U のみ（W:X は1件も含まれない）');
    for (const update of body.data) {
        assert.ok(!String(update.range).includes('W'), `W列を含むレンジが送られた: ${update.range}`);
        assert.ok(!String(update.range).includes('X'), `X列を含むレンジが送られた: ${update.range}`);
    }
    const byRange = new Map(body.data.map((d: any) => [d.range, d.values]));
    assert.deepEqual(byRange.get('References!T2:U2'), [['u1', 'cached']]);
    assert.deepEqual(byRange.get('References!T4:U4'), [['', 'not_retrieved']]);
    assert.ok(warnCalls.length >= 1, 'スキップした旨を console.warn で1回ログすること');
});

test('updateReferenceFulltextUrls: W/X列が別用途と衝突していて driveSource が非null（Drive直接取り込み）を含む場合は例外になり何も書き込まれない', async () => {
    const mockState = createUpdateMockState({
        referencesHeaderRow: [
            ...REFERENCES_HEADERS_ROW.slice(0, 22),
            'my_custom_column', 'another_custom_column',
        ],
    });
    installUpdateMock(mockState);

    await assert.rejects(
        updateReferenceFulltextUrls('sheet-update-4', [
            {
                refId: 'ref1',
                fulltextUrl: 'https://drive.google.com/file/d/copy-1/view',
                status: 'cached',
                driveSource: { sourceFileId: 'source-1', copyFileId: 'copy-1' },
            },
        ])
    );

    assert.equal(mockState.batchUpdateBodies.length, 0, 'Drive直接取り込みはクレームを記録できないため、fail-fastで何も書き込まれないこと');
});

test('updateReferenceFulltextUrls: usable=false（W/X衝突）はメモ化されず、2回目も同じだけヘッダー系読み取りが走る', async () => {
    // 指摘4の回帰修正: usable=false をキャッシュすると、ユーザーがエラーメッセージの指示どおり
    // シートの列名を直しても拡張機能を再読み込みするまで反映されない。usable=false は
    // 毎回再判定されるべき（usable=true のときだけ2回目以降の読み取りが増えない従来挙動を維持する）。
    const mockState = createUpdateMockState({
        referencesHeaderRow: [
            ...REFERENCES_HEADERS_ROW.slice(0, 22),
            'my_custom_column', 'another_custom_column',
        ],
    });
    installUpdateMock(mockState);
    const originalWarn = console.warn;
    console.warn = () => {};

    const countHeaderReads = () =>
        countCalls(mockState, (u) => u.includes('References!A1%3AZ1'), 'GET')
        + countCalls(mockState, (u) => u.includes('References!A1%3AX1'), 'GET')
        + countCalls(mockState, (u) => u.includes('Decisions!A1%3AZ1'), 'GET');

    try {
        // OA経路（driveSource=null）は衝突していても T:U だけ書いて成功する
        await updateReferenceFulltextUrls('sheet-update-5', [
            { refId: 'ref1', fulltextUrl: 'u1', status: 'cached', driveSource: null },
        ]);
        const afterFirst = countHeaderReads();
        assert.equal(afterFirst, 3, '初回はReferences/Decisionsのヘッダー読み取り+検証読み取りで3回');

        await updateReferenceFulltextUrls('sheet-update-5', [
            { refId: 'ref2', fulltextUrl: 'u2', status: 'cached', driveSource: null },
        ]);
        const afterSecond = countHeaderReads();
        assert.equal(afterSecond, 6, 'usable=false はキャッシュされず、2回目も1回目と同じ回数だけヘッダー系読み取りが走ること（正常系のメモ化と対照的）');
    } finally {
        console.warn = originalWarn;
    }
});
