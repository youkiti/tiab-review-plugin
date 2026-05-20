/**
 * Phase 1: depression データセットで D1-D4 を順次実行
 */
import path from 'path';
import { execSync } from 'child_process';

async function main() {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const args = process.argv.slice(2);
    const sampleIdx = args.indexOf('--sample');
    const sampleArg = sampleIdx >= 0 ? ` --sample ${args[sampleIdx + 1]}` : '';
    const tierIdx = args.indexOf('--tier');
    const tier = tierIdx >= 0 ? args[tierIdx + 1] : 'tier_max';

    // D4 (HIGH) はコスト過大 ($104/データセット) のため除外（ユーザー判断 2026-05-20）
    const conditions = ['D1', 'D2', 'D3'];
    const dataset = 'depression';

    console.log('=== Phase 1: depression で thinking_level 最適条件探索 ===');
    console.log(`条件: ${conditions.join(', ')}`);
    console.log(`データセット: ${dataset}`);
    console.log(`Tier: ${tier}${sampleArg ? `, サンプル: ${sampleArg.trim()}` : ''}`);
    console.log(`合計: ${conditions.length} 実験\n`);

    for (const condition of conditions) {
        console.log(`\n--- 実行中: ${dataset} × ${condition} ---`);
        const cmd = `npx ts-node --project experiments/gemini-3.5-flash/tsconfig.json experiments/gemini-3.5-flash/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}${sampleArg}`;
        try {
            execSync(cmd, {
                cwd: projectRoot,
                stdio: 'inherit',
                timeout: 3600000, // 60分タイムアウト
            });
        } catch (error) {
            console.error(`エラー: ${dataset} / ${condition}:`, (error as Error).message);
        }
    }

    console.log('\n=== Phase 1 完了 ===');
    console.log('結果は experiments/gemini-3.5-flash/results/ を確認してください。');
}

main().catch(console.error);
