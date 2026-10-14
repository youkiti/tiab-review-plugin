import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setPlatform } from '../src/platform';
import { createNodePlatform } from '../src/platform/node';
import ja from '../src/_locales/ja/messages.json';
import { DECISIONS_HEADERS, REFERENCES_HEADERS } from '../src/lib/sheets/schema';
import { appendDecisions } from '../src/lib/sheets/decisions';
import { parseDecisionCsv, decisionCsvSummary } from '../src/cli/decision-csv';
import { parseCommandArgs } from '../src/cli/command-args';
import { runSeed, SeedInterruptedError } from '../src/cli/seed';
import { runShare } from '../src/cli/share';
import { runStatus, statusText } from '../src/cli/status';
import { main } from '../src/cli/main';
import { saveCredentials } from '../src/cli/oauth';
import { summarizeTeamDecision } from '../src/sidepanel/features/screening/decision-summary';
import { hasEffectiveConflict } from '../src/sidepanel/render/helpers';
import type { Decision, Reference, ReferenceWithStatus } from '../src/lib/types';

interface Call { url: string; method: string; body: { values?: string[][]; emailAddress?: string; parents?: string[] } }
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });
const stamp = '2026-10-01T12:00:00Z';
const csv = 'pmid,reviewer_id,decision,note,decided_at\n1,a@example.com,include,メモ,' + stamp;
const refs: Reference[] = [
    { ref_id: 'r1', pmid: '1', doi: '10.1/a', title: '文献1', source_file: 'a.ris', abstract: '出力禁止の抄録' },
    { ref_id: 'r2', pmid: '2', title: '文献2', source_file: 'b.ris' },
];
function dec(ref_id: string, reviewer_id: string, decision: Decision['decision'], extra: Partial<Decision> = {}): Decision {
    return { decision_id: `${ref_id}-${reviewer_id}`, ref_id, reviewer_id, decision, decided_at: stamp, client_version: '1-human', ...extra };
}
function decisionRow(d: Decision): string[] {
    return DECISIONS_HEADERS.map(h => (d as unknown as Record<string, string>)[h] ?? '');
}
function fakeApi(options: {
    decisions?: Decision[]; config?: string[][]; refs?: Reference[]; appendStatus?: number;
    storeCount?: number; corruptNote?: boolean; readbackFails?: boolean; denied?: boolean;
    shareFails?: string; folderFails?: boolean; legacyAi?: boolean; create?: boolean;
} = {}) {
    setPlatform(createNodePlatform({ getAccessToken: async () => 'fake-token', forceReauth: async () => 'fake-token',
        clearAuth: async () => {}, messages: ja, fallbackMessages: ja, version: 'cli-test' }));
    const calls: Call[] = [];
    const rows = (options.decisions ?? []).map(decisionRow);
    const config = options.config ?? [['assignment_status', 'dismissed'], ['project_drive_folder', 'folder']];
    const references = (options.refs ?? refs).map(ref => REFERENCES_HEADERS.map(h => String((ref as unknown as Record<string, unknown>)[h] ?? '')));
    let appended = false;
    globalThis.fetch = async (input, init) => {
        const url = decodeURIComponent(input.toString());
        const call: Call = { url, method: init?.method ?? 'GET', body: init?.body && !(init.body instanceof URLSearchParams) ? JSON.parse(String(init.body)) : {} };
        calls.push(call);
        const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
        if (url === 'https://oauth2.googleapis.com/token') return respond({ access_token: 'fake-token', expires_in: 3600 });
        if (url.endsWith('/oauth2/v3/userinfo')) return respond({ email: 'owner@example.com' });
        if (options.denied) return respond({ error: { message: 'https://secret.invalid/ 出力してはいけない' } }, 403);
        if (url.includes('fields=properties.title')) return respond({ properties: { title: '付け直し' } });
        if (url.includes('/permissions')) {
            if (call.method === 'GET') return respond({ permissions: [{ emailAddress: 'owner@example.com', role: 'owner' }] });
            if ((url.includes('/sheet/') && call.body.emailAddress === options.shareFails) ||
                (url.includes('/folder/') && options.folderFails)) return respond({ error: { message: '共有失敗' } }, 403);
            return respond({});
        }
        if (call.method === 'GET' && url.includes('/values/References')) return respond({ values: [REFERENCES_HEADERS, ...references] });
        if (call.method === 'GET' && url.includes('/values/Decisions')) {
            if (appended && options.readbackFails) return respond({ error: { message: '読み戻し失敗' } }, 500);
            return respond({ values: [DECISIONS_HEADERS, ...rows] });
        }
        if (call.method === 'GET' && url.includes('/values/Config')) return respond({ values: config });
        if (url.includes('/values/LLM_Executions')) return respond({ values: options.legacyAi ? [
            ['execution_id', 'execution_type', 'timestamp', 'status', 'is_active'],
            ['llm:old', 'batch_screening', stamp, 'confirmed', 'true'],
        ] : [] });
        if (url.includes('/values/LLM_Runs')) return respond({ error: { message: 'Unable to parse range' } }, 400);
        if (call.method === 'POST' && url.includes('/values/Decisions:append')) {
            appended = true;
            const incoming = (call.body.values ?? []).slice(0, options.storeCount);
            if (options.corruptNote) incoming[0][DECISIONS_HEADERS.indexOf('note')] = '書き換わったメモ';
            rows.push(...incoming);
            return respond({ updates: {} }, options.appendStatus ?? 200);
        }
        if (call.method === 'POST' && url.includes('/values/Config:append')) {
            config.push(...call.body.values ?? []);
            return respond({});
        }
        if (call.method === 'PUT' && url.includes('/values/Config!B')) return respond({});
        if (options.create) {
            if (url.endsWith('/v4/spreadsheets')) return respond({ spreadsheetId: 'sheet' });
            if (url.includes('fields=ownedByMe')) return respond({ ownedByMe: true });
            if (url.includes('/drive/v3/files?') && call.method === 'GET') return respond({ files: [{ id: 'root' }] });
            if (url.includes('/drive/v3/files?') && call.method === 'POST') return respond({ id: 'folder' });
            if (url.includes('fields=id,trashed')) return respond({ id: 'folder', trashed: false });
            if (url.includes('fields=parents')) return respond({ parents: ['root'] });
            if (url.includes('/values/References:append')) {
                const incoming = call.body.values ?? [];
                if (incoming[0]?.[0] !== 'ref_id') { references.length = 0; references.push(...incoming); }
                return respond({});
            }
            if (call.method === 'PATCH' || url.includes(':batchUpdate')) return respond({});
        }
        throw new Error(`想定外のモック呼び出し: ${call.method} ${url}`);
    };
    return calls;
}
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET');
const seed = (content = csv, openKey = false) => runSeed({ spreadsheetId: 'sheet', rows: parseDecisionCsv(content), source: '判定.csv', openKey });

test('seed の入力検査に失敗したら書き込みはゼロ', async () => {
    for (const scenario of [
        { content: csv.replace('\n1,', '\n999,') },
        { content: csv + '\n' + csv.split('\n')[1] },
        { content: csv.replace('a@example.com', 'A@example.com') },
        { content: csv, decisions: [dec('r1', 'a@example.com', 'exclude')] },
        { content: csv, decisions: [dec('r1', 'a@example.com', 'include'), dec('r1', 'a@example.com', 'pending', { client_version: '1-ml' })] },
    ]) {
        const calls = fakeApi({ decisions: scenario.decisions });
        await assert.rejects(async () => seed(scenario.content));
        assert.equal(writes(calls).length, 0);
    }
});

test('seed は判定を一度だけ RAW で追記し、由来と人の種別を保存する', async () => {
    for (const openKey of [false, true]) {
        const calls = fakeApi();
        const result = await seed(csv, openKey);
        assert.equal(result.imported, 1);
        const appends = calls.filter(c => c.url.includes('/values/Decisions:append'));
        assert.equal(appends.length, 1);
        assert.match(appends[0].url, /valueInputOption=RAW/);
        const row = Object.fromEntries(DECISIONS_HEADERS.map((h, i) => [h, appends[0].body.values![0][i]]));
        assert.equal(row.client_version, 'cli-test-human');
        assert.equal(row.note, 'メモ');
        assert.deepEqual(JSON.parse(row.context_json), { imported: true, by: 'cli', source: '判定.csv' });
        assert.equal(writes(calls).filter(c => c.url.includes('Config')).length, openKey ? 1 : 0);
        assert.equal(calls.filter(c => c.method === 'GET' && c.url.includes('/values/Decisions')).length, 2);
    }
});

test('担当セット未設定だけを dismissed に保存し、作成済みは維持する', async () => {
    for (const status of ['none', 'configured']) {
        const calls = fakeApi({ config: [['assignment_status', status]] });
        const result = await seed();
        const configWrites = writes(calls).filter(c => c.url.includes('Config'));
        assert.equal(configWrites.length > 0, status === 'none');
        if (status === 'none') assert.deepEqual(configWrites[0].body.values, [['dismissed']]);
        else assert.match(result.assignment, /変更しません/);
    }
});

test('途中失敗と読み戻し不一致では再追記せず、確認件数を返して後続の書き込みを止める', async () => {
    for (const options of [
        { appendStatus: 500, storeCount: 0 }, { appendStatus: 429, storeCount: 1 },
        { corruptNote: true }, { readbackFails: true },
    ]) {
        const calls = fakeApi({ ...options, config: [] });
        await assert.rejects(seed(csv, true), error => {
            assert.ok(error instanceof SeedInterruptedError);
            assert.equal(error.confirmed, options.readbackFails ? null : options.storeCount ?? 1);
            return true;
        });
        assert.equal(writes(calls).length, 1);
    }
});

test('CSV は BOM・複数行メモ・二重引用符・DOI を扱い、不正な列や日時を拒否する', async () => {
    const content = '\uFEFFdoi,reviewer_id,decision,note,decided_at\r\n10.1/a,a@example.com,maybe,"=SUM(1,2)\n引用""符",' + stamp;
    const rows = parseDecisionCsv(content);
    assert.equal(rows[0].note, '=SUM(1,2)\n引用"符');
    assert.equal(decisionCsvSummary(rows).notes, 1);
    const calls = fakeApi();
    await seed(content);
    assert.equal(writes(calls).length, 1);
    for (const content of [csv.replace(stamp, '昨日'), csv.replace('include', 'invalid'), csv + ',余分', csv.replace('メモ', '"閉じない')]) {
        assert.throws(() => parseDecisionCsv(content));
    }
});

test('share は各相手のシートを通知あり、フォルダを通知なしで共有する', async () => {
    const calls = fakeApi();
    const result = await runShare('sheet', ['a@example.com', 'b@example.com']);
    assert.deepEqual(result.shared, ['a@example.com', 'b@example.com']);
    const permissions = writes(calls);
    assert.equal(permissions.length, 4);
    assert.deepEqual(permissions.map(c => new URL(c.url).searchParams.get('sendNotificationEmail')), ['true', 'false', 'true', 'false']);
    assert.ok(permissions[0].url.includes('付け直し'));
});

test('share のシート招待失敗とフォルダ共有失敗を区別して次の相手へ進む', async () => {
    const calls = fakeApi({ shareFails: 'a@example.com', folderFails: true });
    const result = await runShare('sheet', ['a@example.com', 'b@example.com']);
    assert.deepEqual(result.shared, ['b@example.com']);
    assert.equal(result.shareFailures[0].email, 'a@example.com');
    assert.equal(result.folderShareFailures[0].email, 'b@example.com');
    assert.equal(writes(calls).length, 3);
});

test('status のチーム集計・画面の不一致・最新メモ・合議履歴が一致する', async () => {
    const decisions = [dec('r1', 'a@example.com', 'include'), dec('r1', 'b@example.com', 'exclude'),
        dec('r2', 'a@example.com', 'include', { client_version: '1-human-consensus', note: '合議メモ' }), dec('r2', 'b@example.com', 'include')];
    const calls = fakeApi({ decisions, config: [['key_opened', 'true']] });
    const result = await runStatus('sheet', 'owner@example.com');
    assert.equal(result.team.conflict, 1);
    assert.equal(result.team.include, 1);
    assert.equal(result.filter_conflict, 1);
    assert.equal(result.rows[1].has_human_consensus, true);
    assert.equal(result.rows[1].decisions['a@example.com'].note, '合議メモ');
    const ref: ReferenceWithStatus = { ...refs[0], status: 'pending', allDecisions: decisions.slice(0, 2) };
    assert.equal(result.rows[0].team_status, summarizeTeamDecision(ref, ['a@example.com', 'b@example.com'], true).teamStatus);
    assert.equal(hasEffectiveConflict(ref, new Set(result.filter_settings.enabledReviewers), true, true), true);
    assert.equal(writes(calls).length, 0);
    assert.ok(!JSON.stringify(result).includes('出力禁止の抄録'));
});

test('status は未開封と担当不足でチーム集計と画面の差を明示する', async () => {
    const decisions = [dec('r1', 'a@example.com', 'include'), dec('r1', 'b@example.com', 'exclude'), dec('r2', 'c@example.com', 'maybe')];
    for (const opened of [false, true]) {
        fakeApi({ decisions, config: [['key_opened', String(opened)]] });
        const result = await runStatus('sheet', 'a@example.com');
        assert.equal(result.team.incomplete, 2);
        assert.equal(result.filter_conflict, opened ? 1 : 0);
        assert.equal(result.conflict_counts_differ, opened);
    }
});

test('status は旧形式の AI 履歴を保存せずに解決する', async () => {
    const calls = fakeApi({ decisions: [dec('r1', 'a@example.com', 'include'), dec('r1', 'llm:old', 'exclude', { client_version: '1-llm' })],
        config: [['key_opened', 'true']], legacyAi: true });
    const result = await runStatus('sheet', 'a@example.com');
    assert.equal(result.filter_conflict, 1);
    assert.equal(writes(calls).length, 0);
});

test('既存 LLM バッチの appendDecisions は従来の11列を維持する', async () => {
    const calls = fakeApi();
    await appendDecisions('sheet', [dec('r1', 'llm:batch', 'include', { client_version: '1-llm' })]);
    assert.equal(writes(calls)[0].body.values![0].length, 11);
});

async function withFiles(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tiab-commands-'));
    try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('seed と share の dry-run とヘルプは資格情報なし・通信ゼロ', async () => {
    await withFiles(async dir => {
        const file = path.join(dir, 'input.csv');
        await writeFile(file, csv);
        let calls = 0;
        globalThis.fetch = async () => { calls++; throw new Error('通信禁止'); };
        for (const args of [ ['seed', 'dummy', '--decisions', file, '--dry-run'], ['share', 'dummy', '--share', 'a@example.com', '--dry-run'], ['--help'] ]) {
            assert.equal(await main(args, { stdout: () => {}, stderr: () => {}, env: {} }), 0);
        }
        assert.equal(calls, 0);
    });
});

test('サブコマンド別のオプションを検査し、従来の作成引数も受け付ける', () => {
    assert.ok(!('error' in parseCommandArgs(['--title', '試験', '--ris', 'a.ris'])));
    for (const args of [['seed', 'x'], ['share', 'x'], ['status', 'x', '--open-key'], ['seed', 'x', '--share', 'a@example.com'], ['status', 'https://example.com']]) {
        assert.ok('error' in parseCommandArgs(args));
    }
});

test('status --json は JSON だけを返し、アクセス拒否は CLI の対象制約を案内する', async () => {
    await withFiles(async dir => {
        const credentials = path.join(dir, 'credentials.json');
        await saveCredentials(credentials, { client_id: 'fake-client', refresh_token: 'fake-refresh', scope: 'https://www.googleapis.com/auth/drive.file', saved_at: stamp });
        for (const denied of [false, true]) {
            fakeApi({ denied });
            const stdout: string[] = [], stderr: string[] = [];
            const code = await main(['status', 'sheet', '--json'], { stdout: s => stdout.push(s), stderr: s => stderr.push(s), env: {
                CLI_OAUTH_CLIENT_ID: 'fake-client', CLI_OAUTH_CLIENT_SECRET: 'fake-secret', TIAB_CLI_CREDENTIALS_PATH: credentials,
            } });
            assert.equal(code, denied ? 1 : 0);
            if (!denied) assert.equal(JSON.parse(stdout.join('\n')).title, '付け直し');
            else {
                assert.ok(stderr.some(s => s.includes('このコマンドで作ったプロジェクトにしか')));
                assert.ok(!stderr.join().includes('secret.invalid'));
            }
        }
    });
});

test('create --decisions は判定の確認と開封・案内非表示の後に招待する', async () => {
    await withFiles(async dir => {
        const credentials = path.join(dir, 'credentials.json');
        const risPath = path.join(dir, 'input.ris');
        const csvPath = path.join(dir, 'input.csv');
        await saveCredentials(credentials, { client_id: 'fake-client', refresh_token: 'fake-refresh', scope: 'https://www.googleapis.com/auth/drive.file', saved_at: stamp });
        await writeFile(risPath, 'TY  - JOUR\nTI  - 文献1\nAN  - 1\nER  -\n');
        await writeFile(csvPath, csv);
        const calls = fakeApi({ create: true, config: [] });
        const stderr: string[] = [];
        const code = await main(['create', '--title', '試験', '--ris', risPath, '--decisions', csvPath, '--open-key', '--share', 'a@example.com'], {
            stdout: () => {}, stderr: s => stderr.push(s), env: {
                CLI_OAUTH_CLIENT_ID: 'fake-client', CLI_OAUTH_CLIENT_SECRET: 'fake-secret', TIAB_CLI_CREDENTIALS_PATH: credentials,
            },
        });
        assert.equal(code, 0, stderr.join('\n'));
        const append = calls.findIndex(c => c.url.includes('/values/Decisions:append') && c.body.values?.[0]?.[0] !== 'decision_id');
        const readback = calls.findIndex((c, i) => i > append && c.method === 'GET' && c.url.includes('/values/Decisions'));
        const opened = calls.findIndex(c => c.body.values?.[0]?.[0] === 'key_opened');
        const dismissed = calls.findIndex(c => c.body.values?.[0]?.[0] === 'assignment_status');
        const invited = calls.findIndex(c => c.url.includes('/permissions'));
        assert.ok(append >= 0 && append < readback && readback < opened && opened < dismissed && dismissed < invited);
    });
});

test('create の CSV 照合失敗はシートを作成せず認証前に止まる', async () => {
    await withFiles(async dir => {
        const risPath = path.join(dir, 'input.ris');
        const csvPath = path.join(dir, 'input.csv');
        await writeFile(risPath, 'TY  - JOUR\nTI  - 文献1\nER  -\n');
        await writeFile(csvPath, csv);
        const calls = fakeApi();
        assert.equal(await main(['create', '--title', '試験', '--ris', risPath, '--decisions', csvPath], {
            stdout: () => {}, stderr: () => {}, env: {},
        }), 1);
        assert.equal(calls.length, 0);
    });
});

test('別の識別子で指定した同一文献・判定者も重複として止める', async () => {
    const calls = fakeApi();
    const content = 'pmid,doi,reviewer_id,decision,note,decided_at\n' +
        `1,,a@example.com,include,,${stamp}\n,10.1/a,a@example.com,include,,${stamp}`;
    await assert.rejects(seed(content), /重複/);
    assert.equal(writes(calls).length, 0);
});

test('status のテキストは詳細を省略して --json を案内し、JSON には詳細を残す', async () => {
    fakeApi({ decisions: [dec('r1', 'a@example.com', 'include', { note: '文献別の詳細メモ' })],
        config: [['key_opened', 'true']] });
    const result = await runStatus('sheet', 'owner@example.com');
    const text = statusText(result);
    assert.match(text, /文献ごとの詳細は --json で出力/);
    assert.match(text, /チーム集計:/);
    assert.doesNotMatch(text, /文献別の詳細メモ|has_human_consensus|文献ごとの最新判定・メモ・合議履歴:/);
    assert.equal(JSON.parse(JSON.stringify(result)).rows[0].decisions['a@example.com'].note, '文献別の詳細メモ');
});

test('seed の後続設定保存失敗は全件照合済み・失敗した処理・再実行禁止を案内する', async () => {
    await withFiles(async dir => {
        const credentials = path.join(dir, 'credentials.json');
        const csvPath = path.join(dir, 'input.csv');
        await saveCredentials(credentials, { client_id: 'fake-client', refresh_token: 'fake-refresh', scope: 'https://www.googleapis.com/auth/drive.file', saved_at: stamp });
        await writeFile(csvPath, csv);
        for (const [key, operation] of [['key_opened', 'キー開封'], ['assignment_status', '担当セット案内の非表示']]) {
            const calls = fakeApi({ config: [] });
            const mockedFetch = globalThis.fetch;
            let failures = 0;
            globalThis.fetch = async (input, init) => {
                const url = decodeURIComponent(input.toString());
                const body = init?.body && !(init.body instanceof URLSearchParams) ? JSON.parse(String(init.body)) : {};
                if (url.includes('/values/Config:append') && body.values?.[0]?.[0] === key) {
                    failures++;
                    return new Response(JSON.stringify({ error: { message: '後続設定の保存失敗' } }), { status: 500 });
                }
                return mockedFetch(input, init);
            };
            const stderr: string[] = [];
            const code = await main(['seed', 'sheet', '--decisions', csvPath, '--open-key'], {
                stdout: () => {}, stderr: s => stderr.push(s), env: {
                    CLI_OAUTH_CLIENT_ID: 'fake-client', CLI_OAUTH_CLIENT_SECRET: 'fake-secret', TIAB_CLI_CREDENTIALS_PATH: credentials,
                },
            });
            assert.equal(code, 1);
            const output = stderr.join('\n');
            assert.match(output, /判定は全 1 件の書き込みと読み戻し照合が完了/);
            assert.ok(output.includes(`${operation}に失敗しました`));
            assert.match(output, /seed を再実行すると行が二重になりうるため、再実行しないでください/);
            assert.match(output, /spreadsheet_id: sheet/);
            assert.doesNotMatch(output, /判定取り込みの途中で停止|件数だけでは内容一致を保証しません/);
            assert.equal(calls.filter(c => c.url.includes('/values/Decisions:append')).length, 1);
            assert.equal(calls.filter(c => c.method === 'GET' && c.url.includes('/values/Decisions')).length, 2);
            assert.equal(failures, 1);
        }
    });
});

test('create の警告は seed が失敗しても取り込みエラーより先に表示する', async () => {
    await withFiles(async dir => {
        const credentials = path.join(dir, 'credentials.json');
        const risPath = path.join(dir, 'input.ris');
        const csvPath = path.join(dir, 'input.csv');
        await saveCredentials(credentials, { client_id: 'fake-client', refresh_token: 'fake-refresh', scope: 'https://www.googleapis.com/auth/drive.file', saved_at: stamp });
        await writeFile(risPath, 'TY  - JOUR\nTI  - 文献1\nAN  - 1\nER  -\n');
        await writeFile(csvPath, csv);
        fakeApi({ create: true, config: [] });
        const mockedFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
            const url = decodeURIComponent(input.toString());
            if (url.includes('fields=ownedByMe')) {
                return new Response(JSON.stringify({ ownedByMe: false }), { status: 200 });
            }
            if (url.includes('/values/Config:append') && init?.body &&
                JSON.parse(String(init.body)).values?.[0]?.[0] === 'key_opened') {
                return new Response(JSON.stringify({ error: { message: 'キー開封の保存失敗' } }), { status: 500 });
            }
            return mockedFetch(input, init);
        };
        const stderr: string[] = [];
        const code = await main(['create', '--title', '試験', '--ris', risPath, '--decisions', csvPath, '--open-key'], {
            stdout: () => {}, stderr: s => stderr.push(s), env: {
                CLI_OAUTH_CLIENT_ID: 'fake-client', CLI_OAUTH_CLIENT_SECRET: 'fake-secret', TIAB_CLI_CREDENTIALS_PATH: credentials,
            },
        });
        assert.equal(code, 1);
        const warningIndex = stderr.findIndex(line => line.startsWith('warning: プロジェクトフォルダを整理できませんでした'));
        const errorIndex = stderr.findIndex(line => line.includes('キー開封に失敗しました'));
        assert.ok(warningIndex >= 0 && errorIndex > warningIndex);
        assert.equal(stderr.filter(line => line.startsWith('warning:')).length, 1);
    });
});
