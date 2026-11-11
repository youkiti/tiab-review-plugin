/**
 * threshold スイープ（API 追加費用なし）
 *
 * results/ の全件の最新の記録（items_*.json）を読み、0.05 刻みの閾値で
 * Recall / Specificity / Precision / Fβ(β=7) を再計算する。include_probability >= threshold を include と判定する。
 * 失敗（include_probability が null）の件は、runner.ts の評価と同じく数えない。
 * 各条件について、Recall 95% を保つ最大の閾値と、Recall 90% を保つ最大の閾値も示す。
 *
 * 使い方:
 *   npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/threshold_sweep.ts
 *   ... --dataset depression              （既定。CQ を見るときは cq1 など）
 *   ... --results-dir <dir> --out-dir <dir>（テスト用に入出力を差し替える）
 */

import fs from 'fs';
import path from 'path';
import { calculateMetrics, loadLatestRuns, pct, readFlag } from './common';

const THRESHOLDS = Array.from({ length: 19 }, (_, i) => (i + 1) / 20); // 0.05 .. 0.95

function main(): void {
    const dataset = readFlag('dataset') ?? 'depression';
    const resultsDir = readFlag('results-dir') ?? path.join(__dirname, 'results');
    const outDir = readFlag('out-dir') ?? __dirname;
    const { full } = loadLatestRuns(resultsDir);
    const runs = full.filter(r => r.log.parameters.dataset === dataset);
    if (runs.length === 0) {
        console.error(`${dataset} の全件の記録が ${resultsDir} に見つかりません`);
        process.exit(1);
    }

    const lines: string[] = [];
    const first = runs[0].log.parameters;
    lines.push(`# Anthropic 同梱モデル threshold スイープ (${dataset}, N=${first.totalRecords})`);
    lines.push('');
    lines.push('保存済み items から再計算（API 追加費用なし）。実行時の閾値は 0.5。同梱の採用基準は Recall ≥ 90%、既定モデルの置き換え基準は Recall ≥ 95%。');
    lines.push('失敗（include_probability が null）の件は数えない。');
    lines.push('');

    for (const { log, items } of runs) {
        const cond = log.parameters.condition;
        const probs = items.map(i => i.include_probability).filter((p): p is number => p !== null);
        const buckets = { '<0.1': 0, '0.1-0.5': 0, '0.5-0.9': 0, '>=0.9': 0 };
        for (const p of probs) {
            if (p < 0.1) buckets['<0.1']++;
            else if (p < 0.5) buckets['0.1-0.5']++;
            else if (p < 0.9) buckets['0.5-0.9']++;
            else buckets['>=0.9']++;
        }
        const rows = THRESHOLDS.map(t => calculateMetrics(items, t));
        const maxKeeping = (min: number) => {
            const ok = rows.filter(m => m.sensitivity >= min);
            return ok.length > 0 ? ok[ok.length - 1] : undefined;
        };
        const m95 = maxKeeping(0.95);
        const m90 = maxKeeping(0.90);

        lines.push(`## ${cond.id} (${cond.model}, effort ${cond.reasoningEffort ?? '-'})`);
        lines.push('');
        lines.push(`確率分布: <0.1=${buckets['<0.1']} / 0.1-0.5=${buckets['0.1-0.5']} / 0.5-0.9=${buckets['0.5-0.9']} / ≥0.9=${buckets['>=0.9']}（失敗 ${items.length - probs.length} 件を除く）`);
        lines.push('');
        lines.push('| threshold | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |');
        lines.push('|---|---|---|---|---|---|---|---|---|');
        for (const m of rows) {
            const mark = (m.sensitivity >= 0.95 ? ' ≥95%' : m.sensitivity >= 0.90 ? ' ≥90%' : '') + (Math.abs(m.threshold - 0.5) < 1e-9 ? ' (実行時)' : '');
            lines.push(`| ${m.threshold.toFixed(2)} | **${pct(m.sensitivity)}**${mark} | ${pct(m.specificity)} | ${pct(m.precision)} | ${pct(m.fBetaScore)} | ${m.truePositives} | ${m.falsePositives} | ${m.trueNegatives} | ${m.falseNegatives} |`);
        }
        lines.push('');
        lines.push(`- Recall 95% を保つ最大の閾値: ${m95 ? `${m95.threshold.toFixed(2)}（Recall ${pct(m95.sensitivity)} / Specificity ${pct(m95.specificity)} / Precision ${pct(m95.precision)}）` : '0.05 でも届かない'}`);
        lines.push(`- Recall 90% を保つ最大の閾値: ${m90 ? `${m90.threshold.toFixed(2)}（Recall ${pct(m90.sensitivity)} / Specificity ${pct(m90.specificity)} / Precision ${pct(m90.precision)}）` : '0.05 でも届かない'}`);
        lines.push('');
    }

    const out = lines.join('\n') + '\n';
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'threshold_sweep.md');
    fs.writeFileSync(outPath, out);
    console.log(out);
    console.log(`\n出力: ${outPath}`);
}

main();
