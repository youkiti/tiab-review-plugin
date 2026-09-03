import test from 'node:test';
import assert from 'node:assert/strict';
import { getFulltextPageData } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// PR #146 レビュー指摘: getFulltextPageData() は parseReferenceValues() の結果をフィルタせずに
// 返していたため、duplicate_of を設定した（論理削除済みの）文献がフルテキスト候補一覧と
// ページ内移動に残り、判定まで保存できてしまっていた。この回帰を固定する。
// 通常経路（batchGet 成功）と、Config タブが無い旧シート向けのフォールバック経路の両方で
// 同じ挙動になることを別テストで固定する（フォールバック経路を直し忘れやすいことが
// 今回の修正の要点であるため）。
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

const spreadsheetId = 'sheet-dup-1';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

const REFERENCES_HEADER = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
    'fulltext_drive_source_id', 'fulltext_drive_copy_id',
    'record_type', 'related_ref_id',
    'duplicate_of',
];

const DECISIONS_HEADER = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
    'context_json',
];

/** ref_id 以外は空欄でよいので、duplicate_of（末尾列）だけを指定してヘッダー幅の行を組み立てる */
function referenceRow(refId: string, duplicateOf: string): string[] {
    const row = new Array(REFERENCES_HEADER.length).fill('');
    row[0] = refId;
    row[REFERENCES_HEADER.length - 1] = duplicateOf;
    return row;
}

const referencesValues = [
    REFERENCES_HEADER,
    referenceRow('ref1', ''),        // 生きている行
    referenceRow('ref2', 'ref1'),    // ref1 の重複として論理削除済み
    referenceRow('ref3', ''),        // 生きている行
];

// ---------------------------------------------------------------------------
// 通常経路（Config タブあり、values:batchGet が1回で成功する）
// ---------------------------------------------------------------------------

test('getFulltextPageData: 通常経路（Config タブあり）で duplicate_of 非空の行が references から除外される', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/values:batchGet')) {
            const requestUrl = new URL(url);
            const ranges = requestUrl.searchParams.getAll('ranges');
            const valueRanges = ranges.map((range) => {
                if (range === 'References!A:AA') return { values: referencesValues };
                if (range === 'Decisions!A:L') return { values: [DECISIONS_HEADER] };
                if (range === 'Config!A:B') return { values: [] };
                throw new Error(`Unhandled mock batchGet range: ${range}`);
            });
            return new Response(JSON.stringify({ valueRanges }), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${url}`);
    }) as typeof fetch;

    const { references } = await getFulltextPageData(spreadsheetId, 'alice@example.com');

    const refIds = references.map((r) => r.ref_id).sort();
    assert.deepEqual(refIds, ['ref1', 'ref3'], '論理削除済みの ref2 が除外され、生きている行だけが残ること');
});

// ---------------------------------------------------------------------------
// フォールバック経路（Config タブが無い旧シート。batchGet 全体が失敗し、
// References/Decisions のみの batchGet へ再試行する）
// ---------------------------------------------------------------------------

test('getFulltextPageData: Config タブ欠落のフォールバック経路でも duplicate_of 非空の行が除外される', async () => {
    let batchGetCallCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/values:batchGet')) {
            batchGetCallCount += 1;
            const requestUrl = new URL(url);
            const ranges = requestUrl.searchParams.getAll('ranges');

            // 1回目（References + Decisions + Config の3レンジ）は Config タブが無い旧シートを
            // 模して失敗させる。Sheets API の実エラー文言（"Unable to parse range: ..."）を返す。
            if (ranges.includes('Config!A:B')) {
                return new Response(
                    JSON.stringify({ error: { message: 'Unable to parse range: Config!A:B' } }),
                    { status: 400 }
                );
            }

            // 2回目（フォールバック: References + Decisions の2レンジ）は成功させる
            const valueRanges = ranges.map((range) => {
                if (range === 'References!A:AA') return { values: referencesValues };
                if (range === 'Decisions!A:L') return { values: [DECISIONS_HEADER] };
                throw new Error(`Unhandled mock batchGet range: ${range}`);
            });
            return new Response(JSON.stringify({ valueRanges }), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${url}`);
    }) as typeof fetch;

    const { references } = await getFulltextPageData(spreadsheetId, 'alice@example.com');

    assert.equal(batchGetCallCount, 2, '1回目の失敗後、フォールバック経路として2回目の batchGet が呼ばれること');
    const refIds = references.map((r) => r.ref_id).sort();
    assert.deepEqual(refIds, ['ref1', 'ref3'], 'フォールバック経路でも論理削除済みの ref2 が除外されること');
});
