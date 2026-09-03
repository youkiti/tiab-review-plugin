/**
 * Phase 1: depression データセットで F1（既定）を実行する。
 *
 * 段階実行ルール（experiments/gemini-3.8-flash/plan.md「段階実行ルール」参照）:
 *   1. F1 (thinking_level=LOW) を smoke (n=50) → コストを外挿してユーザーが GO/NO-GO
 *   2. GO なら F1 をフル実行 (n=1,993)
 *   3. Recall ≥ 0.93 なら F2 (thinking_level=MEDIUM) の smoke → 同様に GO/NO-GO → フル実行
 *      Recall < 0.93 なら F2 は実行せず打ち切り
 *   4. threshold スイープ（API 追加費用ゼロ、threshold_sweep.ts）
 *
 * このスクリプトは既定では F1 のみを実行する。F2 は `--condition F2` のように
 * 明示指定したときだけ実行する（3.7 版のように E1/E3 を無条件に連続実行しない）。
 *
 * 既定は smoke（tier_smoke, n=50）。フル実行（tier_max, 全1,993件）に進むのは
 * `--tier tier_max` を明示したときだけ（smoke の実測コストから外挿してユーザーが
 * GO/NO-GO を出した後、というのが plan.md の段階実行ルール）。
 *
 * 使い方:
 *   # smoke（既定。tier_smoke, n=50）
 *   npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
 *     experiments/gemini-3.8-flash/run_phase1.ts [--condition F1|F2]
 *
 *   # フル実行（ユーザー GO 後のみ、明示指定が必要）
 *   npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json \
 *     experiments/gemini-3.8-flash/run_phase1.ts --tier tier_max [--condition F1|F2] [--sample N]
 */
import path from 'path';
import { execSync } from 'child_process';

async function main() {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const args = process.argv.slice(2);

    const conditionIdx = args.indexOf('--condition');
    const condition = conditionIdx >= 0 ? args[conditionIdx + 1] : 'F1';

    const tierIdx = args.indexOf('--tier');
    const tier = tierIdx >= 0 ? args[tierIdx + 1] : 'tier_smoke';
    const isFullRun = tier === 'tier_max';

    const sampleIdx = args.indexOf('--sample');
    // 既定は smoke (n=50)。tier_max を明示し、かつ --sample も明示しない場合のみ
    // 全件(--sample 省略 = 全1,993件) に進む。
    const sample = sampleIdx >= 0 ? args[sampleIdx + 1] : (isFullRun ? undefined : '50');
    const sampleArg = sample !== undefined ? ` --sample ${sample}` : '';

    const dataset = 'depression';

    console.log('=== Phase 1: depression で gemini-3.8-flash を実行 ===');
    console.log(`条件: ${condition}${conditionIdx < 0 ? '（既定。F2 に進む場合は --condition F2 を明示すること）' : ''}`);
    console.log(`データセット: ${dataset}`);
    console.log(`Tier: ${tier}${sampleArg ? `, サンプル: ${sampleArg.trim()}` : ''}`);
    console.log('');
    console.log('*** 注意: この実行は Gemini API を呼び出すため課金が発生する ***');
    console.log('smoke (n=50 目安) の実測コストからフル件数 (n=1,993) のコストを外挿し、');
    console.log('その数値を人間に提示して GO/NO-GO の判断を仰ぐ運用である。');
    console.log('自動で全件フル実行に進むことはない（フル実行は --tier tier_max を明示したときのみ）。');
    console.log('');
    if (isFullRun) {
        console.log(`${condition} を tier_max で${sampleArg ? `${sample}件` : '全1,993件'} 実行する（フル実行が明示指定された）。`);
    } else {
        console.log(`${condition} を tier_smoke で ${sample}件 実行する（フル実行は --tier tier_max を明示すること）。`);
    }
    console.log('');

    console.log(`\n--- 実行中: ${dataset} × ${condition} ---`);
    const cmd = `npx ts-node --project experiments/gemini-3.8-flash/tsconfig.json experiments/gemini-3.8-flash/runner.ts --dataset ${dataset} --condition ${condition} --tier ${tier}${sampleArg}`;
    try {
        execSync(cmd, {
            cwd: projectRoot,
            stdio: 'inherit',
            timeout: 3600000, // 60分タイムアウト
        });
    } catch (error) {
        console.error(`エラー: ${dataset} / ${condition}:`, (error as Error).message);
    }

    console.log('\n=== Phase 1 完了 ===');
    console.log('結果は experiments/gemini-3.8-flash/results/ を確認してください。');
}

main().catch(console.error);
