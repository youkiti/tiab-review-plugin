// 対象を検証し、CLI による逐次保存型ベンチマークを実行する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, loadInputs, resultsRoot } from './lib/inputs.mjs';
import { buildCliArgs, invokeClaude } from './lib/cli.mjs';
import { buildScreeningPrompt, SCREENING_SCHEMA, sha256Hex } from './lib/prompt.mjs';
import { ledgerPaths, readJsonl, compactByRefId } from './lib/ledger.mjs';
import { runCondition } from './lib/run-core.mjs';

async function main() {
    let inputs;
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        inputs = loadInputs(options);
    } catch (error) {
        console.error(`入力エラー: ${error.message}`);
        return 2;
    }
    const { config, configText, records, conditions } = inputs;
    const condition = conditions[0];
    config.concurrency = options['--concurrency'] ?? config.concurrency;
    config.cli.bin = options['--claude-bin'] ?? config.cli.bin;
    const paths = ledgerPaths(resultsRoot, condition.id);
    const alreadyDone = () => {
        const done = new Set(compactByRefId(readJsonl(paths.items)).map((row) => row.ref_id));
        return records.filter((record) => done.has(record.id)).length;
    };
    if (options['--dry-run']) {
        config.cliVersion = 'dry-run';
        const prompt = buildScreeningPrompt({ ...config, criteria: config.dataset.criteria }, records[0]);
        console.log(`対象: ${records.length} 件 / 保存済み: ${alreadyDone()} 件 / CLI バージョン: ${config.cliVersion}`);
        console.log(`引数配列: ${JSON.stringify(buildCliArgs(condition, SCREENING_SCHEMA))}`);
        console.log(`先頭プロンプト: sha256=${sha256Hex(prompt)} / 文字数=${prompt.length}`);
        return 0;
    }
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    paths.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-headless-'));
    let result;
    try {
        const version = await invokeClaude({
            bin: config.cli.bin, args: ['--version'], prompt: '', timeoutMs: config.cli.timeoutMs, cwd: paths.cwd,
        });
        if (version.spawnError || version.timedOut || version.exitCode !== 0 || !version.stdout.trim()) {
            throw new Error('CLI バージョンの取得に失敗しました');
        }
        config.cliVersion = version.stdout.trim();
        result = await runCondition({
            records, condition, config, paths, invoke: invokeClaude, sleep, now: Date.now, log: console.log,
        });
    } catch (error) {
        result = {
            target: records.length, alreadyDone: alreadyDone(), succeeded: 0,
            failedRecords: 0, failedAttempts: 0, aborted: true, abortReason: error.message,
        };
        console.error(`実行エラー: ${error.message}`);
    } finally {
        // mkdtempSync が返した今回専用のディレクトリだけを破棄する。
        fs.rmSync(paths.cwd, { recursive: true, force: true });
    }
    const ended = Date.now();
    fs.mkdirSync(resultsRoot, { recursive: true });
    const logPath = path.join(resultsRoot, `run_${condition.id}_${startedAt.replace(/[:.]/g, '-')}.log.json`);
    fs.writeFileSync(logPath, JSON.stringify({
        arguments: process.argv.slice(2), condition, config_sha256: sha256Hex(configText),
        cli_version: config.cliVersion ?? null, node_version: process.version,
        started_at: startedAt, finished_at: new Date(ended).toISOString(), wall_clock_ms: ended - started,
        ...result,
    }, null, 4) + '\n', 'utf8');
    return !result.aborted && alreadyDone() === records.length ? 0 : 1;
}

try {
    process.exitCode = await main();
} catch (error) {
    console.error(`実行エラー: ${error.message}`);
    process.exitCode = 1;
}
