/**
 * 評価スクリプト
 * 既存の結果JSONに対して複数閾値で評価指標を計算
 */
import fs from 'fs';
import path from 'path';

interface EvaluationResult {
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

interface DecisionWithNote {
    ref_id: string;
    note?: string;
}

interface ReferenceWithLabel {
    ref_id: string;
    label_included: number;
}

function calculateMetrics(
    decisions: DecisionWithNote[],
    references: ReferenceWithLabel[],
    threshold: number
): EvaluationResult {
    let tp = 0, fp = 0, tn = 0, fn = 0;

    const refMap = new Map(references.map(r => [r.ref_id, r.label_included]));

    for (const decision of decisions) {
        const actual = refMap.get(decision.ref_id);
        if (actual === undefined) continue;

        let probability = 0.5;
        if (decision.note) {
            try {
                const noteData = JSON.parse(decision.note);
                probability = noteData.include_probability ?? 0.5;
            } catch {
                // パース失敗時はデフォルト値
            }
        }

        const predicted = probability >= threshold ? 1 : 0;
        const actualLabel = actual === 1 ? 1 : 0;

        if (predicted === 1 && actualLabel === 1) tp++;
        else if (predicted === 1 && actualLabel === 0) fp++;
        else if (predicted === 0 && actualLabel === 0) tn++;
        else if (predicted === 0 && actualLabel === 1) fn++;
    }

    const sensitivity = tp + fn > 0 ? tp / (tp + fn) : 0;
    const specificity = tn + fp > 0 ? tn / (tn + fp) : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;

    const beta = 7;
    const betaSquared = beta * beta;
    const fBetaScore = sensitivity + precision > 0
        ? (1 + betaSquared) * (precision * sensitivity) / (betaSquared * precision + sensitivity)
        : 0;

    return {
        threshold,
        truePositives: tp,
        falsePositives: fp,
        trueNegatives: tn,
        falseNegatives: fn,
        sensitivity,
        specificity,
        precision,
        fBetaScore,
    };
}

function printResults(results: EvaluationResult[]): void {
    console.log('\n=== 評価結果サマリー ===\n');
    console.log('Threshold | Sens(%) | Spec(%) | Prec(%) | Fβ=7(%) | TP   | FP   | TN   | FN');
    console.log('----------|---------|---------|---------|---------|------|------|------|------');

    for (const r of results) {
        console.log(
            `${r.threshold.toFixed(2).padStart(9)} | ` +
            `${(r.sensitivity * 100).toFixed(1).padStart(7)} | ` +
            `${(r.specificity * 100).toFixed(1).padStart(7)} | ` +
            `${(r.precision * 100).toFixed(1).padStart(7)} | ` +
            `${(r.fBetaScore * 100).toFixed(1).padStart(7)} | ` +
            `${String(r.truePositives).padStart(4)} | ` +
            `${String(r.falsePositives).padStart(4)} | ` +
            `${String(r.trueNegatives).padStart(4)} | ` +
            `${String(r.falseNegatives).padStart(4)}`
        );
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log('Usage: npx ts-node evaluate.ts <decisions.json> <dataset.json> [thresholds]');
        console.log('Example: npx ts-node evaluate.ts results/decisions_xxx.json ../scripts/asreview-baseline/datasets/cq3_labeled.json 0.3,0.5,0.7');
        process.exit(1);
    }

    const decisionsPath = args[0];
    const datasetPath = args[1];
    const thresholdsArg = args[2] || '0.3,0.5,0.7';
    const thresholds = thresholdsArg.split(',').map(parseFloat);

    // データ読み込み
    const decisions: DecisionWithNote[] = JSON.parse(fs.readFileSync(decisionsPath, 'utf-8'));
    const references: ReferenceWithLabel[] = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));

    console.log(`Loaded ${decisions.length} decisions and ${references.length} references`);

    // 各閾値で評価
    const results: EvaluationResult[] = [];
    for (const threshold of thresholds) {
        const result = calculateMetrics(decisions, references, threshold);
        results.push(result);
    }

    printResults(results);

    // 結果をJSONで保存
    const outputPath = decisionsPath.replace('.json', '_evaluation.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\nEvaluation saved to ${outputPath}`);
}

main().catch(console.error);
