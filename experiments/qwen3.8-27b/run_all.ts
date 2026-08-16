/**
 * 全 condition を順次実行するラッパー
 *
 * 使い方:
 *   npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/run_all.ts
 *   npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/run_all.ts --sample 100
 *
 * 並列実行はしない。OpenRouter のレート制限とコスト見積りを把握しやすくするため、
 * condition ごとに直列で回す（各 condition 内では runner.ts 側で並列化）。
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { spawn } from 'child_process';

interface Condition { id: string; provider: string; model: string }
interface BenchConfig { conditions: Condition[] }

function parseArgs(): { dataset: string; sample?: number; only?: string[] } {
    const args = process.argv.slice(2);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const k = args[i].slice(2);
            const v = args[i + 1];
            if (v && !v.startsWith('--')) { out[k] = v; i++; }
        }
    }
    return {
        dataset: out.dataset || 'depression',
        sample: out.sample ? parseInt(out.sample, 10) : undefined,
        only: out.only ? out.only.split(',') : undefined,
    };
}

function runCondition(args: { dataset: string; condition: string; sample?: number }): Promise<number> {
    return new Promise(resolve => {
        const runnerArgs = [
            'ts-node',
            '--project',
            path.join(__dirname, 'tsconfig.json'),
            path.join(__dirname, 'runner.ts'),
            '--dataset', args.dataset,
            '--condition', args.condition,
        ];
        if (args.sample) {
            runnerArgs.push('--sample', String(args.sample));
        }
        const child = spawn('npx', runnerArgs, {
            stdio: 'inherit',
            shell: process.platform === 'win32',
            env: process.env,
        });
        child.on('exit', code => resolve(code ?? 1));
    });
}

async function main(): Promise<void> {
    const args = parseArgs();
    const configPath = path.join(__dirname, 'config.json');
    const config: BenchConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const filtered = args.only
        ? config.conditions.filter(c => args.only!.includes(c.id))
        : config.conditions;

    console.log(`実行対象: ${filtered.map(c => c.id).join(', ')}`);
    console.log(`dataset=${args.dataset} sample=${args.sample ?? '全件'}`);
    console.log('');

    const summary: Array<{ id: string; exitCode: number }> = [];
    for (const c of filtered) {
        console.log(`\n========================================`);
        console.log(`condition: ${c.id} (${c.provider} / ${c.model})`);
        console.log(`========================================`);
        const code = await runCondition({ dataset: args.dataset, condition: c.id, sample: args.sample });
        summary.push({ id: c.id, exitCode: code });
        if (code !== 0) {
            console.warn(`⚠️ ${c.id} は exit code ${code} で終了`);
        }
    }

    console.log('\n\n=== 全 condition 完了 ===');
    for (const s of summary) {
        console.log(`${s.id}: ${s.exitCode === 0 ? 'OK' : 'FAIL (' + s.exitCode + ')'}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
