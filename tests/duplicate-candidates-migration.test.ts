import test from 'node:test';
import assert from 'node:assert/strict';
import { getDuplicateCandidates, DUPLICATE_CANDIDATES_HEADERS } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// Issue #153 工程2 チャンク2 レビュー指摘対応の回帰テスト。
//
// getDuplicateCandidates() を「まず読む→失敗した場合だけ ensure してから読み直す」に変えたことで、
// タブは既に存在するがヘッダーに新しい列が無い（列追加前の旧シート）場合、読み取り自体は
// 成功してしまうため catch に入らず、ensureDuplicateCandidatesSheet() の「不足列を末尾へ
// 追加する」分岐を永久に経由しなくなる、という事故を防ぐための固定テスト。
// readDuplicateCandidatesRows() が自分の読み取りで得たヘッダー行を
// migrateDuplicateCandidatesHeaderColumns() へそのまま渡すことで、追加のGETなしで
// 移行機構を維持している（このテストが固定する内容）。

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

interface MockCall { method: string; url: string; body?: unknown; }

/** Duplicate_Candidates の本体GET（A:J）・ヘッダーのみGET（1:1）・ヘッダー行PUTだけを扱う軽量モック */
function installMock(headerRow: string[], dataRows: string[][] = []): { calls: MockCall[] } {
    const calls: MockCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ method, url, body });

        if (method === 'GET' && url.includes('/values/Duplicate_Candidates!A%3AJ')) {
            return new Response(JSON.stringify({ values: [headerRow, ...dataRows] }), { status: 200 });
        }
        if (method === 'GET' && url.includes('/values/Duplicate_Candidates!1%3A1')) {
            return new Response(JSON.stringify({ values: [headerRow] }), { status: 200 });
        }
        if (method === 'PUT' && url.includes('/values/Duplicate_Candidates!')) {
            return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;
    return { calls };
}

test('ヘッダーが不足しているシートを読んだとき、追加のGETなしで列追加PUTが走る', async () => {
    // kept_ref_id（末尾列）が無い9列の旧シート。
    const shortHeaders = DUPLICATE_CANDIDATES_HEADERS.slice(0, -1);
    const mock = installMock(shortHeaders);

    const result = await getDuplicateCandidates('sheet-a');

    assert.deepEqual(result, [], 'データ行が無いので結果は空配列');

    const gets = mock.calls.filter((c) => c.method === 'GET');
    assert.equal(gets.length, 1, '本体読み取り1回のみで済み、ensureDuplicateCandidatesSheet() 側の1:1GETは発生しない');
    assert.ok(gets[0].url.includes('/values/Duplicate_Candidates!A%3AJ'));

    const puts = mock.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1, '不足列（kept_ref_id）の追加PUTがちょうど1回発行される');
    assert.ok(puts[0].url.includes('/values/Duplicate_Candidates!J1%3AJ1'), `想定外のPUT range: ${puts[0].url}`);
    assert.deepEqual((puts[0].body as { values: string[][] }).values, [['kept_ref_id']]);
});

test('ヘッダーが揃っているシートでは、追加のGET・書き込みが発生しない', async () => {
    const mock = installMock([...DUPLICATE_CANDIDATES_HEADERS]);

    const result = await getDuplicateCandidates('sheet-b');

    assert.deepEqual(result, []);
    assert.equal(mock.calls.length, 1, '本体読み取り1回だけで完結し、ensureのGETもヘッダーPUTも発生しない');
    assert.equal(mock.calls[0].method, 'GET');
    assert.ok(mock.calls[0].url.includes('/values/Duplicate_Candidates!A%3AJ'));
});

test('複数列（decided_by・decided_at・kept_ref_id）が不足していても、1回のPUTでまとめて追加される', async () => {
    const shortHeaders = DUPLICATE_CANDIDATES_HEADERS.slice(0, -3);
    const mock = installMock(shortHeaders, [
        // suggested_at までの7列ぶんの1行（欠けている3列は未定義になる）
        ['c1', 'ref-a', 'ref-b', 'title', 'key-1', 'suggested', '2026-01-01T00:00:00Z'],
    ]);

    const result = await getDuplicateCandidates('sheet-c');

    assert.equal(result.length, 1);
    // 移行前のヘッダーでパースするため、欠けている列は未定義（status等は別途デフォルトが効く）。
    assert.equal(result[0].candidate_id, 'c1');
    assert.equal(result[0].status, 'suggested');
    assert.equal(result[0].kept_ref_id, undefined, '移行前の読み取りでは欠けた列はundefinedになる（既存挙動）');

    const puts = mock.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1, '不足3列ぶんの追加は1回のPUTにまとめられる');
    assert.deepEqual(
        (puts[0].body as { values: string[][] }).values,
        [['decided_by', 'decided_at', 'kept_ref_id']]
    );
});
