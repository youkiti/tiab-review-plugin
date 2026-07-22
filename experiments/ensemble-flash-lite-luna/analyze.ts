/**
 * OR結合アンサンブル（flash-lite C1 OR gpt-5.6-luna）の性能を、既存のベンチマーク結果
 * （新規API呼び出しなし）を ref_id で突き合わせて計算するための使い捨てスクリプト。
 *
 * 入力:
 *  - experiments/gemini-3.1-flash-lite-ga/results/decisions_2026-05-15T12-17-04.json
 *    (condition C1: gemini-3.1-flash-lite, temperature=0, thinking無し。ラベル無し)
 *  - experiments/gpt-5.6/results/items_G56-{none,low,med}_*.json
 *    (gpt-5.6-luna, reasoning別3条件。label_included / include_probability あり)
 *
 * 計算方法・指標式は experiments/gpt-5.6/runner.ts の calculateMetrics と完全に一致させる。
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

interface DecisionRecord {
    ref_id: string;
    note: string; // JSON文字列
}

interface LunaItem {
    ref_id: string;
    label_included: number;
    include_probability: number | null;
    error?: string;
}

interface Evaluation {
    threshold: number;
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
    sensitivity: number;
    specificity: number;
    precision: number;
    fBetaScore: number;
}

const THRESHOLD = 0.5;

function calculateMetrics(
    rows: Array<{ predicted: number; actual: number }>,
    threshold: number
): Evaluation {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of rows) {
        const predicted = r.predicted;
        const actual = r.actual;
        if (predicted === 1 && actual === 1) tp++;
        else if (predicted === 1 && actual === 0) fp++;
        else if (predicted === 0 && actual === 0) tn++;
        else if (predicted === 0 && actual === 1) fn++;
    }
    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const beta = 7;
    const b2 = beta * beta;
    const fBetaScore = sensitivity + precision > 0
        ? (1 + b2) * (precision * sensitivity) / (b2 * precision + sensitivity)
        : 0;
    return { threshold, truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn, sensitivity, specificity, precision, fBetaScore };
}

function fmtPct(x: number): string {
    return (x * 100).toFixed(1) + '%';
}

function main(): void {
    // --- flash-lite (C1) を読み込み、ref_id -> include_probability の Map を作る ---
    const flashLitePath = path.join(ROOT, 'experiments/gemini-3.1-flash-lite-ga/results/decisions_2026-05-15T12-17-04.json');
    const flashLiteRaw: DecisionRecord[] = JSON.parse(fs.readFileSync(flashLitePath, 'utf-8'));

    const flashLiteMap = new Map<string, number>();
    let parseFailures = 0;
    for (const rec of flashLiteRaw) {
        try {
            const note = JSON.parse(rec.note);
            const prob = note.include_probability;
            if (typeof prob !== 'number') {
                parseFailures++;
                continue;
            }
            flashLiteMap.set(rec.ref_id, prob);
        } catch {
            parseFailures++;
        }
    }

    console.log(`flash-lite(C1): raw件数=${flashLiteRaw.length}, パース成功=${flashLiteMap.size}, パース失敗=${parseFailures}`);

    const conditions = [
        { id: 'G56-none', label: 'none', file: 'items_G56-none_2026-07-10T01-39-57.json' },
        { id: 'G56-low', label: 'low', file: 'items_G56-low_2026-07-10T01-48-36.json' },
        { id: 'G56-med', label: 'medium', file: 'items_G56-med_2026-07-10T01-59-23.json' },
    ];

    const report: string[] = [];
    const summaryRows: Array<{ label: string; ev: Evaluation }> = [];

    for (const cond of conditions) {
        const lunaPath = path.join(ROOT, 'experiments/gpt-5.6/results', cond.file);
        const lunaItems: LunaItem[] = JSON.parse(fs.readFileSync(lunaPath, 'utf-8'));

        console.log(`\n=== luna ${cond.id} (${cond.label}) ===`);
        console.log(`luna件数=${lunaItems.length}`);

        // ref_id突合チェック
        const lunaIds = new Set(lunaItems.map(it => it.ref_id));
        const flashIds = new Set(flashLiteMap.keys());
        const onlyInLuna = [...lunaIds].filter(id => !flashIds.has(id));
        const onlyInFlash = [...flashIds].filter(id => !lunaIds.has(id));
        if (onlyInLuna.length > 0 || onlyInFlash.length > 0) {
            console.log(`  不一致あり: lunaのみ=${onlyInLuna.length}件, flash-liteのみ=${onlyInFlash.length}件`);
            console.log(`  lunaのみ例: ${onlyInLuna.slice(0, 10).join(', ')}`);
            console.log(`  flash-liteのみ例: ${onlyInFlash.slice(0, 10).join(', ')}`);
        } else {
            console.log(`  ref_id完全一致 (${lunaIds.size}件)`);
        }

        // ジョイン & アンサンブル計算
        const rows: Array<{ predicted: number; actual: number }> = [];
        let missingFlashLite = 0;
        let lunaErrorCount = 0;
        for (const it of lunaItems) {
            if (it.error || it.include_probability === null) {
                lunaErrorCount++;
                continue;
            }
            const flashProb = flashLiteMap.get(it.ref_id);
            if (flashProb === undefined) {
                missingFlashLite++;
                continue;
            }
            const predA = flashProb >= THRESHOLD ? 1 : 0;
            const predB = it.include_probability >= THRESHOLD ? 1 : 0;
            const predictedEnsemble = (predA === 1 || predB === 1) ? 1 : 0;
            const actual = it.label_included === 1 ? 1 : 0;
            rows.push({ predicted: predictedEnsemble, actual });
        }
        console.log(`  ジョイン成功=${rows.length}件, luna側error/null除外=${lunaErrorCount}件, flash-lite側missing=${missingFlashLite}件`);

        const ev = calculateMetrics(rows, THRESHOLD);
        console.log(`  TP=${ev.truePositives} FP=${ev.falsePositives} TN=${ev.trueNegatives} FN=${ev.falseNegatives}`);
        console.log(`  Recall=${fmtPct(ev.sensitivity)} Specificity=${fmtPct(ev.specificity)} Precision=${fmtPct(ev.precision)} Fβ7=${fmtPct(ev.fBetaScore)}`);

        summaryRows.push({ label: cond.label, ev });

        report.push(`### luna(${cond.label}) OR flash-lite(C1)`);
        report.push(`- ジョイン件数: ${rows.length} / luna件数: ${lunaItems.length} / flash-lite件数: ${flashLiteMap.size}`);
        report.push(`- luna側error/null除外: ${lunaErrorCount}件 / flash-lite側missing: ${missingFlashLite}件`);
        report.push('');
    }

    // 出力: 標準出力にサマリー表(Markdown)も出す
    console.log('\n\n=== サマリー表 (Markdown) ===');
    console.log('| 条件 | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of summaryRows) {
        console.log(`| flash-lite(C1) OR luna(${r.label}) | ${fmtPct(r.ev.sensitivity)} | ${fmtPct(r.ev.specificity)} | ${fmtPct(r.ev.precision)} | ${fmtPct(r.ev.fBetaScore)} | ${r.ev.truePositives} | ${r.ev.falsePositives} | ${r.ev.trueNegatives} | ${r.ev.falseNegatives} |`);
    }

    // JSON結果も保存（report.md生成やレビュー用）
    const outJsonPath = path.join(__dirname, 'ensemble_results.json');
    fs.writeFileSync(outJsonPath, JSON.stringify({
        threshold: THRESHOLD,
        flashLite: { totalRaw: flashLiteRaw.length, parsedCount: flashLiteMap.size, parseFailures },
        conditions: summaryRows.map(r => ({ label: r.label, evaluation: r.ev })),
    }, null, 2));
    console.log(`\n結果JSON保存: ${outJsonPath}`);
}

main();
