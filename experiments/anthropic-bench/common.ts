/**
 * anthropic-bench の共通部品（型・指標の計算・results/ の読み込み）。
 * runner.ts / summarize.ts / threshold_sweep.ts が同じ計算を使う。
 */

import fs from 'fs';
import path from 'path';

export interface ItemUsage {
    prompt: number;
    cached: number;
    completion: number;
    reasoning: number;
    total: number;
}

export interface PerItemResult {
    ref_id: string;
    label_included: number;
    include_probability: number | null;
    reasons: string[];
    error?: string;
    /** 'max_tokens' は打ち切り（retryable: false）、'refusal' は拒否、それ以外は 'other'。 */
    errorKind?: 'max_tokens' | 'refusal' | 'other';
    attempts?: number;
    durationMs: number;
    usage?: ItemUsage;
}

export interface Evaluation {
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

export interface TokenTotals {
    prompt: number;
    cached: number;
    completion: number;
    reasoning: number;
}

export interface ExperimentLog {
    experimentId: string;
    startTime: string;
    endTime?: string;
    dryRun?: boolean;
    parameters: {
        dataset: string;
        datasetPath: string;
        totalRecords: number;
        sampleSize?: number;
        condition: {
            id: string;
            provider: string;
            model: string;
            reasoningEffort?: string;
            maxOutputTokens?: number;
        };
        sentMaxTokens?: number;
        rateLimitName: string;
        rateLimitConfig: { concurrency: number; delayBetweenRequests: number };
        screeningPrompt: string;
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        failureRate?: number;
        truncatedCount?: number;
        refusalCount?: number;
        valid?: boolean;
        durationMs: number;
        avgTimePerItem: number;
        tokensTotal?: TokenTotals;
        estimatedCostUsd?: number;
        cost?: { totalUSD: number; perItemUSD: number; extrapolatedFullUSD: number };
    };
    evaluation?: Evaluation;
    error?: string;
}

export function calculateMetrics(items: Array<Pick<PerItemResult, 'include_probability' | 'label_included'>>, threshold: number): Evaluation {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const it of items) {
        if (it.include_probability === null) continue;
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
    const b2 = 49; // β = 7（既存の experiments と同じ）
    const fBetaScore = sensitivity + precision > 0
        ? (1 + b2) * (precision * sensitivity) / (b2 * precision + sensitivity)
        : 0;
    return { threshold, truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn, sensitivity, specificity, precision, fBetaScore };
}

export function pct(v: number, dec = 1): string {
    return (v * 100).toFixed(dec) + '%';
}

/** `--results-dir` / `--out-dir` のような値つきの引数だけを読む。 */
export function readFlag(name: string): string | undefined {
    const args = process.argv.slice(2);
    const i = args.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const v = args[i + 1];
    return v && !v.startsWith('--') ? v : undefined;
}

export interface LoadedRun {
    log: ExperimentLog;
    items: PerItemResult[];
}

/**
 * results/ の experiment_*.log.json を読み、終了済み（endTime あり）のものを
 * 「データセット × 条件 × 全件/サンプル」ごとに最新だけ返す。dry-run の記録は、
 * `--include-dry-run`（集計の script のテスト用）を付けたときだけ含める。
 * 全件扱いは sampleSize が無いか、データセットの総数以上のもの。
 */
export function loadLatestRuns(resultsDir: string, includeDryRun = process.argv.includes('--include-dry-run')): { full: LoadedRun[]; samples: LoadedRun[] } {
    if (!fs.existsSync(resultsDir)) return { full: [], samples: [] };
    const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('experiment_') && f.endsWith('.log.json'))
        .sort();
    const latest = new Map<string, LoadedRun>();
    for (const f of files) {
        try {
            const log = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')) as ExperimentLog;
            if (!log.endTime || !log.evaluation || (log.dryRun && !includeDryRun)) continue;
            const itemsPath = path.join(resultsDir, `items_${log.experimentId}.json`);
            if (!fs.existsSync(itemsPath)) continue;
            const items = JSON.parse(fs.readFileSync(itemsPath, 'utf-8')) as PerItemResult[];
            const p = log.parameters;
            const isFull = p.sampleSize === undefined || p.sampleSize >= p.totalRecords;
            const key = `${p.dataset}__${p.condition.id}__${isFull ? 'full' : p.sampleSize}`;
            latest.set(key, { log, items });
        } catch {
            // 壊れたファイルは飛ばす
        }
    }
    const all = Array.from(latest.values());
    const bySort = (a: LoadedRun, b: LoadedRun) =>
        `${a.log.parameters.dataset}_${a.log.parameters.condition.id}`.localeCompare(`${b.log.parameters.dataset}_${b.log.parameters.condition.id}`);
    const isFull = (r: LoadedRun) => r.log.parameters.sampleSize === undefined || r.log.parameters.sampleSize >= r.log.parameters.totalRecords;
    return {
        full: all.filter(isFull).sort(bySort),
        samples: all.filter(r => !isFull(r)).sort(bySort),
    };
}
