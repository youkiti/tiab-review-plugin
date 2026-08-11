import test from 'node:test';
import assert from 'node:assert/strict';
import {
    saveDecision,
    getDecisions,
    getFulltextPageData,
    deleteFulltextAiRound,
    invalidateDecisionRowCache,
} from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision } from '../src/lib/types';

// Decisionsタブの追記専用化（チャンク1）の回帰テスト。
// - 畳み込み読み取り: 同一 (ref_id, reviewer_id, screening_phase) に複数の履歴行があっても、
//   getDecisions() / getFulltextPageData() は最新1行だけを返す（下流のUI・集計への影響ゼロ）
// - 追記専用書き込み: human判定 / ML手動確認判定は既存行があっても常にappendされる。
//   ML自動判定・LLM判定は従来どおりupsertされる（既存行があればupdate）
// - 同一内容スキップ: 直前に把握している内容と decision/reason/note が完全一致する場合は
//   保存自体をスキップし、誤タップ・連打による無意味な重複行を防ぐ
// - deleteFulltextAiRound: 対象ラウンドの履歴行を（同一キーの複数行を含め）1行残らず削除する
//
// collapseToLatestDecisions 等は非公開関数のため、ここでは公開API
// （getDecisions / saveDecision / getFulltextPageData / deleteFulltextAiRound）越しに検証する。
// fetch モックの方式は tests/decision-row-cache.test.ts を踏襲する。

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
    decisionsValues: string[][];   // Decisions ヘッダー行込み
    referencesValues: string[][];  // References（getFulltextPageData用。中身は使わないので空でよい）
    configValues: string[][];      // Config（同上）
    nextAppendRow: number;         // 次にappendされる先頭のシート行番号（1始まり）
    calls: MockCall[];
    sheetId: number;               // Decisionsタブの sheetId（deleteFulltextAiRound用）
}

function createMockState(initialDataRows: Decision[]): MockState {
    return {
        decisionsValues: [DECISIONS_HEADER, ...initialDataRows.map(toRow)],
        referencesValues: [],
        configValues: [],
        nextAppendRow: 2 + initialDataRows.length,
        calls: [],
        sheetId: 1,
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

        // References/Decisions/Config をまとめて取る batchGet（getFulltextPageData用）
        if (method === 'GET' && url.includes('/values:batchGet')) {
            const requestUrl = new URL(url);
            const ranges = requestUrl.searchParams.getAll('ranges');
            const valueRanges = ranges.map((range) => {
                if (range === 'References!A:V') return { values: mockState.referencesValues };
                if (range === 'Decisions!A:K') return { values: mockState.decisionsValues };
                if (range === 'Config!A:B') return { values: mockState.configValues };
                throw new Error(`Unhandled mock batchGet range: ${range}`);
            });
            return new Response(JSON.stringify({ valueRanges }), { status: 200 });
        }

        // Decisions!A:K の全件読み取り（getDecisions / saveDecisionのcoldパス / deleteFulltextAiRound）
        if (method === 'GET' && url.includes(`/values/${DECISIONS_FULL_RANGE}`)) {
            return new Response(JSON.stringify({ values: mockState.decisionsValues }), { status: 200 });
        }

        // Config!A:B の読み取り（getFulltextAiActiveRound等）。設定なし扱いでよい。
        if (method === 'GET' && url.includes(`/values/${CONFIG_RANGE}`)) {
            return new Response(JSON.stringify({ values: mockState.configValues }), { status: 200 });
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
                sheets: [{ properties: { title: 'Decisions', sheetId: mockState.sheetId } }],
            }), { status: 200 });
        }

        // スプレッドシート単位のbatchUpdate（deleteDimensionによる行削除）。
        // 実際のSheets APIと同様に、指定された startIndex（0始まり、ヘッダー込み）の行を
        // 実際に配列から取り除く。降順で来る前提だが、念のためこちらでも降順ソートしてから適用する。
        if (method === 'POST' && /:batchUpdate$/.test(url) && !url.includes('/values')) {
            const body = JSON.parse((init!.body as string));
            const deleteStartIndexes: number[] = (body.requests as any[])
                .filter((r) => r.deleteDimension)
                .map((r) => r.deleteDimension.range.startIndex as number)
                .sort((a, b) => b - a);
            for (const startIndex of deleteStartIndexes) {
                mockState.decisionsValues.splice(startIndex, 1);
            }
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

function countAppendCalls(mockState: MockState): number {
    return mockState.calls.filter((c) => c.method === 'POST' && c.url.includes(':append')).length;
}

function countUpdateCalls(mockState: MockState): number {
    return mockState.calls.filter((c) => c.method === 'PUT').length;
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateDecisionRowCache();
});

// ---------------------------------------------------------------------------
// 畳み込み（読み取り）
// ---------------------------------------------------------------------------

test('畳み込み: 同一キーに複数の履歴行があるとき decided_at が最新の1行だけが返る', async () => {
    const older: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const newer: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'not relevant', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([older, newer]);
    installMockFetch(mockState);

    const result = await getDecisions(spreadsheetId);

    assert.equal(result.length, 1, '同一キーの履歴行は1件に畳み込まれること');
    assert.equal(result[0].decision.decision_id, 'd2');
    assert.equal(result[0].decision.decision, 'exclude');
});

test('畳み込み: decided_at が同値の場合はシート上で後にある行（rowIndexが大きい行）が勝つ', async () => {
    const first: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const second: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'duplicate write', decided_at: '2026-01-01T00:00:00Z', // 同値
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([first, second]);
    installMockFetch(mockState);

    const result = await getDecisions(spreadsheetId);

    assert.equal(result.length, 1);
    assert.equal(result[0].decision.decision_id, 'd2', 'decided_at同値時はシート上で後の行が勝つこと');
});

test('畳み込み: screening_phase が tiab と fulltext の行は独立に保持される', async () => {
    const tiabRow: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const fulltextRow: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'ineligible design', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'fulltext',
    };
    const mockState = createMockState([tiabRow, fulltextRow]);
    installMockFetch(mockState);

    const result = await getDecisions(spreadsheetId);

    assert.equal(result.length, 2, 'tiab と fulltext は互いに畳み込みで消し合わないこと');
    const byPhase = new Map(result.map(({ decision }) => [decision.screening_phase, decision]));
    assert.equal(byPhase.get('tiab')?.decision, 'include');
    assert.equal(byPhase.get('fulltext')?.decision, 'exclude');
});

test('畳み込み: screening_phase 省略時は tiab 扱いとなり、明示的な tiab 行と同一キーへ畳み込まれる', async () => {
    const omittedPhase: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human',
        // screening_phase 省略
    };
    const explicitTiab: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'later revision', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([omittedPhase, explicitTiab]);
    installMockFetch(mockState);

    const result = await getDecisions(spreadsheetId);

    assert.equal(result.length, 1, '省略時のphaseは明示的なtiabと同一キーとして畳み込まれること');
    assert.equal(result[0].decision.decision_id, 'd2');
});

test('畳み込み: 返る rowIndex は採用された行の実際のシート行番号になっている', async () => {
    const unrelated: Decision = {
        decision_id: 'dX', ref_id: 'refX', reviewer_id: 'someone@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    }; // シート2行目 (header=1)
    const older: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    }; // シート3行目
    const winner: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'latest', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    }; // シート4行目 ← これが勝つ
    const mockState = createMockState([unrelated, older, winner]);
    installMockFetch(mockState);

    const result = await getDecisions(spreadsheetId);
    const mine = result.find(({ decision }) => decision.ref_id === 'ref1');

    assert.ok(mine);
    assert.equal(mine!.rowIndex, 4, '採用された行の実際のシート行番号（4行目）が返ること');
});

test('畳み込み: getFulltextPageData() が返す decisions も最新1行へ畳み込まれている', async () => {
    const older: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'fulltext',
    };
    const newer: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'full text ineligible', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'fulltext',
    };
    const mockState = createMockState([older, newer]);
    installMockFetch(mockState);

    const { decisions } = await getFulltextPageData(spreadsheetId, 'alice@example.com');

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision.decision_id, 'd2');
    assert.equal(decisions[0].decision.decision, 'exclude');
});

// ---------------------------------------------------------------------------
// 追記専用（書き込み）
// ---------------------------------------------------------------------------

test('human判定（-human）は既存行があっても常にappendされ、全件読み取りも発生しない', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId); // 行番号キャッシュ・内容スナップショットを温める
    assert.equal(countDecisionsFullReads(mockState), 1);

    const changed: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'reconsidered', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, changed);

    assert.equal(countDecisionsFullReads(mockState), 1, '追記専用パスは全件読み取りを発生させないこと');
    assert.equal(countUpdateCalls(mockState), 0, '既存行があっても update は呼ばれないこと');
    assert.equal(countAppendCalls(mockState), 1, '常に append で保存されること');
});

test('ML手動確認判定（-ml、-auto を含まない）も既存行があれば常にappendされる', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'ml-reviewer@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.7.0-ml', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);
    assert.equal(countDecisionsFullReads(mockState), 1);

    const changed: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'ml-reviewer@example.com',
        decision: 'exclude', reason: 'confirmed exclude', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-ml', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, changed);

    assert.equal(countDecisionsFullReads(mockState), 1);
    assert.equal(countUpdateCalls(mockState), 0);
    assert.equal(countAppendCalls(mockState), 1);
});

test('ML自動判定（-ml-auto）は従来どおりupsertされる（既存行があれば追記されずupdateされる）', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'ml-auto@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-ml-auto', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);
    assert.equal(countDecisionsFullReads(mockState), 1);

    const changed: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'ml-auto@example.com',
        decision: 'exclude', reason: 'model re-scored', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-ml-auto', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, changed);

    assert.equal(countDecisionsFullReads(mockState), 1, 'hitのとき追加の全件読み取りは発生しないこと');
    assert.equal(countUpdateCalls(mockState), 1, 'ML自動判定は既存行を update すること');
    assert.equal(countAppendCalls(mockState), 0, 'ML自動判定は追記されないこと');
});

test('human判定を include → exclude と変更すると2行残り、getDecisions() は exclude のみ返す', async () => {
    const mockState = createMockState([]);
    installMockFetch(mockState);

    const includeDecision: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, includeDecision);

    const excludeDecision: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'changed my mind', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, excludeDecision);

    assert.equal(mockState.decisionsValues.length, 3, 'ヘッダー1行 + 履歴2行がシートに残ること');
    assert.equal(countAppendCalls(mockState), 2);
    assert.equal(countUpdateCalls(mockState), 0);

    const result = await getDecisions(spreadsheetId);
    assert.equal(result.length, 1);
    assert.equal(result[0].decision.decision, 'exclude');
    assert.equal(result[0].decision.decision_id, 'd2');
});

// ---------------------------------------------------------------------------
// 同一内容スキップ
// ---------------------------------------------------------------------------

test('同一内容スキップ: getDecisions()でキャッシュを温めた後、decision/reason/noteが完全一致する保存はAPIを呼ばない', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);
    const callsAfterWarm = mockState.calls.length;

    const sameContent: Decision = {
        decision_id: 'd2', // decision_id・decided_at が違っても内容が同じならスキップ対象
        ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-03T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, sameContent);

    assert.equal(mockState.calls.length, callsAfterWarm, '同一内容の保存はAPIリクエストを一切発生させないこと');
});

test('同一内容スキップ: note だけが異なる場合はスキップされず追記される', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);

    const noteChanged: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', note: 'メモを追加', decided_at: '2026-01-03T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, noteChanged);

    assert.equal(countAppendCalls(mockState), 1, 'noteの差分だけでも追記されること');
});

test('同一内容スキップ: reason だけが異なる場合もスキップされず追記される', async () => {
    const existing: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'wrong population', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const mockState = createMockState([existing]);
    installMockFetch(mockState);

    await getDecisions(spreadsheetId);

    const reasonChanged: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'exclude', reason: 'wrong outcome', decided_at: '2026-01-03T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, reasonChanged);

    assert.equal(countAppendCalls(mockState), 1, 'reasonの差分だけでも追記されること');
});

test('同一内容スキップ: undefined と \'\' は同一視される（note省略時はスキップされる）', async () => {
    const mockState = createMockState([]);
    installMockFetch(mockState);

    const withEmptyNote: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', note: '', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    await saveDecision(spreadsheetId, withEmptyNote);
    assert.equal(countAppendCalls(mockState), 1);

    const withUndefinedNote: Decision = {
        decision_id: 'd2', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', note: undefined, decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const callsBeforeSecondSave = mockState.calls.length;
    await saveDecision(spreadsheetId, withUndefinedNote);

    assert.equal(
        mockState.calls.length,
        callsBeforeSecondSave,
        'note: \'\' と note: undefined は同一内容とみなされスキップされること'
    );
    assert.equal(countAppendCalls(mockState), 1, '2回目のappendは発生しないこと');
});

// ---------------------------------------------------------------------------
// 履歴行の削除
// ---------------------------------------------------------------------------

test('deleteFulltextAiRound() は対象ラウンドの履歴行を1行残らず削除する（同一キーの複数行を含む）', async () => {
    const unrelatedTiab: Decision = {
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human', screening_phase: 'tiab',
    };
    const roundEarlier: Decision = {
        decision_id: 'd2', ref_id: 'ref9', reviewer_id: 'llm:gemini@2026-01-01T00-00-00Z',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-llm', screening_phase: 'fulltext',
    };
    const roundLater: Decision = {
        // 同一キー（ref9 / llm:gemini.../ fulltext）の履歴2件目。
        // 追記専用化以前は1行に上書きされていたが、今は2行とも残っているはず。
        decision_id: 'd3', ref_id: 'ref9', reviewer_id: 'llm:gemini@2026-01-01T00-00-00Z',
        decision: 'exclude', reason: 're-evaluated', decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.33.2-llm', screening_phase: 'fulltext',
    };
    const roundOtherRef: Decision = {
        decision_id: 'd4', ref_id: 'ref10', reviewer_id: 'llm:gemini@2026-01-01T00-00-00Z',
        decision: 'include', decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-llm', screening_phase: 'fulltext',
    };
    const mockState = createMockState([unrelatedTiab, roundEarlier, roundLater, roundOtherRef]);
    installMockFetch(mockState);

    const deletedCount = await deleteFulltextAiRound(spreadsheetId, 'llm:gemini@2026-01-01T00-00-00Z');

    assert.equal(deletedCount, 3, '同一キーの履歴2行を含む、対象ラウンドの全行が削除されること');
    assert.equal(mockState.decisionsValues.length, 2, 'ヘッダー + 無関係なtiab行の1行だけが残ること');
    const remainingReviewers = mockState.decisionsValues.slice(1).map((row) => row[2]);
    assert.ok(
        !remainingReviewers.includes('llm:gemini@2026-01-01T00-00-00Z'),
        '対象reviewerの行が1件も残っていないこと'
    );
});
