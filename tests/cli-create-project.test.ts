import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setPlatform } from '../src/platform';
import { createNodePlatform } from '../src/platform/node';
import ja from '../src/_locales/ja/messages.json';
import { runCreateProject, planImport, ImportInterruptedError, type ImportPlan } from '../src/cli/create-project';
import { main, PICKER_GUIDANCE } from '../src/cli/main';
import { saveCredentials } from '../src/cli/oauth';
import { truncateAbstract, isAbstractTruncated } from '../src/lib/import-helpers';

interface Call { method: string; url: string; body: { values?: unknown[][]; emailAddress?: string; parents?: string[] } }
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

function fakeApi(options: { failBatch?: number; folderFails?: boolean; fulltextFolderFails?: boolean; shareFails?: string; folderShareFails?: boolean; statsFails?: boolean } = {}) {
    setPlatform(createNodePlatform({
        getAccessToken: async () => 'fake-access-value', forceReauth: async () => 'fake-access-value', clearAuth: async () => {},
        messages: ja, fallbackMessages: ja, version: 'cli-test',
    }));
    const calls: Call[] = [];
    const configRows: unknown[][] = [];
    let batches = 0;
    globalThis.fetch = async (input, init) => {
        const url = input.toString();
        const call: Call = { method: init?.method ?? 'GET', url,
            body: init?.body && !(init.body instanceof URLSearchParams) ? JSON.parse(String(init.body)) : {} };
        calls.push(call);
        const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
        if (url === 'https://oauth2.googleapis.com/token') return respond({ access_token: 'fake-access-value', expires_in: 3600 });
        if (url.endsWith('/oauth2/v3/userinfo')) return respond({ email: 'owner@example.com' });
        if (isDataAppend(call)) {
            if (++batches === options.failBatch) return respond({ error: { message: '追記失敗' } }, 500);
        }
        if (url.endsWith('/v4/spreadsheets')) return respond({ spreadsheetId: 'sheet-test' });
        if (url.includes('fields=ownedByMe')) return respond({ ownedByMe: !options.folderFails });
        if (url.includes('/drive/v3/files?') && call.method === 'GET') return respond({ files: [{ id: 'root-test' }] });
        if (isFulltextFolderCreation(call)) {
            if (options.fulltextFolderFails) return respond({ error: { message: '全文フォルダ作成失敗' } }, 400);
            return respond({ id: 'fulltext-test' });
        }
        if (url.includes('/drive/v3/files?') && call.method === 'POST') return respond({ id: 'folder-test' });
        if (url.includes('/drive/v3/files/folder-test?fields=id,trashed')) return respond({ id: 'folder-test', trashed: false });
        if (url.includes('fields=parents')) return respond({ parents: ['root'] });
        if (url.includes('/permissions')) {
            if ((url.includes('/sheet-test/') && call.body.emailAddress === options.shareFails) ||
                (url.includes('/folder-test/') && options.folderShareFails)) {
                return respond({ error: { message: '共有失敗' } }, 403);
            }
        }
        if (options.statsFails && call.body.values?.[0]?.[0] === 'import_stats') return respond({ error: { message: '保存失敗' } }, 500);
        if (call.method === 'GET' && decodeURIComponent(url).includes('/values/Config!A:B')) return respond({ values: configRows });
        if (call.method === 'POST' && url.includes('/values/Config:append')) configRows.push(...(call.body.values ?? []));
        return respond({ values: [] });
    };
    return calls;
}

function isDataAppend(call: Call): boolean {
    return call.url.includes('/values/References:append') && call.body.values?.[0]?.[0] !== 'ref_id';
}

function isFulltextFolderCreation(call: Call): boolean {
    return call.method === 'POST' && call.url.includes('/drive/v3/files?') &&
        call.body.parents?.length === 1 && call.body.parents[0] === 'folder-test';
}

function plan(count = 1): ImportPlan {
    const references = Array.from({ length: count }, (_, i) => ({ ref_id: `ref-${i}`, title: `文献 ${i}` }));
    return { references, toImport: references, duplicateCount: 0, reviewPairs: [], truncatedAbstractCount: 0 };
}

function run(importPlan = plan(), share: string[] = []) {
    return runCreateProject({ title: '試験', fileName: 'input.ris', plan: importPlan, share });
}

test('作成・フォルダ整理・文献追記・統計保存・シート共有・フォルダ共有の順に呼ぶ', async () => {
    const calls = fakeApi();
    const result = await run(plan(), ['a@example.com']);
    assert.equal(result.folderId, 'folder-test');
    assert.equal(result.importedCount, 1);
    assert.deepEqual(result.shared, ['a@example.com']);
    const creation = calls.findIndex(c => c.url.endsWith('/v4/spreadsheets'));
    const folder = calls.findIndex(c => c.method === 'PATCH' && c.url.includes('addParents='));
    const references = calls.findIndex(isDataAppend);
    const stats = calls.findIndex(c => c.body.values?.[0]?.[0] === 'import_stats');
    const permissions = calls.filter(c => c.url.includes('/permissions'));
    assert.ok(creation < folder && folder < references && references < stats && stats < calls.indexOf(permissions[0]));
    assert.equal(permissions.length, 2);
    assert.match(permissions[0].url, /\/sheet-test\/permissions/);
    assert.ok(new URL(permissions[0].url).searchParams.get('emailMessage')?.includes('試験'));
    assert.match(permissions[1].url, /\/folder-test\/permissions/);
    assert.equal(new URL(permissions[1].url).searchParams.get('sendNotificationEmail'), 'false');
    assert.equal(new URL(permissions[1].url).searchParams.has('emailMessage'), false);
});

test('共有先が空なら permissions は呼ばない', async () => {
    const calls = fakeApi();
    await run();
    assert.equal(calls.filter(c => c.url.includes('/permissions')).length, 0);
});

test('フルテキスト保存用フォルダを文献追記前に作成して Config に保存する', async () => {
    const calls = fakeApi();
    const result = await run();
    const fulltextFolders = calls.filter(isFulltextFolderCreation);
    assert.equal(fulltextFolders.length, 1);
    const creation = calls.indexOf(fulltextFolders[0]);
    const saved = calls.findIndex(c => c.method === 'POST' && c.url.includes('/values/Config:append') &&
        c.body.values?.[0]?.[0] === 'fulltext_drive_folder');
    assert.deepEqual(calls[saved]?.body.values, [['fulltext_drive_folder', 'fulltext-test']]);
    assert.ok(creation < saved && saved < calls.findIndex(isDataAppend));
    assert.deepEqual(result.warnings, []);
});

test('1201 件を 500・500・201 件で追記する', async () => {
    const calls = fakeApi();
    const result = await run(plan(1201));
    assert.deepEqual(calls.filter(isDataAppend).map(c => c.body.values?.length), [500, 500, 201]);
    assert.equal(result.importedCount, 1201);
});

test('2 バッチ目が失敗したら再試行せず全後続処理を止める', async () => {
    const calls = fakeApi({ failBatch: 2 });
    await assert.rejects(run(plan(1201), ['a@example.com']), error => {
        assert.ok(error instanceof ImportInterruptedError);
        assert.equal(error.confirmedCount, 500);
        assert.equal(error.failedFrom, 501);
        assert.equal(error.failedTo, 1000);
        assert.equal(error.totalCount, 1201);
        assert.equal(error.spreadsheetId, 'sheet-test');
        assert.ok(error.cause instanceof Error);
        return true;
    });
    const appends = calls.filter(isDataAppend);
    assert.equal(appends.length, 2);
    assert.equal(calls.indexOf(appends[1]), calls.length - 1);
});

test('シート共有が失敗した相手のフォルダ共有を飛ばし次の相手を招待する', async () => {
    const calls = fakeApi({ shareFails: 'a@example.com' });
    const result = await run(plan(), ['a@example.com', 'b@example.com']);
    assert.deepEqual(result.shared, ['b@example.com']);
    assert.equal(result.shareFailures[0].email, 'a@example.com');
    assert.deepEqual(calls.filter(c => c.url.includes('/permissions')).map(c => c.body.emailAddress),
        ['a@example.com', 'b@example.com', 'b@example.com']);
});

test('フォルダ整理が失敗しても取り込みとシート共有を続ける', async () => {
    const calls = fakeApi({ folderFails: true });
    const result = await run(plan(), ['a@example.com']);
    assert.equal(result.folderId, null);
    assert.equal(calls.filter(isFulltextFolderCreation).length, 0);
    assert.equal(result.importedCount, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(calls.filter(c => c.url.includes('/permissions')).length, 1);
});

test('フォルダ共有と統計保存の失敗は警告に留める', async () => {
    fakeApi({ folderShareFails: true, statsFails: true });
    const result = await run(plan(), ['a@example.com']);
    assert.deepEqual(result.shared, ['a@example.com']);
    assert.equal(result.shareFailures.length, 0);
    assert.equal(result.folderShareFailures.length, 1);
    assert.equal(result.warnings.length, 1);
});

test('フルテキスト保存用フォルダの作成が失敗しても取り込みと共有を続ける', async () => {
    const calls = fakeApi({ fulltextFolderFails: true });
    const result = await runCreateProject({
        title: '試験', fileName: 'input.ris', plan: plan(), share: ['a@example.com'],
        formatError: error => (error as Error).message,
    });
    assert.equal(calls.filter(isFulltextFolderCreation).length, 1);
    assert.equal(calls.filter(isDataAppend).length, 1);
    assert.equal(result.importedCount, 1);
    assert.deepEqual(result.shared, ['a@example.com']);
    assert.equal(calls.filter(c => c.url.includes('/permissions')).length, 2);
    assert.deepEqual(result.warnings, [
        'フルテキスト保存用フォルダを作成できませんでした: Driveフォルダの作成に失敗しました: 全文フォルダ作成失敗',
    ]);
});

test('空の取り込みでは API を呼ばない', async () => {
    const calls = fakeApi();
    await assert.rejects(run(plan(0)), /有効な文献がありません/);
    assert.equal(calls.length, 0);
});

test('取り込み計画で DOI 重複・抄録切り詰め・ソース名を反映する', () => {
    const ris = `TY  - JOUR\nTI  - 文献 A\nDO  - 10.1234/test\nAB  - ${'a'.repeat(15001)}\nER  -\n` +
        'TY  - JOUR\nTI  - 文献 B\nDO  - 10.1234/test\nER  -\n';
    const result = planImport(ris, 'input.ris');
    assert.equal(result.references.length, 2);
    assert.equal(result.toImport.length, 1);
    assert.equal(result.duplicateCount, 1);
    assert.equal(result.truncatedAbstractCount, 1);
    assert.ok(result.references.every(ref => ref.source_file === 'input.ris'));
    assert.equal(isAbstractTruncated('a'.repeat(15000)), false);
    assert.equal(isAbstractTruncated(truncateAbstract('a'.repeat(15001))), true);
    assert.equal(isAbstractTruncated(undefined), false);
});

test('重複候補の保存は全バッチ追記と統計保存の後に行う', async () => {
    const calls = fakeApi();
    const importPlan = planImport('TY  - JOUR\nTI  - 同じタイトル\nER  -\nTY  - JOUR\nTI  - 同じタイトル\nER  -', 'input.ris');
    assert.equal(importPlan.reviewPairs.length, 1);
    await run(importPlan);
    const candidateIndex = calls.findIndex(c => c.url.includes('Duplicate_Candidates'));
    assert.ok(candidateIndex > calls.findIndex(isDataAppend));
    assert.ok(candidateIndex > calls.findIndex(c => c.body.values?.[0]?.[0] === 'import_stats'));
});

test('dry-run は環境変数も通信も不要で 6 行を出す', async () => {
    const calls = fakeApi();
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tiab-cli-'));
    try {
        const file = path.join(directory, 'input.ris');
        await writeFile(file, 'TY  - JOUR\nTI  - 文献\nER  -\n');
        const stdout: string[] = [];
        const stderr: string[] = [];
        const io = { stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s),
            get env(): NodeJS.ProcessEnv { throw new Error('環境変数を読んではいけません'); } };
        assert.equal(await main(['--title', '試験', '--ris', file, '--dry-run'], io), 0);
        assert.equal(stdout.length, 6);
        assert.equal(stderr.length, 0);
        assert.equal(calls.length, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('必須引数がなければ終了コード 2', async () => {
    const errors: string[] = [];
    assert.equal(await main([], { stdout: () => {}, stderr: line => errors.push(line), env: {} }), 2);
    assert.match(errors.join('\n'), /必須/);
});

async function runMain(count: number, fakeOptions: Parameters<typeof fakeApi>[0]) {
    const calls = fakeApi(fakeOptions);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tiab-cli-main-'));
    try {
        const file = path.join(directory, 'input.ris');
        const credentialsPath = path.join(directory, 'credentials.json');
        await writeFile(file, Array.from({ length: count }, (_, i) => `TY  - JOUR\nTI  - 文献 ${i}\nER  -\n`).join(''));
        await saveCredentials(credentialsPath, { refresh_token: 'fake-refresh-value', client_id: 'desktop-client', scope: '', saved_at: '' });
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await main(['--title', '試験', '--ris', file, '--share', 'a@example.com,b@example.com'], {
            stdout: line => stdout.push(line), stderr: line => stderr.push(line),
            env: { CLI_OAUTH_CLIENT_ID: 'desktop-client', CLI_OAUTH_CLIENT_SECRET: 'fake-client-secret', TIAB_CLI_CREDENTIALS_PATH: credentialsPath },
        });
        assert.ok(![...stdout, ...stderr].join('\n').includes('fake-'));
        return { code, stdout, stderr, calls };
    } finally { await rm(directory, { recursive: true, force: true }); }
}

test('成功時はログイン・結果・Picker 案内を出し終了コード 0', async () => {
    const result = await runMain(1, {});
    assert.equal(result.code, 0);
    assert.equal(result.stdout[0], 'ログイン中: owner@example.com');
    assert.ok(result.stdout.includes('spreadsheet_id: sheet-test'));
    assert.ok(result.stdout.includes('shared: a@example.com,b@example.com'));
    assert.equal(result.stdout[result.stdout.length - 1], PICKER_GUIDANCE);
    assert.deepEqual(result.stderr, []);
});

test('シート共有の部分失敗は結果と案内を出して終了コード 1', async () => {
    const result = await runMain(1, { shareFails: 'a@example.com' });
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes('shared: b@example.com'));
    assert.equal(result.stdout[result.stdout.length - 1], PICKER_GUIDANCE);
    assert.ok(result.stderr.some(line => line.includes('a@example.com の招待に失敗しました')));
});

test('途中失敗は確認済み件数・不明な範囲・元の原因を表示する', async () => {
    const result = await runMain(1201, { failBatch: 2 });
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes('確認できた取り込み: 500 / 1201 件'));
    assert.ok(result.stderr.some(line => line.includes('501〜1000 件目')));
    assert.ok(result.stderr.some(line => line.includes('原因: Failed to append rows: 追記失敗')));
    assert.equal(result.calls.filter(call => call.url.includes('/permissions')).length, 0);
});
