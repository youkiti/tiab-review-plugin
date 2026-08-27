import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureHeaders, REFERENCES_HEADERS } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// ensureHeaders() の References ブロックが、W/X列（fulltext_drive_source_id/
// fulltext_drive_copy_id）をユーザーが既に独自ヘッダー名で使っている場合に
// ヘッダー行を書き換えない（＝ユーザーの列名を改名しない）ことを検証する。
//
// 背景（PR #105 実機確認で発覚）: ensureHeaders は「References のヘッダーが
// REFERENCES_HEADERS.length 未満なら A1:Z1 をヘッダー定義で丸ごと上書き」
// する実装だったため、ユーザーが独自列を1本だけ（23列）足しているシートでは
// W1 のユーザー独自名を fulltext_drive_source_id に無警告で改名し、直後の
// ensureFulltextDriveColumnsOnce() の検証を素通りして、以後 W列へ source ID を
// 書き込んでユーザーのデータを上書きしてしまっていた。
//
// Issue #118 チャンク1で record_type/related_ref_id を末尾に追加し、
// REFERENCES_HEADERS.length は 24 → 26 になった（=24 だった頃の当テストの前提も追従済み）。

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

test('26列で既に正しく移行済み: currentHeaders.length < REFERENCES_HEADERS.length が偽なので何も書かない（既存挙動）', async () => {
    const puts = installEnsureHeadersMock([
        ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
        'record_type', 'related_ref_id',
    ]);

    await ensureHeaders('sheet-d');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, '既に26列なら拡張ロジック自体に入らない');
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

// ---------------------------------------------------------------------------
// レビュー指摘対応: ensureHeaders() の References ヘッダー行範囲（読み取り・書き込み）が
// `A1:Z1` 直書きではなく REFERENCES_HEADERS.length から導出されていることの回帰テスト。
// 26列がちょうどZ列なのは偶然で、直書きに戻すと次に列を1本足して27列になった瞬間、
// (1) 読み取りが打ち切られて毎回ヘッダーPUTを発行し続け、
// (2) 27要素の行をA:Z（26列）の範囲へ書き込もうとしてSheets APIがエラーを返す、
// という2つの事故が同時に起きる。
// columnLetter() は sheets-api.ts の非公開ヘルパーのため、ここでは検証専用に同じアルゴリズムを
// 複製する（sheets-api.ts 側の実装を変更したら、このミラーも追従させること）。
// ---------------------------------------------------------------------------

function columnLetterMirror(index: number): string {
    let n = index;
    let letters = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

test('columnLetterMirror: 26列はZ、27列はAAになる（境界確認）', () => {
    assert.equal(columnLetterMirror(26), 'Z');
    assert.equal(columnLetterMirror(27), 'AA');
});

test('22列の旧シート: ヘッダー行PUTのrangeがREFERENCES_HEADERS.lengthから導出した列（現状26列=Z列）になり、書き込む行の要素数もそれと一致する', async () => {
    const expectedLastColumn = columnLetterMirror(REFERENCES_HEADERS.length);
    assert.equal(expectedLastColumn, 'Z', '現時点のREFERENCES_HEADERS.length(=26)の前提が崩れていないことの確認');

    const puts = installEnsureHeadersMock([...OLD_HEADERS_22]);

    await ensureHeaders('sheet-f');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 1, 'References のヘッダー行 PUT が1回発行されること');

    const encodedRange = `/values/References!A1%3A${expectedLastColumn}1`;
    assert.ok(
        refPuts[0].url.includes(encodedRange),
        `PUTのrangeが REFERENCES_HEADERS.length から導出した列（${expectedLastColumn}）になっていること: ${refPuts[0].url}`
    );

    const writtenRow = refPuts[0].body.values[0];
    assert.equal(
        writtenRow.length,
        REFERENCES_HEADERS.length,
        '書き込む行の要素数がREFERENCES_HEADERS.length（=range の列数）と一致すること'
    );
});
