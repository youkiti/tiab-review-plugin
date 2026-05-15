/**
 * Phase 2: 最適条件を全データセットで検証
 * Phase 1 で特定した最適条件を cq1-cq5, wilson で実行
 *
 * 使用法:
 *   npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json \
 *     experiments/gemini-3.1-flash-lite-ga/run_phase2.ts --condition C4
 */
import path from 'path';
import { execSync } from 'child_process';

function getConditionArg(): string {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--condition' && args[i + 1]) {
            return args[i + 1];
        }
    }
    console.error('エラー: --condition 引数が必要です（例: --condition C4）');
    process.exit(1);
}

async function main() {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const condition = getConditionArg();
    const datasets = ['cq1', 'cq2', 'cq3', 'cq4', 'cq5', 'wilson'];
    const tier = 'tier_max';

    console.log('=== Phase 2: 全データセットで検証 ===');
    console.log(`最適条件: ${condition}`);
    console.log(`データセット: ${datasets.join(', ')}`);
    console.log(`Tier: ${tier}`);
    console.log(`合計: ${datasets.length} 実験\n`);

    for (const dataset of datasets) {
        console.log(`\n--- 実行中: ${dataset} × ${condition} ---`);

        const cmd = `npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json experiments/gemini-3.1-flash-lite-ga/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}`;

        try {
            execSync(cmd, {
                cwd: projectRoot,
                stdio: 'inherit',
                timeout: 3600000, // 60分タイムアウト（大規模データセット用）
            });
        } catch (error) {
            console.error(`エラー: ${dataset} / ${condition}:`, (error as Error).message);
            // 次のデータセットへ続行
        }
    }

    console.log('\n=== Phase 2 完了 ===');
    console.log('結果は experiments/gemini-3.1-flash-lite-ga/results/ を確認してください。');
}

main().catch(console.error);
