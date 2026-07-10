/**
 * threshold スイープ（API 追加コストなし）
 *
 * results/ の全件 items_*.json（sampleSize 指定なしの最新）を読み、
 * 複数の threshold で Recall / Specificity / Precision / Fβ(β=7) を再計算する。
 * include_probability >= threshold を include と判定する。
 *
 * 使い方:
 *   npx ts-node --project experiments/tsconfig.json experiments/gpt-5.6/threshold_sweep.ts
 */

import fs from 'fs';
import path from 'path';

interface Item {
    include_probability: number | null;
    label_included: number;
}

const THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];
const CONDITIONS = ['G56-none', 'G56-low', 'G56-med', 'G56-high'];

function metrics(items: Item[], threshold: number) {
    let tp = 0, fp = 0, tn = 0, fn = 0, nullCount = 0;
    for (const it of items) {
        if (it.include_probability === null) { nullCount++; continue; }
        const predicted = it.include_probability >= threshold ? 1 : 0;
        const actual = it.label_included === 1 ? 1 : 0;
        if (predicted === 1 && actual === 1) tp++;
        else if (predicted === 1 && actual === 0) fp++;
        else if (predicted === 0 && actual === 0) tn++;
        else fn++;
    }
    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const b2 = 49;
    const fBeta = sensitivity + precision > 0
        ? (1 + b2) * (precision * sensitivity) / (b2 * precision + sensitivity)
        : 0;
    return { threshold, tp, fp, tn, fn, nullCount, sensitivity, specificity, precision, fBeta };
}

function latestFullItems(resultsDir: string, condId: string): Item[] | null {
    const logs = fs.readdirSync(resultsDir)
        .filter(f => f.includes(condId) && f.startsWith('experiment_') && f.endsWith('.log.json'))
        .sort();
    // sampleSize 未指定（全件）の最新ログに対応する items を選ぶ
    for (let i = logs.length - 1; i >= 0; i--) {
        const log = JSON.parse(fs.readFileSync(path.join(resultsDir, logs[i]), 'utf-8'));
        if (log.parameters?.sampleSize !== undefined) continue;
        const id = log.experimentId;
        const itemsPath = path.join(resultsDir, `items_${id}.json`);
        if (fs.existsSync(itemsPath)) {
            return JSON.parse(fs.readFileSync(itemsPath, 'utf-8')) as Item[];
        }
    }
    return null;
}

function pct(v: number): string { return (v * 100).toFixed(1) + '%'; }

function main(): void {
    const resultsDir = path.join(__dirname, 'results');
    const lines: string[] = [];
    lines.push('# gpt-5.6-luna threshold スイープ (depression, N=1,993 / 陽性280)');
    lines.push('');
    lines.push('保存済み items から再計算（API 追加コストなし）。既定 threshold=0.5。採用基準 Recall≥95%。');
    lines.push('');

    for (const cond of CONDITIONS) {
        const items = latestFullItems(resultsDir, cond);
        if (!items) continue;
        // include_probability の分布サマリ
        const probs = items.map(i => i.include_probability).filter((p): p is number => p !== null);
        const buckets = { '<0.1': 0, '0.1-0.5': 0, '0.5-0.9': 0, '>=0.9': 0 };
        for (const p of probs) {
            if (p < 0.1) buckets['<0.1']++;
            else if (p < 0.5) buckets['0.1-0.5']++;
            else if (p < 0.9) buckets['0.5-0.9']++;
            else buckets['>=0.9']++;
        }
        lines.push(`## ${cond}`);
        lines.push('');
        lines.push(`確率分布: <0.1=${buckets['<0.1']} / 0.1-0.5=${buckets['0.1-0.5']} / 0.5-0.9=${buckets['0.5-0.9']} / ≥0.9=${buckets['>=0.9']}`);
        lines.push('');
        lines.push('| threshold | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |');
        lines.push('|---|---|---|---|---|---|---|---|---|');
        for (const t of THRESHOLDS) {
            const m = metrics(items, t);
            const recallMark = m.sensitivity >= 0.95 ? ' ✅' : '';
            lines.push(`| ${t.toFixed(2)} | **${pct(m.sensitivity)}**${recallMark} | ${pct(m.specificity)} | ${pct(m.precision)} | ${pct(m.fBeta)} | ${m.tp} | ${m.fp} | ${m.tn} | ${m.fn} |`);
        }
        lines.push('');
    }

    const out = lines.join('\n') + '\n';
    const outPath = path.join(__dirname, 'threshold_sweep.md');
    fs.writeFileSync(outPath, out);
    console.log(out);
    console.log(`\n出力: ${outPath}`);
}

main();
