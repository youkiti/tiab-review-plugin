import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureHeaders } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// ensureHeaders() の References ブロックが、W/X列（fulltext_drive_source_id/
// fulltext_drive_copy_id）をユーザーが既に独自ヘッダー名で使っている場合に
// ヘッダー行を書き換えない（＝ユーザーの列名を改名しない）ことを検証する。
//
// 背景（PR #105 実機確認で発覚）: ensureHeaders は「References のヘッダーが
// REFERENCES_HEADERS.length(=24) 未満なら A1:Z1 をヘッダー定義で丸ごと上書き」
// する実装だったため、ユーザーが独自列を1本だけ（23列）足しているシートでは
// W1 のユーザー独自名を fulltext_drive_source_id に無警告で改名し、直後の
// ensureFulltextDriveColumnsOnce() の検証を素通りして、以後 W列へ source ID を
// 書き込んでユーザーのデータを上書きしてしまっていた。

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

const OLD_HEADERS_22 = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
];

const DECISIONS_HEADERS_ROW = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
];

interface MockPut { method: string; url: string; body: any; }

/** ensureHeaders 専用の軽量モック: References/Decisions の A1:Z1 GET/PUT のみ扱う */
function installEnsureHeadersMock(
    referencesHeaderRow: string[],
    decisionsHeaderRow: string[] = DECISIONS_HEADERS_ROW
): MockPut[] {
    const puts: MockPut[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();

        if (method === 'GET' && url.includes('/values/References!A1%3AZ1')) {
            return new Response(JSON.stringify({ values: [referencesHeaderRow] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/Decisions!A1%3AZ1')) {
            return new Response(JSON.stringify({ values: [decisionsHeaderRow] }), { status: 200 });
        }
        if (method === 'PUT' && url.includes('/values/References!A1%3AZ1')) {
            const body = JSON.parse((init!.body as string));
            puts.push({ method, url, body });
            return new Response(JSON.stringify({}), { status: 200 });
        }
        if (method === 'PUT' && url.includes('/values/Decisions!A1%3AL1')) {
            const body = JSON.parse((init!.body as string));
            puts.push({ method, url, body });
            return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;
    return puts;
}

function referencesPuts(puts: MockPut[]): MockPut[] {
    return puts.filter((p) => p.url.includes('/values/References!A1%3AZ1'));
}

test('22列の旧シート: ヘッダー行が24列へ拡張される', async () => {
    const puts = installEnsureHeadersMock([...OLD_HEADERS_22]);

    await ensureHeaders('sheet-a');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 1, 'References のヘッダー行 PUT が1回発行されること');
    const writtenHeaders = refPuts[0].body.values[0];
    assert.ok(writtenHeaders.includes('fulltext_drive_source_id'));
    assert.ok(writtenHeaders.includes('fulltext_drive_copy_id'));
});

test('23列でW1がユーザー独自名: References のヘッダー行 PUT が発行されない', async () => {
    const puts = installEnsureHeadersMock([...OLD_HEADERS_22, 'my_memo']);

    await ensureHeaders('sheet-b');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, 'ユーザー独自のW1ヘッダー名を改名してはいけない');
    // Decisions 側の移行（11列 < DECISIONS_HEADERS.length なら発火しうる）は本テストの対象外。
    // ここでは References ブロックがスキップされても Decisions ブロックまで処理が到達すること
    // （関数が途中で return していないこと）だけを別途確認する。
});

test('24列でW/Xがユーザー独自名: References のヘッダー行 PUT が発行されない', async () => {
    const puts = installEnsureHeadersMock([...OLD_HEADERS_22, 'my_memo', 'my_tag']);

    await ensureHeaders('sheet-c');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, 'ユーザー独自のW/Xヘッダー名を改名してはいけない');
});

test('24列で既に正しく移行済み: currentHeaders.length < 24 が偽なので何も書かない（既存挙動）', async () => {
    const puts = installEnsureHeadersMock([
        ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
    ]);

    await ensureHeaders('sheet-d');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, '既に24列なら拡張ロジック自体に入らない');
});

test('23列でW1がユーザー独自名でも Decisions 側の移行処理は実行される', async () => {
    // Decisions ヘッダーを不足させ（10列 < DECISIONS_HEADERS.length=12）、
    // References 側がスキップされても Decisions 側の PUT が発行される＝
    // 関数が References ブロックの try/catch を抜けて後続処理へ到達していることを確認する。
    const shortDecisionsHeaders = DECISIONS_HEADERS_ROW.slice(0, 10);
    const puts = installEnsureHeadersMock([...OLD_HEADERS_22, 'my_memo'], shortDecisionsHeaders);

    await ensureHeaders('sheet-e');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, 'References 側は引き続きスキップされること');

    const decisionsPuts = puts.filter((p) => p.url.includes('/values/Decisions!A1%3AL1'));
    assert.equal(decisionsPuts.length, 1, 'Decisions 側の移行は References のスキップと独立して実行されること');
});
