/**
 * 結果サマリー生成
 * results/ 内のログJSONを読み込み、Recall/コスト比較表を生成
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
            maxOutputTokens?: number;
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
    depression: { recall: 0.961, precision: 0.534, tp: 269, fp: 235, tn: 1478, fn: 11, fBeta7: 0.95 },
};
const GA_C1_BASELINE = {
    depression: { recall: 0.936, precision: 0.616, tp: 262, fp: 163, tn: 1550, fn: 18, fBeta7: 0.926 },
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

    console.log('# gemini-3.5-flash 実験結果サマリー\n');
    console.log('## Phase 1: depression × thinking_level 比較 (フル 1,993 件)\n');
    console.log('| 条件 | thinking | Temp | TopP | maxOut | Recall | Precision | Fβ(7) | TP | FP | TN | FN | フォール バック | MAX_TOK | 時間(s) | $/1K件 |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');

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
            `| ${c.id} | ${c.thinkingLevel ?? '-'} | ${c.temperature} | ${c.topP ?? '-'} | ${c.maxOutputTokens ?? '-'} ` +
            `| **${(e.sensitivity * 100).toFixed(1)}%** | ${(e.precision * 100).toFixed(1)}% | ${(e.fBetaScore * 100).toFixed(1)}% ` +
            `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} | ${fb} | ${maxTok} | ${time} | ${costStr} |`
        );
    }

    // ベースライン行
    const b4 = B4_BASELINE.depression;
    console.log(
        `| B4 (参考) | LOW | 1.0 | 0.95 | - ` +
        `| **${(b4.recall * 100).toFixed(1)}%** | ${(b4.precision * 100).toFixed(1)}% | ${(b4.fBeta7 * 100).toFixed(1)}% ` +
        `| ${b4.tp} | ${b4.fp} | ${b4.tn} | ${b4.fn} | - | - | - | - |`
    );
    const ga = GA_C1_BASELINE.depression;
    console.log(
        `| GA C1 (参考) | - | 0 | - | - ` +
        `| **${(ga.recall * 100).toFixed(1)}%** | ${(ga.precision * 100).toFixed(1)}% | ${(ga.fBeta7 * 100).toFixed(1)}% ` +
        `| ${ga.tp} | ${ga.fp} | ${ga.tn} | ${ga.fn} | - | - | - | - |`
    );

    // 疎通確認のみで除外された条件
    if (sampleRuns.length > 0) {
        console.log('\n## 疎通確認のみで除外された条件 (50件サンプル, 統計的有意性なし)\n');
        console.log('| 条件 | thinking | n | Recall | $/1K件 (実測) | 除外理由 |');
        console.log('|---|---|---|---|---|---|');
        for (const exp of sampleRuns.sort((a, b) => a.parameters.condition.id.localeCompare(b.parameters.condition.id))) {
            const c = exp.parameters.condition;
            const e = exp.evaluation!;
            const cost = exp.cost;
            const costStr = cost ? `$${cost.usdPer1000Items.toFixed(2)}` : 'N/A';
            console.log(
                `| ${c.id} | ${c.thinkingLevel ?? '-'} | ${exp.parameters.sampleSize} ` +
                `| ${(e.sensitivity * 100).toFixed(1)}% | ${costStr} ` +
                `| コスト過大 (1,993件で約 $${((cost?.usdPer1000Items ?? 0) * 1.993).toFixed(0)}) |`
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
        const b4CostPer1K = 0.0017 * 1000; // 推定 $1.70/1K件（B4 推定）
        const costRatio = cost ? cost.usdPer1000Items / b4CostPer1K : null;
        console.log('## 判断基準との照合\n');
        if (recall >= 0.96 && costRatio !== null && costRatio <= 2) {
            console.log(`- デフォルト切替候補: Recall ${(recall * 100).toFixed(1)}% ≥ 96% かつ B4比コスト ${costRatio.toFixed(1)}倍 ≤ 2`);
        } else if (recall >= 0.95 && costRatio !== null && costRatio <= 5) {
            console.log(`- UI公開 (上位互換枠): Recall ${(recall * 100).toFixed(1)}% ≥ 95% かつ B4比コスト ${costRatio.toFixed(1)}倍 ≤ 5`);
        } else if (recall >= 0.95) {
            console.log(`- 実験記録のみ: Recall ${(recall * 100).toFixed(1)}% ≥ 95% だが B4比コスト ${costRatio?.toFixed(1)}倍 > 5`);
        } else if (recall >= 0.93) {
            console.log(`- フォールバック検討: Recall ${(recall * 100).toFixed(1)}% (93-95%)`);
        } else {
            console.log(`- 現行維持: Recall ${(recall * 100).toFixed(1)}% < 93%`);
        }
        if (costRatio !== null) {
            console.log(`- B4 推定コスト ($1.70/1K件) に対する倍率: **${costRatio.toFixed(1)}倍**`);
        }
    }
}

main();
