/**
 * 結果サマリー生成
 * results/ 内のログJSONを読み込み、Recall/コスト比較表を生成
 * (gemini-3.5-flash/summarize.ts をベースに C1-C4 条件・Lite階層向けに調整)
 */
import fs from 'fs';
import path from 'path';

interface ExperimentLog {
    experimentId: string;
    parameters: {
        dataset: string;
        sampleSize?: number;
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
        fallbackCount: number;
        durationMs: number;
        avgTimePerItem: number;
        modelVersions: string[];
    };
    usage?: {
        promptTokens: number;
        candidatesTokens: number;
        thoughtsTokens: number;
        totalTokens: number;
        samples: number;
        maxTokensTruncated: number;
        parseErrorFallback: number;
    };
    cost?: {
        inputUSD: number;
        outputUSD: number;
        totalUSD: number;
        usdPer1000Items: number;
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

const B4_BASELINE = {
    depression: { recall: 0.961, precision: 0.534, tp: 269, fp: 235, tn: 1478, fn: 11, fBeta7: 0.95, usdPer1000Items: 1.70 },
};
const GA_C1_BASELINE = {
    depression: { recall: 0.936, precision: 0.616, tp: 262, fp: 163, tn: 1550, fn: 18, fBeta7: 0.926, usdPer1000Items: 0.30 },
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

    const experiments: ExperimentLog[] = [];
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(resultsDir, file), 'utf-8');
            const data = JSON.parse(content) as ExperimentLog;
            if (data.evaluation) experiments.push(data);
        } catch (e) {
            console.error(`パースエラー: ${file}:`, e);
        }
    }

    // 各条件は最新の結果のみ採用（フル件数優先、フル件数の中で最新時刻）
    const byCondition = new Map<string, ExperimentLog>();
    for (const exp of experiments) {
        const cid = exp.parameters.condition.id;
        const sampleSize = exp.parameters.sampleSize;
        const existing = byCondition.get(cid);
        if (!existing) {
            byCondition.set(cid, exp);
            continue;
        }
        const existingSample = existing.parameters.sampleSize;
        // フル件数を優先、両方フルなら新しい experimentId（時刻順ソート済み）
        if (!sampleSize && existingSample) {
            byCondition.set(cid, exp);
        } else if (sampleSize === existingSample) {
            byCondition.set(cid, exp); // 後勝ち（時刻順）
        }
    }

    // フル実行とサンプル実行を分離
    const fullRuns = Array.from(byCondition.values()).filter(e => !e.parameters.sampleSize);
    const sampleRuns = Array.from(byCondition.values()).filter(e => e.parameters.sampleSize);

    console.log('# gemini-3.5-flash-lite 実験結果サマリー\n');
    console.log('## Phase 1: depression × 条件比較 (フル 1,993 件)\n');
    console.log('| 条件 | Temp | TopP | Thinking | Recall | Precision | Fβ(7) | TP | FP | TN | FN | フォールバック | MAX_TOK | 時間(s) | $/1K件 |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');

    const sortedConditions = fullRuns.sort((a, b) =>
        a.parameters.condition.id.localeCompare(b.parameters.condition.id)
    );

    for (const exp of sortedConditions) {
        const c = exp.parameters.condition;
        const e = exp.evaluation!;
        const r = exp.results;
        const u = exp.usage;
        const cost = exp.cost;
        const time = r ? (r.durationMs / 1000).toFixed(0) : 'N/A';
        const costStr = cost ? `$${cost.usdPer1000Items.toFixed(2)}` : 'N/A';
        const maxTok = u ? u.maxTokensTruncated : 'N/A';
        const fb = r ? r.fallbackCount : 'N/A';

        console.log(
            `| ${c.id} | ${c.temperature} | ${c.topP ?? '-'} | ${c.thinkingLevel ?? '-'} ` +
            `| **${(e.sensitivity * 100).toFixed(1)}%** | ${(e.precision * 100).toFixed(1)}% | ${(e.fBetaScore * 100).toFixed(1)}% ` +
            `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} | ${fb} | ${maxTok} | ${time} | ${costStr} |`
        );
    }

    // ベースライン行
    const b4 = B4_BASELINE.depression;
    console.log(
        `| B4 (参考) | 1.0 | 0.95 | LOW ` +
        `| **${(b4.recall * 100).toFixed(1)}%** | ${(b4.precision * 100).toFixed(1)}% | ${(b4.fBeta7 * 100).toFixed(1)}% ` +
        `| ${b4.tp} | ${b4.fp} | ${b4.tn} | ${b4.fn} | - | - | - | $${b4.usdPer1000Items.toFixed(2)} |`
    );
    const ga = GA_C1_BASELINE.depression;
    console.log(
        `| GA C1 (参考, gemini-3.1-flash-lite=現行デフォルト) | 0 | - | - ` +
        `| **${(ga.recall * 100).toFixed(1)}%** | ${(ga.precision * 100).toFixed(1)}% | ${(ga.fBeta7 * 100).toFixed(1)}% ` +
        `| ${ga.tp} | ${ga.fp} | ${ga.tn} | ${ga.fn} | - | - | - | $${ga.usdPer1000Items.toFixed(2)} |`
    );

    // 疎通確認のみで除外された条件
    if (sampleRuns.length > 0) {
        console.log('\n## 疎通確認のみで除外された条件 (統計的有意性なし)\n');
        console.log('| 条件 | n | Recall | $/1K件 (実測) | フル件数換算コスト推定 | 除外理由 |');
        console.log('|---|---|---|---|---|---|');
        for (const exp of sampleRuns.sort((a, b) => a.parameters.condition.id.localeCompare(b.parameters.condition.id))) {
            const c = exp.parameters.condition;
            const e = exp.evaluation!;
            const cost = exp.cost;
            const costStr = cost ? `$${cost.usdPer1000Items.toFixed(2)}` : 'N/A';
            const fullEstimate = cost ? (cost.totalUSD / (exp.parameters.sampleSize || 1) * 1993) : null;
            console.log(
                `| ${c.id} | ${exp.parameters.sampleSize} ` +
                `| ${(e.sensitivity * 100).toFixed(1)}% | ${costStr} ` +
                `| ${fullEstimate !== null ? `$${fullEstimate.toFixed(2)}` : 'N/A'} ` +
                `| フルコスト推定が $20 を超過 |`
            );
        }
    }

    // 最適条件（フル実行から選択）
    if (sortedConditions.length > 0) {
        const best = sortedConditions.reduce((a, b) =>
            (a.evaluation!.sensitivity > b.evaluation!.sensitivity) ? a : b
        );
        console.log(`\n**最適条件**: ${best.parameters.condition.id} (Recall: ${(best.evaluation!.sensitivity * 100).toFixed(1)}%, $${best.cost?.usdPer1000Items.toFixed(2) ?? 'N/A'}/1K件)\n`);

        const recall = best.evaluation!.sensitivity;
        const cost = best.cost;
        const b4CostPer1K = B4_BASELINE.depression.usdPer1000Items;
        const gaCostPer1K = GA_C1_BASELINE.depression.usdPer1000Items;
        const costRatioVsB4 = cost ? cost.usdPer1000Items / b4CostPer1K : null;
        const costRatioVsGa = cost ? cost.usdPer1000Items / gaCostPer1K : null;

        console.log('## RQ1: 現行デフォルト GA C1 (gemini-3.1-flash-lite) を上回るか\n');
        console.log(`- 最良条件 ${best.parameters.condition.id} Recall ${(recall * 100).toFixed(1)}% vs GA C1 Recall ${(GA_C1_BASELINE.depression.recall * 100).toFixed(1)}% (差分 ${((recall - GA_C1_BASELINE.depression.recall) * 100).toFixed(1)}pp)`);
        if (costRatioVsGa !== null) {
            console.log(`- コスト比 (対 GA C1 $${gaCostPer1K.toFixed(2)}/1K件): ${costRatioVsGa.toFixed(2)}倍`);
        }

        console.log('\n## RQ2: B4 (gemini-3-flash-preview) に近づけるか\n');
        console.log(`- 最良条件 ${best.parameters.condition.id} Recall ${(recall * 100).toFixed(1)}% vs B4 Recall ${(B4_BASELINE.depression.recall * 100).toFixed(1)}% (差分 ${((recall - B4_BASELINE.depression.recall) * 100).toFixed(1)}pp)`);

        console.log('\n## 判断基準との照合 (B4 コストを基準倍率とする)\n');
        if (recall >= 0.96 && costRatioVsB4 !== null && costRatioVsB4 <= 2) {
            console.log(`- ✅ デフォルト切替候補: Recall ${(recall * 100).toFixed(1)}% ≥ 96% かつ B4比コスト ${costRatioVsB4.toFixed(2)}倍 ≤ 2`);
        } else if (recall >= 0.95 && costRatioVsB4 !== null && costRatioVsB4 <= 5) {
            console.log(`- ⚠️ UI公開 (上位互換枠): Recall ${(recall * 100).toFixed(1)}% ≥ 95% かつ B4比コスト ${costRatioVsB4.toFixed(2)}倍 ≤ 5`);
        } else if (recall >= 0.95) {
            console.log(`- ⚠️ 実験記録のみ: Recall ${(recall * 100).toFixed(1)}% ≥ 95% だが B4比コスト ${costRatioVsB4?.toFixed(2)}倍 > 5`);
        } else if (recall >= 0.93) {
            console.log(`- ⚠️ 現行デフォルトとのフォールバック検討: Recall ${(recall * 100).toFixed(1)}% (93-95%)`);
        } else {
            console.log(`- ❌ 却下: Recall ${(recall * 100).toFixed(1)}% < 93%`);
        }
        if (costRatioVsB4 !== null) {
            console.log(`- B4 実測コスト ($${b4CostPer1K.toFixed(2)}/1K件) に対する倍率: **${costRatioVsB4.toFixed(2)}倍**`);
        }
    }
}

main();
