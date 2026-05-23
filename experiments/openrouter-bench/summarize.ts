/**
 * results/ 配下の experiment_*.log.json を集約して比較表 (Markdown) を生成
 * 既存 B4 ベースライン（depression: recall 0.96, precision 0.53）と並べる
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
            provider: string;
            model: string;
            temperature: number;
            topP?: number;
            thinkingLevel?: string;
            reasoningEffort?: string;
        };
        rateLimitConfig: { concurrency: number; delayBetweenRequests: number };
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        durationMs: number;
        avgTimePerItem: number;
        tokensTotal?: { prompt: number; completion: number; reasoning: number };
        estimatedCostUsd?: number;
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

function pad(v: number, dec = 1): string {
    return (v * 100).toFixed(dec) + '%';
}

function main(): void {
    const resultsDir = path.join(__dirname, 'results');
    if (!fs.existsSync(resultsDir)) {
        console.error('results/ が存在しません');
        process.exit(1);
    }

    const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('experiment_') && f.endsWith('.log.json'))
        .sort();

    if (files.length === 0) {
        console.error('experiment_*.log.json が見つかりません');
        process.exit(1);
    }

    // 同一 condition の最新ログだけ残す
    const latestByCond = new Map<string, ExperimentLog>();
    for (const f of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')) as ExperimentLog;
            if (!data.evaluation) continue;
            const condId = data.parameters?.condition?.id;
            if (!condId) continue;
            latestByCond.set(condId, data);
        } catch {
            // skip
        }
    }

    const experiments = Array.from(latestByCond.values());

    const lines: string[] = [];
    lines.push('# OpenRouter ベンチマーク結果');
    lines.push('');
    lines.push('depression データセット（既存 B4 ベースライン: Recall 96.1% / Precision 53% を再掲）。');
    lines.push('');
    lines.push('## モデル比較');
    lines.push('');
    lines.push('| 条件 | Provider | Model | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN | 件数 | 時間(s) | コスト(USD) |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');

    for (const exp of experiments.sort((a, b) => a.parameters.condition.id.localeCompare(b.parameters.condition.id))) {
        const c = exp.parameters.condition;
        const e = exp.evaluation!;
        const r = exp.results;
        const time = r ? (r.durationMs / 1000).toFixed(0) : '-';
        const cost = r?.estimatedCostUsd !== undefined ? `$${r.estimatedCostUsd.toFixed(3)}` : '-';
        const n = r?.processedCount ?? 0;
        lines.push(
            `| ${c.id} | ${c.provider} | ${c.model} ` +
            `| **${pad(e.sensitivity)}** | ${pad(e.specificity)} | ${pad(e.precision)} | ${pad(e.fBetaScore)} ` +
            `| ${e.truePositives} | ${e.falsePositives} | ${e.trueNegatives} | ${e.falseNegatives} | ${n} | ${time} | ${cost} |`
        );
    }
    lines.push(
        `| B4 (既存記録) | gemini | gemini-3-flash-preview ` +
        `| **96.1%** | 86.3% | 53.4% | 95.2% ` +
        `| 269 | 235 | 1478 | 11 | 1993 | - | - |`
    );

    lines.push('');
    lines.push('## トークン消費 / レイテンシ');
    lines.push('');
    lines.push('| 条件 | 1件平均(ms) | prompt | completion | reasoning | 失敗 |');
    lines.push('|---|---|---|---|---|---|');
    for (const exp of experiments.sort((a, b) => a.parameters.condition.id.localeCompare(b.parameters.condition.id))) {
        const c = exp.parameters.condition;
        const r = exp.results;
        const tk = r?.tokensTotal;
        lines.push(
            `| ${c.id} | ${r ? Math.round(r.avgTimePerItem) : '-'} ` +
            `| ${tk?.prompt ?? '-'} | ${tk?.completion ?? '-'} | ${tk?.reasoning ?? '-'} | ${r?.failCount ?? '-'} |`
        );
    }

    lines.push('');
    lines.push('## 採用判断');
    lines.push('');
    lines.push('- ✅ Recall ≥ 95% かつ Precision または コスト or レイテンシで B4 を上回るモデルを採用候補とする');
    lines.push('- ⚠️ Recall 93-95% はフォールバック枠（ユーザー選択肢）として残す');
    lines.push('- ❌ Recall < 93% は採用しない');

    const out = lines.join('\n') + '\n';
    const outPath = path.join(__dirname, 'report.md');
    fs.writeFileSync(outPath, out);
    console.log(out);
    console.log(`\n出力: ${outPath}`);
}

main();
