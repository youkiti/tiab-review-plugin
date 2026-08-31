/**
 * 結果サマリー生成
 * results/ 内の experiment_*.log.json を読み込み、条件別のキャッシュ効果・コスト比較表 (Markdown) を出力する。
 *
 * 使い方:
 *   npx ts-node --project experiments/gemini-prompt-cache/tsconfig.json experiments/gemini-prompt-cache/summarize.ts
 */
import fs from 'fs';
import path from 'path';

interface ExperimentLog {
    experimentId: string;
    parameters?: {
        dataset: string;
        sampleSize?: number;
        totalRecords: number;
        tier: string;
        warmupCount: number;
        promptVariant: string;
        screeningPromptChars: number;
        condition: { id: string; model: string };
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        avgTimePerItem: number;
    };
    usageSummary?: {
        decisionsWithUsage: number;
        totalPromptTokens: number;
        totalCachedInputTokens: number;
        totalCandidatesTokens: number;
        totalThoughtsTokens: number;
        cacheHitCount: number;
        cacheHitRate: number;
        cachedTokenShare: number;
    };
    costSummary?: {
        estimatedCostUsd: number;
        noCacheCostUsd: number;
        savingsRatio: number;
    };
    evaluation?: {
        sensitivity: number;
        specificity: number;
        precision: number;
        fBetaScore: number;
    };
    error?: string;
}

function pct(v: number | undefined): string {
    return v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}

function usd(v: number | undefined): string {
    return v === undefined ? '—' : `$${v.toFixed(4)}`;
}

function main(): void {
    const resultsDir = path.join(__dirname, 'results');
    if (!fs.existsSync(resultsDir)) {
        console.error(`results/ がまだありません: ${resultsDir}`);
        process.exit(1);
    }

    const logFiles = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('experiment_') && f.endsWith('.log.json'))
        .sort();

    const rows: string[] = [];
    for (const file of logFiles) {
        let log: ExperimentLog;
        try {
            log = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf-8'));
        } catch {
            console.warn(`パース失敗のためスキップ: ${file}`);
            continue;
        }
        if (log.error) {
            console.warn(`エラー終了のためスキップ: ${file} (${log.error})`);
            continue;
        }
        const p = log.parameters;
        const u = log.usageSummary;
        const c = log.costSummary;
        const e = log.evaluation;
        if (!p || !u || !c) {
            console.warn(`集計未保存のためスキップ: ${file}`);
            continue;
        }
        const n = log.results ? `${log.results.successCount}/${log.results.processedCount}` : '—';
        rows.push([
            log.experimentId,
            p.condition.id,
            p.condition.model,
            p.promptVariant,
            String(p.screeningPromptChars),
            p.tier,
            String(p.warmupCount),
            n,
            pct(u.cacheHitRate),
            pct(u.cachedTokenShare),
            String(u.totalPromptTokens),
            String(u.totalCachedInputTokens),
            String(u.totalCandidatesTokens + u.totalThoughtsTokens),
            usd(c.estimatedCostUsd),
            usd(c.noCacheCostUsd),
            pct(c.savingsRatio),
            e ? pct(e.sensitivity) : '—',
            log.results ? `${log.results.avgTimePerItem.toFixed(0)}` : '—',
        ].join(' | '));
    }

    if (rows.length === 0) {
        console.log('集計対象の実験ログがありません。runner.ts を先に実行してください。');
        return;
    }

    const header = [
        'experimentId', '条件', 'モデル', 'prompt', 'prefix chars', 'tier', 'warmup', '成功/処理',
        'ヒット率', 'キャッシュ比率', 'Σprompt tok', 'Σcached tok', 'Σoutput tok',
        '推定コスト', 'キャッシュなし', '削減率', 'Recall@0.5', 'ms/件',
    ];
    console.log(`| ${header.join(' | ')} |`);
    console.log(`|${header.map(() => '---').join('|')}|`);
    for (const row of rows) {
        console.log(`| ${row} |`);
    }
    console.log('\n注: 推定コストは config.json の pricing（実行時点で要確認の単価）に基づく。');
    console.log('ヒット率・キャッシュ比率は usageMetadata.cachedContentTokenCount の実測値で、単価設定に依存しない。');
}

main();
