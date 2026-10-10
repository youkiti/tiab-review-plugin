// ローカルの偽プロセスで標準入力・終了・タイムアウトを検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeClaude } from '../lib/cli.mjs';

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-invoke-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('偽プロセスは標準入力と空の引数を受信し、警告も保存する', async (t) => {
    const cwd = temporary(t);
    const script = [
        'process.stdin.setEncoding("utf8");',
        'let text = "";',
        'process.stdin.on("data", data => { text += data; });',
        'process.stdin.on("end", () => {',
        '    process.stdout.write(JSON.stringify({ text, args: process.argv.slice(1), cwd: process.cwd() }));',
        '    process.stderr.write("警告");',
        '});',
    ].join('\n');
    const result = await invokeClaude({
        bin: process.execPath, args: ['-e', script, '', '二つ目'], prompt: '日本語の入力', timeoutMs: 5000, cwd,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '警告');
    assert.deepEqual(JSON.parse(result.stdout), { text: '日本語の入力', args: ['', '二つ目'], cwd });
});

test('偽プロセスのタイムアウトを通知する', async (t) => {
    const result = await invokeClaude({
        bin: process.execPath, args: ['-e', 'setInterval(() => {}, 1000);'],
        prompt: '', timeoutMs: 100, cwd: temporary(t),
    });
    assert.equal(result.timedOut, true);
});

test('存在しない実行ファイルでも reject せず起動エラーを返す', async (t) => {
    const cwd = temporary(t);
    const result = await invokeClaude({ bin: path.join(cwd, '存在しない.exe'), args: [], prompt: '', timeoutMs: 100, cwd });
    assert.ok(result.spawnError);
});
