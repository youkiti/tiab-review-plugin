/**
 * 結果サマリー生成
 * results/ 内のログJSONを読み込み、既存B4結果との比較表を生成
 */
import fs from 'fs';
import path from 'path';

interface ExperimentLog {
    experimentId: string;
    parameters: {
        dataset: string;
        condition: {
            id: string;
            model: string;
            temperature: number;
            topP?: number;
            thinkingLevel?: string;
        };
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        durationMs: number;
        avgTimePerItem: number;
    };
    evaluation?: {
        threshold: number;
        truePositives: number;
        falsePositives: number;
        trueNegatives: number;
        falseNegatives: number;
        sensitivity: number;
        specificity: number;
        precision: number;
        fBetaScore: number;
    };
}

// 既存B4結果（experiments/report_verification.md より）
const B4_BASELINE: Record<string, { recall: number; precision: number; tp: number; fp: number; tn: number; fn: number }> = {
    depression: { recall: 0.96, precision: 0.53, tp: 269, fp: 235, tn: 1478, fn: 11 },
    cq1: { recall: 0.99, precision: 0.04, tp: 112, fp: 2626, tn: 2889, fn: 1 },
    cq2: { recall: 1.00, precision: 0.02, tp: 17, fp: 920, tn: 2463, fn: 0 },
    cq3: { recall: 1.00, precision: 0.04, tp: 16, fp: 437, tn: 585, fn: 0 },
    cq4: { recall: 1.00, precision: 0.05, tp: 72, fp: 1287, tn: 2967, fn: 0 },
    cq5: { recall: 0.98, precision: 0.15, tp: 40, fp: 229, tn: 1983, fn: 1 },
};

function main() {
    const resultsDir = path.join(__dirname, 'results');

    if (!fs.existsSync(resultsDir)) {
        console.error('結果ディレクトリが見つかりません:', resultsDir);
        process.exit(1);
    }

    const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('experiment_') && f.endsWith('.log.json'))
        .sort();

    if (files.length === 0) {
        console.error('結果ファイルが見つかりません');
        process.exit(1);
    }

    // 結果を読み込み
    const experiments: ExperimentLog[] = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(resultsDir, file), 'utf-8');
            const data = JSON.parse(content) as ExperimentLog;
            if (data.evaluation) {
                experiments.push(data);
            }
        } catch (e) {
            console.error(`パースエラー: ${file}:`, e);
        }
    }

    // Phase 1 結果（depression）
    const phase1 = experiments.filter(e => e.parameters.dataset === 'depression');
    // Phase 2 結果（その他）
    const phase2 = experiments.filter(e => e.parameters.dataset !== 'depression');

    // === Phase 1 サマリー ===
    console.log('# gemini-3.1-flash-lite (GA) 実験結果サマリー\n');
    console.log('## Phase 1: depression データセットでの条件比較\n');
    console.log('| 条件 | Temp | TopP | Thinking | Recall | Precision | Fβ(7) | TP | FP | TN | FN | 時間(s) |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');

    for (const exp of phase1.sort((a, b) => a.parameters.condition.id.localeCompare(b.parameters.condition.id))) {
        const c = exp.parameters.condition;
        const e = exp.evaluation!;
        const r = exp.results;
        const time = r ? (r.durationMs / 1000).toFixed(0) : 'N/A';

        console.log(
            `| ${c.id} | ${c.temperature} | ${c.topP ?? '-'} | ${c.thinkingLevel ?? '-'} ` +
            `| **${(e.sensitivity * 100).toFixed(1)}%** | ${(e.precision * 100).toFixed(1)}% | ${(e.fBetaScore * 100).toFixed(1)}% ` +
            `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} | ${time} |`
        );
    }

    // B4ベースライン行
    const b4Dep = B4_BASELINE.depression;
    if (b4Dep) {
        console.log(
            `| **B4 (参考)** | 1.0 | 0.95 | LOW ` +
            `| **${(b4Dep.recall * 100).toFixed(1)}%** | ${(b4Dep.precision * 100).toFixed(1)}% | - ` +
            `| ${b4Dep.tp} | ${b4Dep.fp} | ${b4Dep.tn} | ${b4Dep.fn} | - |`
        );
    }

    // 最適条件の特定
    if (phase1.length > 0) {
        const best = phase1.reduce((a, b) =>
            (a.evaluation!.sensitivity > b.evaluation!.sensitivity) ? a : b
        );
        console.log(`\n**最適条件**: ${best.parameters.condition.id} (Recall: ${(best.evaluation!.sensitivity * 100).toFixed(1)}%)\n`);
    }

    // === Phase 2 サマリー ===
    if (phase2.length > 0) {
        console.log('\n## Phase 2: 全データセットでの検証\n');
        console.log('| データセット | 条件 | Recall | Precision | TP | FP | TN | FN | B4 Recall | 差分 |');
        console.log('|---|---|---|---|---|---|---|---|---|---|');

        for (const exp of phase2.sort((a, b) => a.parameters.dataset.localeCompare(b.parameters.dataset))) {
            const d = exp.parameters.dataset;
            const c = exp.parameters.condition;
            const e = exp.evaluation!;
            const baseline = B4_BASELINE[d];
            const b4Recall = baseline ? `${(baseline.recall * 100).toFixed(1)}%` : 'N/A';
            const diff = baseline
                ? `${((e.sensitivity - baseline.recall) * 100).toFixed(1)}pp`
                : 'N/A';

            console.log(
                `| ${d} | ${c.id} | **${(e.sensitivity * 100).toFixed(1)}%** | ${(e.precision * 100).toFixed(1)}% ` +
                `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} ` +
                `| ${b4Recall} | ${diff} |`
            );
        }
    }

    // === 全体まとめ ===
    console.log('\n## 判断基準との照合\n');
    if (phase1.length > 0) {
        const best = phase1.reduce((a, b) =>
            (a.evaluation!.sensitivity > b.evaluation!.sensitivity) ? a : b
        );
        const recall = best.evaluation!.sensitivity;
        if (recall >= 0.95) {
            console.log(`- ✅ Recall ${(recall * 100).toFixed(1)}% ≥ 95% → **デフォルト切り替え候補**`);
        } else if (recall >= 0.93) {
            console.log(`- ⚠️ Recall ${(recall * 100).toFixed(1)}% (93-95%) → **フォールバック枠として検討**`);
        } else {
            console.log(`- ❌ Recall ${(recall * 100).toFixed(1)}% < 93% → **現行構成維持**`);
        }
    }
}

main();
