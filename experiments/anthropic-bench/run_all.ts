/**
 * 指定のデータセットで全条件（A-H1, A-S1）を順次実行するラッパー
 *
 * 使い方:
 *   npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/run_all.ts --dataset depression
 *   ... --dataset depression --sample 50          （smoke）
 *   ... --dataset cq1,cq2,cq3,cq4,cq5 --only A-H1  （CQ1〜5。depression で基準を満たした条件だけ）
 *   ... --dataset depression --dry-run             （API を呼ばない確認）
 *
 * 並列実行はしない。費用の見積もりを把握しやすくするため、データセット × 条件を直列で回す
 * （各実行の中では runner.ts 側で並列化）。--only を省略すると config.json の全条件を回す。
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { spawn } from 'child_process';

interface Condition { id: string; provider: string; model: string }
interface BenchConfig { conditions: Condition[] }

function parseArgs(): { datasets: string[]; sample?: number; only?: string[]; threshold?: string; dryRun: boolean } {
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
        datasets: (out.dataset || 'depression').split(','),
        sample: out.sample ? parseInt(out.sample, 10) : undefined,
        only: out.only ? out.only.split(',') : undefined,
        threshold: out.threshold,
        dryRun: args.includes('--dry-run'),
    };
}

function runCondition(args: { dataset: string; condition: string; sample?: number; threshold?: string; dryRun: boolean }): Promise<number> {
    return new Promise(resolve => {
        const runnerArgs = [
            'ts-node',
            '--project',
            path.join(__dirname, '..', 'tsconfig.json'),
            path.join(__dirname, 'runner.ts'),
            '--dataset', args.dataset,
            '--condition', args.condition,
        ];
        if (args.sample) runnerArgs.push('--sample', String(args.sample));
        if (args.threshold) runnerArgs.push('--threshold', args.threshold);
        if (args.dryRun) runnerArgs.push('--dry-run');
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
    console.log(`dataset=${args.datasets.join(',')} sample=${args.sample ?? '全件'}${args.dryRun ? ' (dry-run)' : ''}`);

    const summary: Array<{ id: string; dataset: string; exitCode: number }> = [];
    for (const dataset of args.datasets) {
        for (const c of filtered) {
            console.log(`\n========================================`);
            console.log(`dataset: ${dataset} / condition: ${c.id} (${c.provider} / ${c.model})`);
            console.log(`========================================`);
            const code = await runCondition({ dataset, condition: c.id, sample: args.sample, threshold: args.threshold, dryRun: args.dryRun });
            summary.push({ id: c.id, dataset, exitCode: code });
            if (code !== 0) {
                console.warn(`警告: ${dataset} / ${c.id} は exit code ${code} で終了`);
            }
        }
    }

    console.log('\n\n=== 全 condition 完了 ===');
    for (const s of summary) {
        console.log(`${s.dataset} / ${s.id}: ${s.exitCode === 0 ? 'OK' : 'FAIL (' + s.exitCode + ')'}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
