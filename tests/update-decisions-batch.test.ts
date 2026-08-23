import test from 'node:test';
import assert from 'node:assert/strict';
import { updateDecisionsBatch } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision } from '../src/lib/types';

// PR #113 のレビュー指摘の回帰テスト。
// updateDecisionsBatch() の range は Decisions!A{n}:L{n}（context_json列まで）に追従済みだが、
// values 配列が screening_phase までの11要素で止まっていた。Google Sheets はレンジより短い
// values をそのまま受け付けてしまうため、L列（context_json）が更新されず古い値が残ってしまう
// （AGENTS.md「context_json は human 判定の保存時のみ設定する」という不変条件が崩れる）。
// ここでは実際に送信する batchUpdate の HTTP body を検証し、range が A{n}:L{n} であること、
// values が12要素であること、末尾が context_json の値であることを固定する。

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

test('updateDecisionsBatch: range は A{n}:L{n}、values は12要素で末尾が context_json', async () => {
    const requestBodies: any[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'POST' && url.includes('/values:batchUpdate')) {
            requestBodies.push(JSON.parse(init!.body as string));
            return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;

    const decision: Decision = {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        reason: '',
        note: '',
        decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.39.0-ml',
        source_url: '',
        screening_phase: 'tiab',
        context_json: '{"v":1,"key_opened":true}',
    };

    await updateDecisionsBatch('sheet-1', [{ rowIndex: 5, decision }]);

    assert.equal(requestBodies.length, 1, 'batchUpdate は1回だけ呼ばれること');
    const data = requestBodies[0].data;
    assert.equal(data.length, 1);
    assert.equal(data[0].range, 'Decisions!A5:L5');
    assert.equal(data[0].values.length, 1);
    const row = data[0].values[0];
    assert.equal(row.length, 12, 'values は context_json 列まで含めた12要素であること');
    assert.equal(row[11], decision.context_json, '末尾(L列)が context_json の値であること');
});

test('updateDecisionsBatch: context_json が未設定なら空文字を送る', async () => {
    const requestBodies: any[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        if (method === 'POST' && url.includes('/values:batchUpdate')) {
            requestBodies.push(JSON.parse(init!.body as string));
            return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`Unhandled mock fetch: ${method} ${url}`);
    }) as typeof fetch;

    const decision: Decision = {
        decision_id: 'd2',
        ref_id: 'ref2',
        reviewer_id: 'bob@example.com',
        decision: 'exclude',
        decided_at: '2026-01-02T00:00:00Z',
        client_version: '0.39.0-ml-auto',
        screening_phase: 'tiab',
    };

    await updateDecisionsBatch('sheet-1', [{ rowIndex: 10, decision }]);

    const row = requestBodies[0].data[0].values[0];
    assert.equal(row.length, 12);
    assert.equal(row[11], '');
});
