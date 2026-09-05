import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    clearLlmSheetEnsureMemo, ensureLlmExecutionsSheet, ensureLlmRunsSheet,
    getLlmHistory, getProjectLoadConfig, getProjectConfigBundle, getAssignmentConfig,
    getFulltextAiActiveRound, parseAssignmentConfig, parseFulltextAiActiveRound,
    getReferencesWithAllDecisions, getReferencesWithStatus, getActiveBatchIdsForActiveRun,
    getReferences, getDecisions, getDuplicateCandidates, isUserAdmin,
    getSpreadsheetInfo, getUserEmail, ensureHeaders, REFERENCES_HEADERS, DUPLICATE_CANDIDATES_HEADERS,
} from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

const mockPlatform: PlatformAdapter = {
    getAuthToken: async () => 'test-token', forceReauth: async () => 'test-token',
    clearAuth: async () => {}, storageGet: async () => ({}), storageSet: async () => {},
    storageRemove: async () => {}, storageClear: async () => {}, onMessage: () => {},
    emitMessage: () => {}, getMessage: key => key, openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
    setPlatform(mockPlatform);
    clearLlmSheetEnsureMemo();
    // 既存APIの診断ログにも識別子を出さず、失敗はassertで検出する。
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
});
test.afterEach(() => {
    globalThis.fetch = originalFetch;
    clearLlmSheetEnsureMemo();
    mock.restoreAll();
});

const executionHeaders = [
    'execution_id', 'execution_type', 'timestamp', 'model', 'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt', 'include_threshold', 'target_count', 'include_count',
    'exclude_count', 'status', 'is_active', 'run_id', 'requested_model', 'model_version', 'response_id',
    'target_mode', 'target_sets', 'target_selected_count', 'executed_by', 'maybe_count', 'failed_count',
    'failure_breakdown', 'exclude_reasons_snapshot',
];
const runHeaders = [
    'run_id', 'config_hash', 'created_at', 'model', 'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt', 'include_threshold', 'status', 'is_active',
    'requested_model', 'model_version', 'response_id',
];
const decisionHeaders = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason', 'labels', 'note',
    'decided_at', 'client_version', 'source_url', 'screening_phase', 'context_json',
];
function row(headers: string[], data: Record<string, string>): string[] {
    return headers.map(h => data[h] ?? '');
}

function installMock(keyOpened = true, legacy = false) {
    const tables: Record<string, string[][]> = {
        References: [REFERENCES_HEADERS, row(REFERENCES_HEADERS, { ref_id: 'ref-1', title: '文献' })],
        Decisions: [decisionHeaders, ...[
            ['self', 'include', 'tiab'], ['other', 'exclude', 'tiab'],
            ['llm:batch-1', 'include', 'tiab'], ['llm:ft-1', 'exclude', 'fulltext'],
        ].map(([reviewer_id, decision, screening_phase], i) => row(decisionHeaders, {
            decision_id: `d-${i}`, ref_id: 'ref-1', reviewer_id, decision, screening_phase,
            decided_at: '2026-01-01T00:00:00Z',
        }))],
        Config: [
            ['key_opened', String(keyOpened)], ['assignment_status', 'configured'],
            ['assignment_reviewer_map', '{"group1":["self","other"]}'],
            ['fulltext_ai_active_round', ' llm:ft-1 '],
        ],
        LLM_Executions: [executionHeaders, row(executionHeaders, {
            execution_id: 'batch-1', execution_type: 'batch_screening',
            timestamp: '2026-01-01T00:00:00Z', model: 'test-model',
            status: 'confirmed', is_active: 'true', run_id: legacy ? '' : 'run-1',
        })],
        LLM_Runs: legacy ? [runHeaders] : [runHeaders, row(runHeaders, {
            run_id: 'run-1', config_hash: 'hash-1', created_at: '2026-01-01T00:00:00Z',
            model: 'test-model', status: 'confirmed', is_active: 'true',
        })],
        Duplicate_Candidates: [DUPLICATE_CANDIDATES_HEADERS],
    };
    const counts: Record<string, number> = {};
    const writes: { endpoint: string; body: Record<string, unknown> }[] = [];
    const failures = new Map<string, string>();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const match = decodeURIComponent(url.pathname).match(/\/values\/([^!]+)!(.+)/);
        const endpoint = match?.[1] ?? (url.pathname.includes('oauth2') ? 'oauth2'
            : url.hostname === 'www.googleapis.com' ? 'drive' : 'metadata');
        if (init?.method && init.method !== 'GET') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            writes.push({ endpoint, body });
            return json({ replies: [{ addSheet: { properties: { sheetId: 1 } } }] });
        }
        counts[endpoint] = (counts[endpoint] ?? 0) + 1;
        const failure = failures.get(endpoint);
        if (failure) return json({ error: { message: failure } }, 400);
        if (match) {
            assert.ok(tables[endpoint], '想定したシートのみを読む');
            const headerOnly = match[2] === '1:1' || /1:.*1$/.test(match[2]);
            return json({ values: headerOnly ? tables[endpoint].slice(0, 1) : tables[endpoint] });
        }
        if (endpoint === 'drive') return json({ permissions: [], capabilities: { canEdit: true } });
        if (endpoint === 'oauth2') return json({ email: 'self' });
        assert.equal(endpoint, 'metadata');
        return json({ properties: { title: 'テスト' } });
    };
    return { tables, counts, writes, failures };
}

for (const keyOpened of [false, true]) {
    test(`プロジェクト読み込み（${keyOpened ? 'キー開封後' : 'Blind'}）: 履歴各2回・Config1回・合計18回以下`, async () => {
        const mock = installMock(keyOpened);
        // 接続前後のAPI列: 認証、project.tsの接続時ヘッダー確認・メタ情報取得。
        const user = await getUserEmail();
        await getSpreadsheetInfo('project');
        await ensureHeaders('project');
        const [, config, history] = await Promise.all([
            isUserAdmin('project', user), getProjectLoadConfig('project'), getLlmHistory('project'),
        ]);
        const loaded = { ...history, fulltextAiActiveRound: config.fulltextAiActiveRound };
        const refs = keyOpened
            ? await getReferencesWithAllDecisions('project', user, loaded)
            : await getReferencesWithStatus('project', user);
        // 画面表示後: team-progress、duplicate-reviewの件数、manuscriptの全件取得。
        await Promise.all([
            getDecisions('project'), getReferences('project'), getDuplicateCandidates('project'),
            getReferences('project'),
        ]);
        assert.deepEqual(mock.counts, {
            oauth2: 1, metadata: 1, References: 4, Decisions: 3, drive: 2,
            Config: 1, LLM_Executions: 2, LLM_Runs: 2, Duplicate_Candidates: 2,
        });
        assert.ok(Object.values(mock.counts).reduce((a, b) => a + b, 0) <= 18);
        assert.equal(mock.writes.length, 0, '移行不要なら書き込みはゼロ');
        assert.deepEqual(await getActiveBatchIdsForActiveRun('project', history.llmExecutions, history.llmRuns), new Set(['batch-1']));
        assert.equal(config.assignmentConfig.status, 'configured');
        const reviewers = refs[0].allDecisions?.map(d => d.reviewer_id) ?? [];
        assert.equal(reviewers.includes('other'), keyOpened, 'Blindでは他者票を出さない');
        assert.equal(mock.counts.LLM_Runs, 2, '下流の採用Run解決は再取得しない');
    });
}

test('Configの共有結果は既存ラッパーと一致し、採用解除のnullでも再取得しない', async () => {
    const mock = installMock();
    mock.tables.Config.push(['fulltext_ai_active_round', 'second']);
    const shared = await getProjectLoadConfig('project');
    assert.deepEqual(shared.configBundle, await getProjectConfigBundle('project'));
    assert.deepEqual(shared.assignmentConfig, await getAssignmentConfig('project'));
    assert.equal(shared.fulltextAiActiveRound, await getFulltextAiActiveRound('project'));
    assert.equal(shared.fulltextAiActiveRound, 'llm:ft-1', '重複キーは従来の先頭一致を維持');
    const history = await getLlmHistory('project');
    const before = mock.counts.Config;
    await getReferencesWithAllDecisions('project', 'self', { ...history, fulltextAiActiveRound: null });
    assert.equal(mock.counts.Config, before);
    assert.equal(parseFulltextAiActiveRound([]), null);
    assert.equal(parseFulltextAiActiveRound([['fulltext_ai_active_round', ' ']]), null);
    assert.deepEqual(parseAssignmentConfig([['assignment_reviewer_map', 'invalid']]).reviewerMap, {});
});

test('Config欠落時の一括取得は既存ラッパーと同じデフォルトに戻る', async () => {
    const mock = installMock();
    mock.failures.set('Config', 'Unable to parse range');
    const shared = await getProjectLoadConfig('project');
    assert.equal(mock.counts.Config, 1);
    assert.deepEqual(shared.configBundle, await getProjectConfigBundle('project'));
    assert.deepEqual(shared.assignmentConfig, await getAssignmentConfig('project'));
    assert.equal(shared.fulltextAiActiveRound, await getFulltextAiActiveRound('project'));
});

test('キー開封後の共有引数あり・なしで判定内容が一致する', async () => {
    installMock();
    const baseline = await getReferencesWithAllDecisions('project', 'self');
    const [history, config] = await Promise.all([getLlmHistory('project'), getProjectLoadConfig('project')]);
    const shared = await getReferencesWithAllDecisions('project', 'self', {
        ...history, fulltextAiActiveRound: config.fulltextAiActiveRound,
    });
    assert.deepEqual(shared, baseline);
});

test('次のロードではConfigと履歴の内容を再取得する', async () => {
    const mock = installMock();
    await Promise.all([getLlmHistory('project'), getProjectLoadConfig('project')]);
    mock.tables.LLM_Runs = [runHeaders];
    mock.tables.Config = [['key_opened', 'false']];
    const [history, config] = await Promise.all([getLlmHistory('project'), getProjectLoadConfig('project')]);
    assert.equal(history.llmRuns.length, 0);
    assert.equal(config.configBundle.keyOpened, false);
    assert.equal(mock.counts.LLM_Executions, 3);
    assert.equal(mock.counts.LLM_Runs, 3);
    assert.equal(mock.counts.Config, 2);
});

for (const [sheet, ensure] of [
    ['LLM_Executions', ensureLlmExecutionsSheet], ['LLM_Runs', ensureLlmRunsSheet],
] as const) {
    test(`${sheet}: 同時ensure合流・TTL・プロジェクト切替・明示失効`, async t => {
        const mock = installMock();
        let now = 1_000;
        t.mock.method(Date, 'now', () => now);
        await Promise.all([ensure('a'), ensure('a'), ensure('a')]);
        await ensure('a');
        assert.equal(mock.counts[sheet], 1);
        now += 60_000;
        await ensure('a');
        assert.equal(mock.counts[sheet], 2);
        await ensure('b');
        await ensure('a');
        assert.equal(mock.counts[sheet], 4);
        clearLlmSheetEnsureMemo();
        await ensure('a');
        assert.equal(mock.counts[sheet], 5);
    });

    test(`${sheet}: タブ欠落の作成とヘッダー不足の末尾追加を維持`, async () => {
        const mock = installMock();
        mock.failures.set(sheet, 'Unable to parse range');
        await ensure('project');
        assert.equal(mock.writes.length, 2, 'addSheetとヘッダーappend');
        assert.ok(mock.writes[0].body.requests);
        assert.deepEqual(mock.writes[1].body.values, [mock.tables[sheet][0]]);
        mock.failures.clear();
        const headers = mock.tables[sheet][0];
        mock.tables[sheet] = [headers.slice(0, -1)];
        clearLlmSheetEnsureMemo();
        await ensure('project');
        assert.deepEqual(mock.writes[2].body.values, [[headers[headers.length - 1]]]);
    });

    test(`${sheet}: ensure失敗をmemoに残さない`, async () => {
        const mock = installMock();
        mock.failures.set(sheet, 'temporary failure');
        await assert.rejects(ensure('project'), /temporary failure/);
        mock.failures.clear();
        await ensure('project');
        assert.equal(mock.counts[sheet], 2);
    });

    test(`${sheet}: 空ヘッダーの初期化後だけmemoを温める`, async () => {
        const mock = installMock();
        const headers = mock.tables[sheet][0];
        mock.tables[sheet] = [];
        await ensure('project');
        await ensure('project');
        assert.equal(mock.counts[sheet], 1);
        assert.deepEqual(mock.writes[0].body.values, [headers]);
    });
}

test('旧形式移行は一度だけ書き込み、共有した履歴で採用Batchを解決する', async () => {
    const mock = installMock(true, true);
    const history = await getLlmHistory('project');
    assert.equal(history.llmRuns.length, 1);
    assert.equal(history.llmExecutions[0].run_id, history.llmRuns[0].run_id);
    assert.equal(mock.writes.length, 2, 'Run追加とBatch所属更新が各1回');
    // 移行時だけ、書き込み先の行位置を再確認する既存の本体GETが1回増える。
    assert.equal(mock.counts.LLM_Executions, 3);
    assert.equal(mock.counts.LLM_Runs, 2);
    const before = { ...mock.counts };
    await getReferencesWithAllDecisions('project', 'self', { ...history, fulltextAiActiveRound: null });
    assert.equal(mock.counts.LLM_Runs, before.LLM_Runs);
    assert.equal(mock.counts.LLM_Executions, before.LLM_Executions);
    assert.equal(mock.writes.length, 2, '下流へ渡した履歴では移行を再実行しない');
    assert.deepEqual(await getActiveBatchIdsForActiveRun('project', history.llmExecutions, history.llmRuns), new Set(['batch-1']));
});

test('Runs取得失敗でも独立して読めたExecutionsは保持する', async () => {
    const mock = installMock();
    mock.failures.set('LLM_Runs', 'temporary failure');
    const history = await getLlmHistory('project');
    assert.equal(history.llmRuns.length, 0);
    assert.equal(history.llmExecutions.length, 1);
});
