import test from 'node:test';
import assert from 'node:assert/strict';
import {
    saveDecision,
    getDecisions,
    deleteFulltextAiRound,
    invalidateDecisionRowCache,
} from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision } from '../src/lib/types';

// saveDecision の判定保存クォータ削減（行番号キャッシュ）のユニットテスト。
// 連打時に「判定1件につき全件読み取り1回＋書き込み1回」となっていた不具合の回帰防止のため、
// 「hit（読み取り0回でupdate）」「absent（読み取り0回でappend、以後hit化）」
// 「TTL経過でcoldに戻る」「deleteFulltextAiRound後にcoldへ無効化される」を検証する。

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

const spreadsheetId = 'sheet-1';

const DECISIONS_HEADER = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
];

function toRow(d: Decision): string[] {
    return [
        d.decision_id,
        d.ref_id,
        d.reviewer_id,
        d.decision,
        d.reason || '',
        '', // labels
        d.note || '',
        d.decided_at,
        d.client_version || '',
        d.source_url || '',
        d.screening_phase || '',
    ];
}

interface MockCall {
    method: string;
    url: string;
}

interface MockState {
    decisionsValues: string[][]; // ヘッダー行込み
    nextAppendRow: number;       // 次にappendされる先頭のシート行番号（1始まり）
    calls: MockCall[];
}

function createMockState(initialDataRows: Decision[]): MockState {
    return {
        decisionsValues: [DECISIONS_HEADER, ...initialDataRows.map(toRow)],
        nextAppendRow: 2 + initialDataRows.length,
        calls: [],
    };
}

const DECISIONS_FULL_RANGE = encodeURIComponent('Decisions!A:K');
const CONFIG_RANGE = encodeURIComponent('Config!A:B');

const originalFetch = globalThis.fetch;

function installMockFetch(mockState: MockState) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        mockState.calls.push({ method, url });

        // 判定の新規追加（appendRows）
        if (method === 'POST' && url.includes('/values/Decisions:append')) {
            const body = JSON.parse((init!.body as string));
            const rows: string[][] = body.values;
            const firstRow = mockState.nextAppendRow;
            rows.forEach((row) => mockState.decisionsValues.push(row));
            mockState.nextAppendRow += rows.length;
            const lastRow = firstRow + rows.length - 1;
            return new Response(JSON.stringify({
                updates: { updatedRange: `Decisions!A${firstRow}:K${lastRow}` },
            }), { status: 200 });
        }

        // Decisions!A:K の全件読み取り（getDecisions / saveDecisionのcoldパス）
        if (method === 'GET' && url.includes(`/values/${DECISIONS_FULL_RANGE}`)) {
            return new Response(JSON.stringify({ values: mockState.decisionsValues }), { status: 200 });
        }

        // Config!A:B の読み取り（getFulltextAiActiveRound等）。設定なし扱いでよい。
        if (method === 'GET' && url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(JSON.stringify({ values: [] }), { status: 200 });
        }

        // 既存行の更新（updateRange）
        // encodeURIComponent は '!' をエスケープしないため、範囲は "Decisions!A5%3AK5" のような形になる
        if (method === 'PUT' && url.includes('/values/Decisions!A')) {
            const body = JSON.parse((init!.body as string));
            const pathname = new URL(url).pathname;
            const encodedRange = pathname.split('/values/')[1];
            const range = decodeURIComponent(encodedRange);
            const match = range.match(/A(\d+):K(\d+)/);
            if (match) {
                const rowIndex = parseInt(match[1], 10);
                mockState.decisionsValues[rowIndex - 1] = body.values[0];
            }
            return new Response(JSON.stringify({}), { status: 200 });
        }

        // シートID解決（deleteFulltextAiRound用）
        if (method === 'GET' && url.includes('fields=sheets.properties')) {
            return new Response(JSON.stringify({
                sheets: [{ properties: { title: 'Decisions', sheetId: 1 } }],
            }), { status: 200 });
        }

        // スプレッドシート単位のbatchUpdate（deleteDimensionによる行削除）
        if (method === 'POST' && /:batchUpdate$/.test(url) && !url.includes('/values')) {
            return new Response(JSON.stringify({}), { status: 200 });
        }

        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;
}

function countDecisionsFullReads(mockState: MockState): number {
    return mockState.calls.filter(
        (c) => c.method === 'GET' && c.url.includes(`/values/${DECISIONS_FULL_RANGE}`)
    ).length;
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateDecisionRowCache();
});

test('hit: 行番号がキャッシュ済みなら saveDecision は読み取りを発生させず updateRange のみ行う', async () => {
    const existing: Decision = {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId); // キャッシュを温める
    assert.equal(countDecisionsFullReads(mockState), 1);

    const updated: Decision = {
        ...existing,
        decision: 'exclude',
        reason: 'not relevant',
        decided_at: '2026-01-02T00:00:00Z',
    };
    await saveDecision(spreadsheetId, updated);

    assert.equal(countDecisionsFullReads(mockState), 1, 'hitのとき追加の全件読み取りは発生しないこと');
    const putCalls = mockState.calls.filter((c) => c.method === 'PUT');
    assert.equal(putCalls.length, 1);
    assert.match(putCalls[0].url, /Decisions!A2%3AK2/); // ヘッダーの次の行=2行目を更新
    const appendCalls = mockState.calls.filter((c) => c.method === 'POST' && c.url.includes(':append'));
    assert.equal(appendCalls.length, 0);
});

test('absent: 未知のキーは読み取りなしでappendされ、以後は同じキーがhitになる', async () => {
    const other: Decision = {
        decision_id: 'd1',
        ref_id: 'refX',
        reviewer_id: 'someone@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        screening_phase: 'tiab',
    };
    const mockState = createMockState([other]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId); // キャッシュを温める（ref2/bobはまだ含まれない）
    assert.equal(countDecisionsFullReads(mockState), 1);

    const newDecision: Decision = {
        decision_id: 'd2',
        ref_id: 'ref2',
        reviewer_id: 'bob@example.com',
        decision: 'include',
        decided_at: '2026-01-02T00:00:00Z',
        screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, newDecision);

    assert.equal(countDecisionsFullReads(mockState), 1, 'absentのとき読み取りは発生しないこと');
    assert.equal(
        mockState.calls.filter((c) => c.method === 'POST' && c.url.includes(':append')).length,
        1,
        '新規キーはappendで保存されること'
    );

    // 同じキーで再保存 → 今度はhitになりPUTが呼ばれる（追加のGET/appendは発生しない）
    const updatedAgain: Decision = {
        ...newDecision,
        note: 'updated',
        decided_at: '2026-01-03T00:00:00Z',
    };
    await saveDecision(spreadsheetId, updatedAgain);

    assert.equal(countDecisionsFullReads(mockState), 1, 'hit化した後も追加の全件読み取りは発生しないこと');
    assert.equal(
        mockState.calls.filter((c) => c.method === 'POST' && c.url.includes(':append')).length,
        1,
        '2回目はappendではなくupdateになること'
    );
    assert.equal(mockState.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('TTL経過後はcoldに戻り、saveDecisionが全件読み取りを再度行う', async () => {
    const existing: Decision = {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);
    assert.equal(countDecisionsFullReads(mockState), 1);

    const originalNow = Date.now;
    try {
        const future = originalNow() + 61_000; // TTL(60秒)を超過させる
        Date.now = () => future;

        const updated: Decision = {
            ...existing,
            decision: 'exclude',
            decided_at: '2026-01-02T00:00:00Z',
        };
        await saveDecision(spreadsheetId, updated);
    } finally {
        Date.now = originalNow;
    }

    assert.equal(countDecisionsFullReads(mockState), 2, 'TTL経過後はcoldとなり全件読み取りが再発生すること');
});

test('deleteFulltextAiRound後はキャッシュが無効化され、saveDecisionが全件読み取りを再度行う', async () => {
    const tiabDecision: Decision = {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        screening_phase: 'tiab',
    };
    const llmDecision: Decision = {
        decision_id: 'd2',
        ref_id: 'ref9',
        reviewer_id: 'llm:gemini@2026-01-01T00-00-00Z',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        screening_phase: 'fulltext',
    };
    const mockState = createMockState([tiabDecision, llmDecision]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId); // キャッシュを温める
    assert.equal(countDecisionsFullReads(mockState), 1);

    await deleteFulltextAiRound(spreadsheetId, 'llm:gemini@2026-01-01T00-00-00Z');
    // deleteFulltextAiRound内部でも対象行特定のため getDecisions を呼ぶので+1回読む
    assert.equal(countDecisionsFullReads(mockState), 2);

    const updated: Decision = {
        ...tiabDecision,
        decision: 'exclude',
        decided_at: '2026-01-02T00:00:00Z',
    };
    await saveDecision(spreadsheetId, updated);

    assert.equal(
        countDecisionsFullReads(mockState),
        3,
        '削除後はキャッシュが無効化され、saveDecisionが全件読み取りを再度行うこと'
    );
});
