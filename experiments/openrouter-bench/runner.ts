/**
 * OpenRouter ベンチマーク用ランナー
 *
 * provider: 'gemini' | 'openrouter' を見て呼び分ける。
 * Gemini 側は src/lib/gemini-api.ts の screenReference を流用し、
 * OpenRouter 側は ./openrouter-client.ts を使う。
 *
 * 評価指標は既存 experiments/runner.ts と完全に揃える（threshold=0.5 既定、Fβ=7）。
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { screenReference, GeminiModelConfig } from '../../src/lib/gemini-api';
import { screenViaOpenRouter, OpenRouterModelConfig, OpenRouterUsage } from './openrouter-client';
import type { Reference, RateLimitConfig, LlmScreeningOutput } from '../../src/lib/types';

interface Condition {
    id: string;
    provider: 'gemini' | 'openrouter';
    model: string;
    temperature: number;
    topP?: number;
    thinkingLevel?: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
    rateLimit: string;
    note?: string;
}

interface Pricing { inputPerMillion: number; outputPerMillion: number }

interface BenchConfig {
    description: string;
    version: string;
    datasets: Record<string, string>;
    datasetConfigs: Record<string, { criteria: string }>;
    defaultScreeningPrompt: string;
    rateLimits: Record<string, RateLimitConfig>;
    conditions: Condition[];
    pricing: Record<string, Pricing>;
}

interface PerItemResult {
    ref_id: string;
    label_included: number;
    include_probability: number | null;
    reasons: string[];
    error?: string;
    durationMs: number;
    usage?: { prompt: number; completion: number; reasoning: number; total: number };
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
        tokensTotal?: { prompt: number; completion: number; reasoning: number };
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
        condition: out.condition || 'REF-B',
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
        if (condition.provider === 'gemini') {
            const cfg: GeminiModelConfig = {
                model: condition.model,
                temperature: condition.temperature,
                topP: condition.topP,
                thinkingLevel: condition.thinkingLevel,
            };
            const { output, usageMetadata } = await screenReference(
                ref.title,
                ref.abstract || '',
                screeningPrompt,
                cfg,
                'ja'
            );
            return {
                ref_id: ref.ref_id,
                label_included: ref.label_included,
                include_probability: output.include_probability,
                reasons: output.reasons || [],
                durationMs: Date.now() - start,
                usage: {
                    prompt: usageMetadata.promptTokenCount,
                    completion: usageMetadata.candidatesTokenCount,
                    reasoning: usageMetadata.thoughtsTokenCount,
                    total: usageMetadata.totalTokenCount,
                },
            };
        } else {
            const cfg: OpenRouterModelConfig = {
                model: condition.model,
                temperature: condition.temperature,
                topP: condition.topP,
                reasoningEffort: condition.reasoningEffort,
            };
            const { output, usage } = await screenViaOpenRouter(
                ref.title,
                ref.abstract || '',
                screeningPrompt,
                cfg
            );
            return {
                ref_id: ref.ref_id,
                label_included: ref.label_included,
                include_probability: output.include_probability,
                reasons: output.reasons || [],
                durationMs: Date.now() - start,
                usage: {
                    prompt: usage.promptTokens,
                    completion: usage.completionTokens,
                    reasoning: usage.reasoningTokens,
                    total: usage.totalTokens,
                },
            };
        }
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
    console.log(`provider=${condition.provider} model=${condition.model} temp=${condition.temperature} topP=${condition.topP ?? '-'} reasoning=${condition.reasoningEffort ?? condition.thinkingLevel ?? '-'}`);
    console.log(`dataset=${args.dataset} N=${references.length} (positives=${references.filter(r => r.label_included === 1).length})`);
    console.log(`rateLimit=${condition.rateLimit} concurrency=${rateLimit.concurrency} delayMs=${rateLimit.delayBetweenRequests}`);

    const sem = new Semaphore(rateLimit.concurrency);
    const items: PerItemResult[] = [];
    let processed = 0;
    const start = Date.now();

    const tasks = references.map(async (ref) => {
        await sem.acquire();
        try {
            const r = await runOne(ref, condition, screeningPrompt);
            items.push(r);
            processed++;
            const pct = ((processed / references.length) * 100).toFixed(1);
            process.stdout.write(`\r進捗 ${processed}/${references.length} (${pct}%) errors=${items.filter(i => i.error).length}`);
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
    fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));

    const failCount = items.filter(i => i.error).length;
    const successCount = items.length - failCount;

    const tokensTotal = items.reduce((acc, it) => {
        if (it.usage) {
            acc.prompt += it.usage.prompt;
            acc.completion += it.usage.completion;
            acc.reasoning += it.usage.reasoning;
        }
        return acc;
    }, { prompt: 0, completion: 0, reasoning: 0 });

    const pricing = config.pricing[condition.model];
    let estimatedCostUsd: number | undefined;
    if (pricing) {
        estimatedCostUsd =
            (tokensTotal.prompt / 1_000_000) * pricing.inputPerMillion +
            ((tokensTotal.completion + tokensTotal.reasoning) / 1_000_000) * pricing.outputPerMillion;
    }

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
    console.log(`tokens: prompt=${tokensTotal.prompt} completion=${tokensTotal.completion} reasoning=${tokensTotal.reasoning}`);
    if (estimatedCostUsd !== undefined) console.log(`推定コスト: $${estimatedCostUsd.toFixed(4)}`);
    console.log(`log:   ${logPath}`);
    console.log(`items: ${itemsPath}`);
}

main().catch(err => {
    console.error('実験失敗:', err);
    process.exit(1);
});
