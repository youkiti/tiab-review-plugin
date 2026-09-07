import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addSheet,
    appendRows,
    batchUpdateRanges,
    fetchWithQuotaRetry,
    getSheetIdByName,
    getSheetValues,
    getSheetValuesBatch,
    setQuotaRetrySleepForTest,
    updateRange,
} from '../src/lib/sheets/transport';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

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

const spreadsheetId = 'sheet-1';
const range = 'Decisions!A2:C2';
const originalFetch = globalThis.fetch;
const delays: number[] = [];

test.beforeEach(() => {
    setPlatform(mockPlatform);
    delays.length = 0;
    setQuotaRetrySleepForTest(async delayMs => { delays.push(delayMs); });
});

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    setQuotaRetrySleepForTest();
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

function installFetch(respond: (callIndex: number) => Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        return respond(calls.length - 1);
    };
    return calls;
}

const writes = [
    {
        name: 'appendRows',
        run: () => appendRows(spreadsheetId, 'Decisions', [['include', 2, undefined]]),
        method: 'POST',
        path: '/values/Decisions:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
        body: { values: [['include', 2, '']] },
        response: { updates: { updatedRange: "'Decisions! 履歴'!A123:C124" } },
        result: { firstRowIndex: 123 },
        errorPrefix: 'Failed to append rows',
    },
    {
        name: 'updateRange',
        run: () => updateRange(spreadsheetId, range, [['include', 2, undefined]]),
        method: 'PUT',
        path: `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        body: { values: [['include', 2, '']] },
        response: {},
        result: undefined,
        errorPrefix: 'Failed to update range',
    },
    {
        name: 'batchUpdateRanges',
        run: () => batchUpdateRanges(spreadsheetId, [{ range, values: [['include']] }]),
        method: 'POST',
        path: '/values:batchUpdate',
        body: { valueInputOption: 'USER_ENTERED', data: [{ range, values: [['include']] }] },
        response: {},
        result: undefined,
        errorPrefix: 'Failed to batch update ranges',
    },
    {
        name: 'addSheet',
        run: () => addSheet(spreadsheetId, 'Decisions'),
        method: 'POST',
        path: ':batchUpdate',
        body: { requests: [{ addSheet: { properties: { title: 'Decisions' } } }] },
        response: {},
        result: undefined,
        errorPrefix: 'Failed to add sheet',
    },
];

for (const write of writes) {
    test(`${write.name}: 429後に同じリクエストを再送して成功する`, async t => {
        const warn = t.mock.method(console, 'warn', () => {});
        const calls = installFetch(index => index === 0
            ? jsonResponse({ error: { message: 'rate limited' } }, 429)
            : jsonResponse(write.response));

        assert.deepEqual(await write.run(), write.result);
        assert.equal(calls.length, 2);
        assert.deepEqual(delays, [1000]);
        assert.deepEqual(calls[1], calls[0]);
        assert.equal(calls[0].url, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}${write.path}`);
        assert.equal(calls[0].init?.method, write.method);
        assert.deepEqual(calls[0].init?.headers, {
            'Authorization': 'Bearer test-token',
            'Content-Type': 'application/json',
        });
        assert.deepEqual(JSON.parse(String(calls[0].init?.body)), write.body);
        assert.ok(String(warn.mock.calls[0].arguments[0]).startsWith(`[${write.name}] 429 quota exceeded for `));
    });

    test(`${write.name}: 429が続くと6回で打ち切り従来のエラーメッセージを返す`, async t => {
        t.mock.method(console, 'warn', () => {});
        // 本文に特定のクォータ文言が含まれることを前提にしない。
        const calls = installFetch(() => jsonResponse({ error: { message: 'rate limited' } }, 429));
        await assert.rejects(write.run(), { message: `${write.errorPrefix}: rate limited` });
        assert.equal(calls.length, 6);
        assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
    });

    for (const status of [403, 404, 500]) {
        test(`${write.name}: ${status}は再試行せず従来のエラーを返す`, async () => {
            const calls = installFetch(() => jsonResponse({ error: { message: 'rejected' } }, status));
            await assert.rejects(write.run(), { message: `${write.errorPrefix}: rejected` });
            assert.equal(calls.length, 1);
            assert.deepEqual(delays, []);
        });
    }
}

test('getSheetIdByName: 429後に再試行して該当するsheetIdを返す', async t => {
    t.mock.method(console, 'warn', () => {});
    const calls = installFetch(index => index === 0 ? jsonResponse({}, 429) : jsonResponse({
        sheets: [
            { properties: { title: 'References', sheetId: 1 } },
            { properties: { title: 'Decisions', sheetId: 42 } },
        ],
    }));
    assert.equal(await getSheetIdByName(spreadsheetId, 'Decisions'), 42);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[0].url, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    assert.deepEqual(calls[0].init, { headers: { 'Authorization': 'Bearer test-token' } });
    assert.deepEqual(delays, [1000]);
});

for (const status of [403, 404, 429]) {
    test(`getSheetIdByName: ${status}は従来どおりnullを返す`, async t => {
        t.mock.method(console, 'warn', () => {});
        const calls = installFetch(() => jsonResponse({}, status));
        assert.equal(await getSheetIdByName(spreadsheetId, 'Decisions'), null);
        assert.equal(calls.length, status === 429 ? 6 : 1);
        assert.deepEqual(delays, status === 429 ? [1000, 2000, 4000, 8000, 16000] : []);
    });
}

for (const batch of [false, true]) {
    test(`${batch ? 'getSheetValuesBatch' : 'getSheetValues'}: 既存のGET再試行とログ文言を維持する`, async t => {
        const warn = t.mock.method(console, 'warn', () => {});
        const calls = installFetch(index => index === 0 ? jsonResponse({}, 429) : jsonResponse(
            batch ? { valueRanges: [{ values: [['include']] }] } : { values: [['include']] }
        ));
        const result = batch
            ? await getSheetValuesBatch(spreadsheetId, [range])
            : await getSheetValues(spreadsheetId, range);
        assert.deepEqual(result, batch ? [[['include']]] : [['include']]);
        assert.equal(calls.length, 2);
        assert.deepEqual(delays, [1000]);
        assert.equal(warn.mock.calls[0].arguments[0],
            `[getSheetValues] 429 quota exceeded for ${range}, retry 1/5 after 1000ms`);
    });
}

test('共通helper: 429以外と再試行上限ではResponse自体を返す', async t => {
    t.mock.method(console, 'warn', () => {});
    for (const status of [403, 429]) {
        const response = jsonResponse({}, status);
        const calls = installFetch(() => response);
        assert.equal(await fetchWithQuotaRetry('https://example.test', {}, 'test', 'test'), response);
        assert.equal(calls.length, status === 429 ? 6 : 1);
    }
});

test('appendRows: 通信例外は重複追記を避けるため再試行しない', async () => {
    let calls = 0;
    const error = new Error('network error');
    globalThis.fetch = async () => { calls++; throw error; };
    await assert.rejects(appendRows(spreadsheetId, 'Decisions', [['include']]), error);
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
});
