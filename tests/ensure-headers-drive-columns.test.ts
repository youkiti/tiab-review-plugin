import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureHeaders, REFERENCES_HEADERS, validateReferencesManagedHeaders } from '../src/lib/sheets-api';
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
// Issue #145 チャンク2で duplicate_of をさらに末尾に追加し、26 → 27（AA列）になった
// （このファイルの「26列=移行済み」を前提としたフィクスチャ・アサーションも追従済み）。

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

        if (method === 'GET' && url.includes('/values/References!A1%3AAA1')) {
            return new Response(JSON.stringify({ values: [referencesHeaderRow] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/Decisions!A1%3AZ1')) {
            return new Response(JSON.stringify({ values: [decisionsHeaderRow] }), { status: 200 });
        }
        if (method === 'PUT' && url.includes('/values/References!A1%3AAA1')) {
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
    return puts.filter((p) => p.url.includes('/values/References!A1%3AAA1'));
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

test('27列で既に正しく移行済み: currentHeaders.length < REFERENCES_HEADERS.length が偽なので何も書かない（既存挙動）', async () => {
    const puts = installEnsureHeadersMock([
        ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
        'record_type', 'related_ref_id', 'duplicate_of',
    ]);

    await ensureHeaders('sheet-d');

    const refPuts = referencesPuts(puts);
    assert.equal(refPuts.length, 0, '既に27列（duplicate_of まで揃っている）なら拡張ロジック自体に入らない');
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

test('22列の旧シート: ヘッダー行PUTのrangeがREFERENCES_HEADERS.lengthから導出した列（現状27列=AA列）になり、書き込む行の要素数もそれと一致する', async () => {
    const expectedLastColumn = columnLetterMirror(REFERENCES_HEADERS.length);
    assert.equal(expectedLastColumn, 'AA', '現時点のREFERENCES_HEADERS.length(=27)の前提が崩れていないことの確認');

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

// ---------------------------------------------------------------------------
// PR #121 レビュー指摘対応: record_type/related_ref_id（Y/Z列）追加により
// REFERENCES_HEADERS.length が 24→26 になったことで、W/X限定だった旧検証
// （validateFulltextDriveHeaders）ではY/Z列のユーザー独自名との衝突を検出できず、
// 25列シート・26列シートの双方で無警告改名が再発する穴があった。
// 一般化した validateReferencesManagedHeaders / ensureHeaders 側の修正がこの穴を
// 塞いでいることを確認する。
// ---------------------------------------------------------------------------

/** console.warn を差し替えて呼び出し引数を捕捉する。テスト終了時に必ず元へ戻すこと。 */
function captureConsoleWarn(): { calls: unknown[][]; restore: () => void } {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => { calls.push(args); };
    return { calls, restore: () => { console.warn = original; } };
}

test('25列でY1がユーザー独自名（W/Xは正規名のまま）: References のヘッダー行 PUT が発行されない', async () => {
    // 25列（22列の安定プレフィックス + W/X正規名 + ユーザー独自の25列目）は
    // currentHeaders.length(25) < REFERENCES_HEADERS.length（当時26、Issue #145 チャンク2で
    // duplicate_of が加わった現在は27）のいずれでも「不足」分岐に入る。
    // 旧検証（W/X限定）はここを素通りしてしまい、ヘッダー行を丸ごとPUTしてユーザーの25列目
    // （my_memo）を無警告で record_type に改名してしまっていた。
    const warn = captureConsoleWarn();
    try {
        const puts = installEnsureHeadersMock([
            ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id', 'my_memo',
        ]);

        await ensureHeaders('sheet-g');

        const refPuts = referencesPuts(puts);
        assert.equal(refPuts.length, 0, 'ユーザー独自の25列目（Y1）ヘッダー名を改名してはいけない');
    } finally {
        warn.restore();
    }
});

test('27列でY/Z/AAがユーザー独自名: References のヘッダー行 PUT が発行されず、かつ警告が出る', async () => {
    // このテストの存在理由は「列数が REFERENCES_HEADERS.length と一致して本来なら
    // 『移行済み』分岐に入るケースでも、managedHeaderCheck による検証は列数に関わらず常に走る」
    // ことの固定（旧実装ではここが一切走らず、ユーザーがY/Z列を独自用途で使っていても気づく
    // 手段が無かった。PR #105 実機確認・Issue #118 で再発した経緯は本ファイル冒頭のコメント参照）。
    // Issue #145 チャンク2で duplicate_of（AA列）が加わり REFERENCES_HEADERS.length は27に
    // なったため、この「列数一致」分岐を通すフィクスチャも27列（Y/Z/AAの3列とも独自名）にする。
    const warn = captureConsoleWarn();
    try {
        const puts = installEnsureHeadersMock([
            ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
            'my_memo', 'my_tag', 'my_dup',
        ]);

        await ensureHeaders('sheet-h');

        const refPuts = referencesPuts(puts);
        assert.equal(refPuts.length, 0, '列数は一致している（27列）が、Y/Z/AAの衝突でPUTは発行されない');

        // 「何らかの console.warn が1回以上出た」だけでは、Referencesブロックと無関係な警告でも
        // 通ってしまい、この修正が守りたい挙動（Y/Z/AA列の衝突を検出して警告する）を固定できない。
        // メッセージが [ensureHeaders] References 由来であることまで絞り込んだうえで、
        // conflicts の中身（列・期待値・実際の値、Y→Z→AAの順）まで検証する。
        const referencesConflictWarnings = warn.calls.filter(
            (args) => typeof args[0] === 'string' && args[0].includes('[ensureHeaders]') && args[0].includes('References')
        );
        assert.equal(
            referencesConflictWarnings.length, 1,
            '「移行済みと黙って誤判定」せず、Referencesのヘッダー衝突警告がちょうど1回出ること'
        );
        const [message, detail] = referencesConflictWarnings[0];
        assert.ok(typeof message === 'string' && message.includes('[ensureHeaders]'));
        assert.deepEqual(
            detail,
            {
                conflicts: [
                    { column: 'Y', expected: 'record_type', actual: 'my_memo' },
                    { column: 'Z', expected: 'related_ref_id', actual: 'my_tag' },
                    { column: 'AA', expected: 'duplicate_of', actual: 'my_dup' },
                ],
            },
            '衝突したY列・Z列・AA列がすべて期待どおりconflictsに入っていること（実装どおりY→Z→AAの順）'
        );
    } finally {
        warn.restore();
    }
});

// ---------------------------------------------------------------------------
// レビュー指摘対応（指摘2）: 上のテストで「衝突しているときは警告する」ことを固定しても、
// 実装が「列数に関わらず常に警告を出す」もの（衝突の有無を見ていない誤実装）であっても
// 既存テスト群はPUT回数しか見ていないため全部通ってしまう。
// 「衝突していないときは警告しない」という負の対照を別テストとして追加し、
// 衝突の有無で警告するかどうかが実際に分岐していることを固定する。
// ---------------------------------------------------------------------------

test('27列すべて正規名: References のヘッダー行 PUT が発行されず、console.warn も呼ばれない（衝突なしの負の対照）', async () => {
    const warn = captureConsoleWarn();
    try {
        const puts = installEnsureHeadersMock([
            ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
            'record_type', 'related_ref_id', 'duplicate_of',
        ]);

        await ensureHeaders('sheet-i');

        const refPuts = referencesPuts(puts);
        assert.equal(refPuts.length, 0, '既に27列（duplicate_of まで揃っている）なら拡張ロジック自体に入らない（既存挙動）');
        assert.equal(warn.calls.length, 0, '衝突が無いのでReferencesのヘッダー衝突警告は出ないこと');
    } finally {
        warn.restore();
    }
});

test('22列の旧シート（拡張される正常系）: console.warn は呼ばれない', async () => {
    // 拡張ロジック自体が走り、PUTが1回発行される正常系。ここでも W列以降はすべて
    // 「未使用」（空文字扱い）なので衝突は起きないはずで、「拡張したのに警告も出す」
    // という誤実装を弾く。
    const warn = captureConsoleWarn();
    try {
        const puts = installEnsureHeadersMock([...OLD_HEADERS_22]);

        await ensureHeaders('sheet-j');

        const refPuts = referencesPuts(puts);
        assert.equal(refPuts.length, 1, 'References のヘッダー行 PUT が1回発行されること（既存挙動）');
        assert.equal(warn.calls.length, 0, '衝突が無いのでReferencesのヘッダー衝突警告は出ないこと');
    } finally {
        warn.restore();
    }
});

test('validateReferencesManagedHeaders: 26列すべて正規名なら ok=true・conflictsは空', () => {
    const headerRow = [
        ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
        'record_type', 'related_ref_id',
    ];
    const result = validateReferencesManagedHeaders(headerRow);
    assert.equal(result.ok, true);
    assert.deepEqual(result.conflicts, []);
});

test('validateReferencesManagedHeaders: 末尾が未使用（22列・24列の旧シート）なら ok=true', () => {
    // 22列（W列以降が丸ごと存在しない旧シート）と24列（W/Xまでは存在するがY/Zがまだ無い、
    // Y/Z追加前の旧シート）のどちらも「未使用」＝空文字として扱われ、衝突にはならないこと。
    // getSheetValues は末尾の空セルを省いて返す仕様のため、これらのケースは
    // headerRow がそもそも該当indexを持たない（undefined → trim後に空文字）という形で再現する。
    const header22 = [...OLD_HEADERS_22];
    const result22 = validateReferencesManagedHeaders(header22);
    assert.equal(result22.ok, true);
    assert.deepEqual(result22.conflicts, []);

    const header24 = [...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id'];
    const result24 = validateReferencesManagedHeaders(header24);
    assert.equal(result24.ok, true);
    assert.deepEqual(result24.conflicts, []);
});

test('validateReferencesManagedHeaders: Yのみユーザー独自名なら ok=false かつ conflictsにY列が入る', () => {
    const headerRow = [
        ...OLD_HEADERS_22, 'fulltext_drive_source_id', 'fulltext_drive_copy_id',
        'my_memo', 'related_ref_id',
    ];
    const result = validateReferencesManagedHeaders(headerRow);
    assert.equal(result.ok, false);
    assert.equal(result.conflicts.length, 1);
    assert.deepEqual(result.conflicts[0], { column: 'Y', expected: 'record_type', actual: 'my_memo' });
});
