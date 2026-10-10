// 偽の呼び出しを用い、再開・失敗保存・停止・ラベル非漏洩を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCondition } from '../lib/run-core.mjs';
import { ledgerPaths, readJsonl, appendJsonl } from '../lib/ledger.mjs';
import { experimentRoot } from '../lib/inputs.mjs';

function setup(t, overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-core-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = JSON.parse(fs.readFileSync(path.join(experimentRoot, 'config.json'), 'utf8'));
    Object.assign(config, { concurrency: 1, cliVersion: '偽 CLI', ...overrides });
    const paths = { ...ledgerPaths(directory, 'H1'), cwd: directory };
    const records = ['a', 'b', 'c'].map((id) => ({ id, title: `題名 ${id}`, abstract: '抄録' }));
    const logs = [];
    const delays = [];
    return {
        records, condition: config.conditions[0], config, paths,
        sleep: async (delay) => {
            delays.push(delay);
        },
        now: () => 0,
        log: (line) => {
            logs.push(line);
        },
        logs, delays,
    };
}

function ok(model = 'claude-haiku-5-5') {
    return {
        exitCode: 0, timedOut: false, spawnError: null, stderr: '',
        stdout: JSON.stringify({
            subtype: 'success', is_error: false, modelUsage: { [model]: {} },
            structured_output: { include_probability: 0.5, reasons: ['理由'], evidence: [] },
            usage: { input_tokens: 10 }, total_cost_usd: 0.01, duration_ms: 20,
        }),
    };
}
const failure = () => ({ exitCode: 1, timedOut: false, spawnError: null, stdout: '失敗'.repeat(1500), stderr: '詳細' });

test('保存済み文献を飛ばし、未処理だけを呼ぶ', async (t) => {
    const state = setup(t);
    appendJsonl(state.paths.items, { ref_id: 'a' });
    const prompts = [];
    const result = await runCondition({ ...state, invoke: async ({ prompt }) => {
        prompts.push(prompt);
        return ok();
    } });
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every((prompt) => !prompt.includes('題名 a')));
    assert.equal(result.alreadyDone, 1);
    assert.equal(result.succeeded, 2);
    const second = await runCondition({ ...state, invoke: async () => assert.fail('呼び出してはいけない') });
    assert.equal(second.alreadyDone, 3);
    assert.ok(state.logs.at(-1).includes('3/3 件完了'));
});

test('全試行に失敗した文献は items に存在せず全文も保存される', async (t) => {
    const state = setup(t);
    state.records = state.records.slice(0, 1);
    const result = await runCondition({ ...state, invoke: async () => failure() });
    assert.equal(result.failedRecords, 1);
    assert.equal(result.failedAttempts, 4);
    assert.equal(readJsonl(state.paths.items).length, 0);
    const failures = readJsonl(state.paths.failures);
    assert.equal(failures.length, 4);
    assert.equal(failures[0].stdout.length, 2000);
    assert.equal(readJsonl(state.paths.raw)[0].stdout.length, 3000);
    assert.deepEqual(state.delays, [5000, 10000, 20000]);
});

test('再試行成功は attempt 2 として保存する', async (t) => {
    const state = setup(t);
    state.records = state.records.slice(0, 1);
    let calls = 0;
    await runCondition({ ...state, invoke: async () => ++calls === 1 ? failure() : ok() });
    const item = readJsonl(state.paths.items)[0];
    assert.equal(item.attempt, 2);
    assert.equal(item.usage.thinking_tokens, 0);
    assert.equal(item.cli_version, '偽 CLI');
    assert.equal(item.started_at, '1970-01-01T00:00:00.000Z');
    assert.equal(item.prompt_sha256.length, 64);
});

test('モデル不一致で以後の呼び出しを停止する', async (t) => {
    const state = setup(t);
    let calls = 0;
    const result = await runCondition({ ...state, invoke: async () => {
        calls++;
        return ok('別モデル');
    } });
    assert.equal(calls, 1);
    assert.equal(result.aborted, true);
    assert.equal(readJsonl(state.paths.items).length, 0);
    assert.equal(readJsonl(state.paths.failures)[0].kind, 'model_mismatch');
});

test('全ワーカー共通の連続失敗上限で停止する', async (t) => {
    const state = setup(t, { concurrency: 2, abortAfterConsecutiveFailures: 2 });
    let calls = 0;
    const result = await runCondition({ ...state, invoke: async () => {
        calls++;
        return failure();
    } });
    assert.equal(calls, 2);
    assert.equal(result.aborted, true);
    assert.equal(result.failedAttempts, 2);
});

test('成功が連続失敗をリセットする', async (t) => {
    const state = setup(t, { abortAfterConsecutiveFailures: 2 });
    let calls = 0;
    const result = await runCondition({ ...state, invoke: async () => ++calls % 2 ? failure() : ok() });
    assert.equal(result.aborted, false);
    assert.equal(result.succeeded, 3);
});

test('停止時にも実行中の呼び出しの完了を保存する', async (t) => {
    const state = setup(t, { concurrency: 2 });
    let calls = 0;
    let finish;
    const running = runCondition({ ...state, invoke: async () => {
        calls++;
        if (calls === 1) {
            return ok('別モデル');
        }
        return new Promise((resolve) => {
            finish = resolve;
        });
    } });
    await Promise.resolve();
    finish(ok());
    const result = await running;
    assert.equal(calls, 2);
    assert.equal(result.aborted, true);
    assert.equal(result.succeeded, 1);
});

test('プロンプトには検出用ラベル名・値が漏れない', async (t) => {
    const state = setup(t);
    state.records = [{ id: 'a', title: '題名', abstract: '抄録', label_included: '秘密の正解マーカー' }];
    await runCondition({ ...state, invoke: async ({ prompt }) => {
        assert.ok(!prompt.includes('label_included'));
        assert.ok(!prompt.includes('秘密の正解マーカー'));
        return ok();
    } });
});
