/**
 * gpt-5.6 ベンチマーク用ランナー
 *
 * provider: 'openai' を src/lib/providers/openai.ts の screenViaOpenAi 経由で呼ぶ。
 * getEffectiveOpenAiApiKey が Node 環境では process.env.OPENAI_API_KEY を読むため、
 * .env に OPENAI_API_KEY があればそのまま動作する（chrome.storage 非依存）。
 *
 * gpt-5.6 reasoning モデルは temperature / top_p を HTTP 400 で拒否するため、
 * 探索軸は reasoning_effort (none/low/medium/high) のみ。verbosity は provider 側で
 * low 固定送信（gpt-5.6 ドキュメント未記載のため、疎通で 400 なら provider から外す）。
 *
 * 評価指標は既存 experiments/openrouter-bench/runner.ts と完全に揃える
 * (threshold=0.5 既定、Fβ=7)。
 *
 * cached 入力トークン (input_tokens_details.cached_tokens) を保存し、Luna の
 * cached 割引単価で正確にコスト算出する。長時間の全件 run に備え checkpointEvery 件
 * ごとに items / log を中間保存する（途中クラッシュでも取得済み結果を失わない）。
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { screenViaOpenAi } from '../../src/lib/providers/openai';
import type { Reference, RateLimitConfig } from '../../src/lib/types';

interface Condition {
    id: string;
    provider: 'openai';
    model: string;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
    rateLimit: string;
    note?: string;
}

interface Pricing {
    inputPerMillion: number;
    cachedInputPerMillion?: number;
    outputPerMillion: number;
}

interface BenchConfig {
    description: string;
    version: string;
    datasets: Record<string, string>;
    datasetConfigs: Record<string, { criteria: string }>;
    defaultScreeningPrompt: string;
    checkpointEvery?: number;
    rateLimits: Record<string, RateLimitConfig>;
    conditions: Condition[];
    pricing: Record<string, Pricing>;
}

interface ItemUsage {
    prompt: number;
    cached: number;
    completion: number;
    reasoning: number;
    total: number;
}

interface PerItemResult {
    ref_id: string;
    label_included: number;
    include_probability: number | null;
    reasons: string[];
    error?: string;
    durationMs: number;
    usage?: ItemUsage;
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

interface ExperimentLog {
    experimentId: string;
    startTime: string;
    endTime?: string;
    parameters: {
        dataset: string;
        datasetPath: string;
        totalRecords: number;
        sampleSize?: number;
        condition: Condition;
        rateLimitName: string;
        rateLimitConfig: RateLimitConfig;
        screeningPrompt: string;
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        durationMs: number;
        avgTimePerItem: number;
        tokensTotal?: { prompt: number; cached: number; completion: number; reasoning: number };
        estimatedCostUsd?: number;
    };
    evaluation?: Evaluation;
    error?: string;
}

function parseArgs(): { dataset: string; condition: string; sample?: number; threshold: number } {
    const args = process.argv.slice(2);
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const k = args[i].slice(2);
            const v = args[i + 1];
            if (v && !v.startsWith('--')) { out[k] = v; i++; }
        }
    }
    return {
        dataset: out.dataset || 'depression',
        condition: out.condition || 'G56-none',
        sample: out.sample ? parseInt(out.sample, 10) : undefined,
        threshold: out.threshold ? parseFloat(out.threshold) : 0.5,
    };
}

function ensureDir(p: string): void {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function generateExperimentId(condId: string): string {
    return `${condId}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

class Semaphore {
    private active = 0;
    private waiters: Array<() => void> = [];
    constructor(private limit: number) {}
    async acquire(): Promise<void> {
        if (this.active < this.limit) { this.active++; return; }
        return new Promise(resolve => this.waiters.push(() => { this.active++; resolve(); }));
    }
    release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}

function calculateMetrics(items: PerItemResult[], threshold: number): Evaluation {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const it of items) {
        if (it.include_probability === null) continue;
        const predicted = it.include_probability >= threshold ? 1 : 0;
        const actual = it.label_included === 1 ? 1 : 0;
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

async function runOne(
    ref: Reference & { label_included: number },
    condition: Condition,
    screeningPrompt: string
): Promise<PerItemResult> {
    const start = Date.now();
    try {
        const { output, usageMetadata } = await screenViaOpenAi({
            title: ref.title,
            abstract: ref.abstract || '',
            screeningPrompt,
            model: condition.model,
            temperature: 0, // provider が無視する（reasoning モデルは temperature を拒否）
            reasoningEffort: condition.reasoningEffort,
            maxOutputTokens: condition.maxOutputTokens,
            outputLanguage: 'ja',
        });
        return {
            ref_id: ref.ref_id,
            label_included: ref.label_included,
            include_probability: output.include_probability,
            reasons: output.reasons || [],
            durationMs: Date.now() - start,
            usage: {
                prompt: usageMetadata.promptTokenCount,
                cached: usageMetadata.cachedInputTokens ?? 0,
                completion: usageMetadata.candidatesTokenCount,
                reasoning: usageMetadata.thoughtsTokenCount,
                total: usageMetadata.totalTokenCount,
            },
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ref_id: ref.ref_id,
            label_included: ref.label_included,
            include_probability: null,
            reasons: [],
            error: msg,
            durationMs: Date.now() - start,
        };
    }
}

function computeCost(
    tokens: { prompt: number; cached: number; completion: number; reasoning: number },
    pricing: Pricing | undefined
): number | undefined {
    if (!pricing) return undefined;
    const uncachedInput = Math.max(0, tokens.prompt - tokens.cached);
    const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
    // OpenAI Responses API では output_tokens (=completion) に reasoning_tokens が
    // 含まれる (total = input + output を確認済み)。reasoning を足すと二重計上になるため
    // 出力課金は completion のみで計算する。reasoning は内訳表示用に別途保持する。
    return (
        (uncachedInput / 1_000_000) * pricing.inputPerMillion +
        (tokens.cached / 1_000_000) * cachedRate +
        (tokens.completion / 1_000_000) * pricing.outputPerMillion
    );
}

async function main(): Promise<void> {
    const args = parseArgs();
    const configPath = path.join(__dirname, 'config.json');
    const config: BenchConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    const condition = config.conditions.find(c => c.id === args.condition);
    if (!condition) throw new Error(`不明な condition: ${args.condition}`);

    const rateLimit = config.rateLimits[condition.rateLimit];
    if (!rateLimit) throw new Error(`不明な rateLimit: ${condition.rateLimit}`);

    const datasetRel = config.datasets[args.dataset];
    if (!datasetRel) throw new Error(`不明な dataset: ${args.dataset}`);
    const projectRoot = path.resolve(__dirname, '..', '..');
    const datasetPath = path.join(projectRoot, datasetRel);

    const raw = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
    const records: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : raw.records;
    const allRefs: Array<Reference & { label_included: number }> = records.map(r => ({
        ref_id: (r.ref_id || r.id || crypto.randomUUID()) as string,
        title: (r.title || '') as string,
        abstract: (r.abstract || '') as string,
        label_included: ((r.label_included ?? r.label_tiab ?? r.label ?? 0) as number),
    }));
    const references = args.sample && args.sample < allRefs.length ? allRefs.slice(0, args.sample) : allRefs;

    let screeningPrompt = config.defaultScreeningPrompt;
    const criteria = config.datasetConfigs[args.dataset]?.criteria || '';
    if (screeningPrompt.includes('{{CRITERIA}}')) {
        screeningPrompt = screeningPrompt.replace('{{CRITERIA}}', criteria);
    } else if (criteria) {
        screeningPrompt = `## Inclusion Criteria\n${criteria}\n\n${screeningPrompt}`;
    }

    const experimentId = generateExperimentId(condition.id);
    const resultsDir = path.join(__dirname, 'results');
    ensureDir(resultsDir);
    const logPath = path.join(resultsDir, `experiment_${experimentId}.log.json`);
    const itemsPath = path.join(resultsDir, `items_${experimentId}.json`);

    const log: ExperimentLog = {
        experimentId,
        startTime: new Date().toISOString(),
        parameters: {
            dataset: args.dataset,
            datasetPath,
            totalRecords: allRefs.length,
            sampleSize: args.sample,
            condition,
            rateLimitName: condition.rateLimit,
            rateLimitConfig: rateLimit,
            screeningPrompt,
        },
    };
    const save = () => fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    save();

    console.log(`=== ${experimentId} ===`);
    console.log(`provider=${condition.provider} model=${condition.model} reasoning=${condition.reasoningEffort} maxOut=${condition.maxOutputTokens ?? '-'}`);
    console.log(`dataset=${args.dataset} N=${references.length} (positives=${references.filter(r => r.label_included === 1).length})`);
    console.log(`rateLimit=${condition.rateLimit} concurrency=${rateLimit.concurrency} delayMs=${rateLimit.delayBetweenRequests}`);

    const checkpointEvery = config.checkpointEvery ?? 50;
    const sem = new Semaphore(rateLimit.concurrency);
    const items: PerItemResult[] = [];
    let processed = 0;
    const start = Date.now();

    const flushItems = () => fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));

    const tasks = references.map(async (ref) => {
        await sem.acquire();
        try {
            const r = await runOne(ref, condition, screeningPrompt);
            items.push(r);
            processed++;
            const pct = ((processed / references.length) * 100).toFixed(1);
            process.stdout.write(`\r進捗 ${processed}/${references.length} (${pct}%) errors=${items.filter(i => i.error).length}`);
            // 中間チェックポイント保存（途中クラッシュ対策）
            if (processed % checkpointEvery === 0) {
                flushItems();
                log.results = {
                    processedCount: items.length,
                    successCount: items.filter(i => !i.error).length,
                    failCount: items.filter(i => i.error).length,
                    durationMs: Date.now() - start,
                    avgTimePerItem: items.length > 0 ? (Date.now() - start) / items.length : 0,
                };
                save();
            }
            if (rateLimit.delayBetweenRequests > 0) {
                await new Promise(res => setTimeout(res, rateLimit.delayBetweenRequests));
            }
        } finally {
            sem.release();
        }
    });
    await Promise.all(tasks);
    console.log('');

    const durationMs = Date.now() - start;
    flushItems();

    const failCount = items.filter(i => i.error).length;
    const successCount = items.length - failCount;

    const tokensTotal = items.reduce((acc, it) => {
        if (it.usage) {
            acc.prompt += it.usage.prompt;
            acc.cached += it.usage.cached;
            acc.completion += it.usage.completion;
            acc.reasoning += it.usage.reasoning;
        }
        return acc;
    }, { prompt: 0, cached: 0, completion: 0, reasoning: 0 });

    const estimatedCostUsd = computeCost(tokensTotal, config.pricing[condition.model]);

    log.results = {
        processedCount: items.length,
        successCount,
        failCount,
        durationMs,
        avgTimePerItem: items.length > 0 ? durationMs / items.length : 0,
        tokensTotal,
        estimatedCostUsd,
    };
    log.evaluation = calculateMetrics(items, args.threshold);
    log.endTime = new Date().toISOString();
    save();

    console.log(`\n=== 結果 (threshold=${args.threshold}) ===`);
    console.log(`TP=${log.evaluation.truePositives} FP=${log.evaluation.falsePositives} TN=${log.evaluation.trueNegatives} FN=${log.evaluation.falseNegatives}`);
    console.log(`Sensitivity: ${(log.evaluation.sensitivity * 100).toFixed(2)}%`);
    console.log(`Specificity: ${(log.evaluation.specificity * 100).toFixed(2)}%`);
    console.log(`Precision:   ${(log.evaluation.precision * 100).toFixed(2)}%`);
    console.log(`Fβ(β=7):     ${(log.evaluation.fBetaScore * 100).toFixed(2)}%`);
    console.log(`tokens: prompt=${tokensTotal.prompt} (cached=${tokensTotal.cached}) completion=${tokensTotal.completion} reasoning=${tokensTotal.reasoning}`);
    if (estimatedCostUsd !== undefined) {
        console.log(`推定コスト: $${estimatedCostUsd.toFixed(4)}`);
        if (references.length > 0) {
            const perFull = (estimatedCostUsd / references.length) * allRefs.length;
            console.log(`（1件あたり $${(estimatedCostUsd / references.length).toFixed(6)} → 全${allRefs.length}件換算 $${perFull.toFixed(2)}）`);
        }
    }
    console.log(`log:   ${logPath}`);
    console.log(`items: ${itemsPath}`);
}

main().catch(err => {
    console.error('実験失敗:', err);
    process.exit(1);
});
