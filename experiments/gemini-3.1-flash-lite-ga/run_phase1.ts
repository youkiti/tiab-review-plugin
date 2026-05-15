/**
 * Phase 1: depression データセットで最適条件を探索
 * C1-C4 の4条件を順次実行
 */
import path from 'path';
import { execSync } from 'child_process';

async function main() {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const conditions = ['C1', 'C2', 'C3', 'C4'];
    const dataset = 'depression';
    const tier = 'tier_max';

    console.log('=== Phase 1: depression で最適条件探索 ===');
    console.log(`条件: ${conditions.join(', ')}`);
    console.log(`データセット: ${dataset}`);
    console.log(`Tier: ${tier}`);
    console.log(`合計: ${conditions.length} 実験\n`);

    for (const condition of conditions) {
        console.log(`\n--- 実行中: ${dataset} × ${condition} ---`);

        const cmd = `npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json experiments/gemini-3.1-flash-lite-ga/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}`;

        try {
            execSync(cmd, {
                cwd: projectRoot,
                stdio: 'inherit',
                timeout: 1800000, // 30分タイムアウト
            });
        } catch (error) {
            console.error(`エラー: ${dataset} / ${condition}:`, (error as Error).message);
            // 次の条件へ続行
        }
    }

    console.log('\n=== Phase 1 完了 ===');
    console.log('結果は experiments/gemini-3.1-flash-lite-ga/results/ を確認してください。');
}

main().catch(console.error);
