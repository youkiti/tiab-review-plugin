/**
 * Gemini implicit caching コスト実験ランナー
 *
 * 既存 experiments/gemini-3.1-flash-lite-ga/runner.ts をベースに、以下を追加:
 * - 条件ごとのプロンプト変種 (P0=現行の短い共有プレフィックス / P1=キャッシュ最小トークン超えを狙う長い共有プレフィックス)
 * - ウォームアップ要求 (--warmup N): バッチ一斉発射の前に逐次 N 件送り、implicit cache にプレフィックスを載せる
 * - 判定結果 (decisions) の note.usageMetadata から cachedInputTokens (= Gemini usageMetadata.cachedContentTokenCount)
 *   を集計し、ヒット率・キャッシュトークン比率・推定コスト（割引あり/なし）をログへ保存
 *
 * 前提: src/lib/gemini-api.ts が usageMetadata.cachedContentTokenCount を
 * UsageMetadata.cachedInputTokens として返すこと（本ブランチの変更）。
 */
import dotenv from 'dotenv';
import path from 'path';

// プロジェクトルートから.envを読み込む
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { processBatch, BatchProcessOptions, BatchProcessResult } from '../../src/lib/llm-processor';
import { screenWithProvider } from '../../src/lib/llm-provider';
import type { Reference, RateLimitConfig, UsageMetadata } from '../../src/lib/types';

// ============================================================
// 型定義
// ============================================================

interface ModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
}

interface PricingConfig {
    cachedInputMultiplier: number;
    note?: string;
    models: Record<string, ModelPricing>;
}

interface ExperimentConfig {
    description: string;
    version: string;
    datasets: Record<string, string>;
    datasetConfigs?: Record<string, { criteria: string }>;
    promptVariants: Record<string, string>;
    pricing: PricingConfig;
    tierConfigs: Record<string, RateLimitConfig>;
    conditions: Condition[];
}

interface Condition {
    id: string;
    model: string;
    temperature: number;
    topP?: number;
    thinkingLevel?: string;
    maxOutputTokens?: number;
    promptVariant: string;
}

/** decisions から集計した usage サマリー */
interface UsageSummary {
    /** usageMetadata を持つ判定の件数（フォールバック判定は usage を持たない） */
    decisionsWithUsage: number;
    decisionsWithoutUsage: number;
    totalPromptTokens: number;
    totalCachedInputTokens: number;
    totalCandidatesTokens: number;
    totalThoughtsTokens: number;
    /** cachedInputTokens > 0 だったリクエスト数 */
    cacheHitCount: number;
    /** cacheHitCount / decisionsWithUsage */
    cacheHitRate: number;
    /** totalCachedInputTokens / totalPromptTokens */
    cachedTokenShare: number;
}

/** 推定コスト（USD）。単価は config.json の pricing（実行前に要更新）に基づく */
interface CostSummary {
    pricing: ModelPricing & { cachedInputMultiplier: number };
    /** キャッシュ割引を織り込んだ推定実効コスト */
    estimatedCostUsd: number;
    /** 全入力を非キャッシュ単価で計算した場合（= キャッシュが一切効かない場合） */
    noCacheCostUsd: number;
    /** 1 - estimated/noCache */
    savingsRatio: number;
    inputCostUsd: number;
    cachedInputCostUsd: number;
    outputCostUsd: number;
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
        tier: string;
        rateLimitConfig: RateLimitConfig;
        promptVariant: string;
        promptFile: string;
        /** 共有プレフィックス（screeningPrompt）の文字数。トークン数は promptTokenCount 実測で確認 */
        screeningPromptChars: number;
        warmupCount: number;
        screeningPrompt: string;
    };
    warmup?: Array<{ refId: string; usageMetadata: UsageMetadata }>;
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        durationMs: number;
        avgTimePerItem: number;
    };
    usageSummary?: UsageSummary;
    costSummary?: CostSummary;
    evaluation?: EvaluationResult;
    error?: string;
}

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

// ============================================================
// ユーティリティ
// ============================================================

function parseArgs(): {
    dataset: string;
    condition: string;
    tier: string;
    sample?: number;
    threshold?: number;
    warmup: number;
} {
    const args = process.argv.slice(2);
    const result: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].slice(2);
            const value = args[i + 1];
            if (value && !value.startsWith('--')) {
                result[key] = value;
                i++;
            }
        }
    }

    return {
        dataset: result.dataset || 'depression',
        condition: result.condition || 'lite-P0',
        tier: result.tier || 'tier_max',
        sample: result.sample ? parseInt(result.sample, 10) : undefined,
        threshold: result.threshold ? parseFloat(result.threshold) : 0.5,
        warmup: result.warmup !== undefined ? parseInt(result.warmup, 10) : 1,
    };
}

function generateExperimentId(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// ============================================================
// ログ出力
// ============================================================

class ExperimentLogger {
    private logPath: string;
    private log: ExperimentLog;
    private console: string[] = [];

    constructor(experimentId: string, resultsDir: string) {
        ensureDir(resultsDir);
        this.logPath = path.join(resultsDir, `experiment_${experimentId}.log.json`);
        this.log = {
            experimentId,
            startTime: new Date().toISOString(),
            parameters: {} as ExperimentLog['parameters'],
        };
    }

    setParameters(params: ExperimentLog['parameters']): void {
        this.log.parameters = params;
        this.save();
    }

    setWarmup(warmup: ExperimentLog['warmup']): void {
        this.log.warmup = warmup;
        this.save();
    }

    setResults(results: ExperimentLog['results']): void {
        this.log.results = results;
        this.save();
    }

    setUsageSummary(summary: UsageSummary): void {
        this.log.usageSummary = summary;
        this.save();
    }

    setCostSummary(summary: CostSummary): void {
        this.log.costSummary = summary;
        this.save();
    }

    setEvaluation(evaluation: EvaluationResult): void {
        this.log.evaluation = evaluation;
        this.save();
    }

    setError(error: string): void {
        this.log.error = error;
        this.save();
    }

    finish(): void {
        this.log.endTime = new Date().toISOString();
        this.save();
    }

    addConsole(message: string): void {
        const timestamp = new Date().toISOString();
        this.console.push(`[${timestamp}] ${message}`);
        console.log(message);
    }

    private save(): void {
        const output = {
            ...this.log,
            consoleLog: this.console,
        };
        fs.writeFileSync(this.logPath, JSON.stringify(output, null, 2));
    }

    getLogPath(): string {
        return this.logPath;
    }
}

// ============================================================
// usage / コスト集計
// ============================================================

function summarizeUsage(decisions: Array<{ note?: string }>): UsageSummary {
    let withUsage = 0;
    let withoutUsage = 0;
    let prompt = 0;
    let cached = 0;
    let candidates = 0;
    let thoughts = 0;
    let hits = 0;

    for (const d of decisions) {
        let usage: UsageMetadata | undefined;
        if (d.note) {
            try {
                usage = JSON.parse(d.note).usageMetadata;
            } catch {
                // note が JSON でない場合は usage なし扱い
            }
        }
        if (!usage || typeof usage.promptTokenCount !== 'number') {
            withoutUsage++;
            continue;
        }
        withUsage++;
        prompt += usage.promptTokenCount || 0;
        candidates += usage.candidatesTokenCount || 0;
        thoughts += usage.thoughtsTokenCount || 0;
        const c = usage.cachedInputTokens || 0;
        cached += c;
        if (c > 0) hits++;
    }

    return {
        decisionsWithUsage: withUsage,
        decisionsWithoutUsage: withoutUsage,
        totalPromptTokens: prompt,
        totalCachedInputTokens: cached,
        totalCandidatesTokens: candidates,
        totalThoughtsTokens: thoughts,
        cacheHitCount: hits,
        cacheHitRate: withUsage > 0 ? hits / withUsage : 0,
        cachedTokenShare: prompt > 0 ? cached / prompt : 0,
    };
}

/**
 * 推定コストを計算する。
 * - 非キャッシュ入力: (prompt - cached) × inputPerMTok
 * - キャッシュ入力:   cached × inputPerMTok × cachedInputMultiplier
 * - 出力:            (candidates + thoughts) × outputPerMTok（Gemini は思考トークンも出力単価）
 */
function summarizeCost(usage: UsageSummary, pricing: ModelPricing, cachedInputMultiplier: number): CostSummary {
    const M = 1_000_000;
    const uncachedInput = usage.totalPromptTokens - usage.totalCachedInputTokens;
    const inputCostUsd = (uncachedInput / M) * pricing.inputPerMTok;
    const cachedInputCostUsd = (usage.totalCachedInputTokens / M) * pricing.inputPerMTok * cachedInputMultiplier;
    const outputCostUsd = ((usage.totalCandidatesTokens + usage.totalThoughtsTokens) / M) * pricing.outputPerMTok;
    const estimatedCostUsd = inputCostUsd + cachedInputCostUsd + outputCostUsd;
    const noCacheCostUsd = (usage.totalPromptTokens / M) * pricing.inputPerMTok + outputCostUsd;
    return {
        pricing: { ...pricing, cachedInputMultiplier },
        estimatedCostUsd,
        noCacheCostUsd,
        savingsRatio: noCacheCostUsd > 0 ? 1 - estimatedCostUsd / noCacheCostUsd : 0,
        inputCostUsd,
        cachedInputCostUsd,
        outputCostUsd,
    };
}

// ============================================================
// 評価指標計算
// ============================================================

function calculateMetrics(
    decisions: Array<{ ref_id: string; note?: string }>,
    references: Array<{ ref_id: string; label_included: number }>,
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

// ============================================================
// メイン処理
// ============================================================

async function main(): Promise<void> {
    const args = parseArgs();
    const experimentId = generateExperimentId();
    const resultsDir = path.join(__dirname, 'results');
    const logger = new ExperimentLogger(experimentId, resultsDir);

    logger.addConsole(`=== Starting Experiment ${experimentId} ===`);
    logger.addConsole(`Dataset: ${args.dataset}, Condition: ${args.condition}, Tier: ${args.tier}, Warmup: ${args.warmup}`);

    try {
        // 設定読み込み（本フォルダのconfig.json）
        const configPath = path.join(__dirname, 'config.json');
        const config: ExperimentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        // データセット読み込み（プロジェクトルートから解決）
        const datasetPath = config.datasets[args.dataset];
        if (!datasetPath) {
            throw new Error(`不明なデータセット: ${args.dataset}`);
        }

        const projectRoot = path.resolve(__dirname, '..', '..');
        const fullDatasetPath = path.join(projectRoot, datasetPath);
        const rawData = fs.readFileSync(fullDatasetPath, 'utf-8');
        const parsedData = JSON.parse(rawData);

        let rawRecords: Array<Record<string, unknown>>;
        if (Array.isArray(parsedData)) {
            rawRecords = parsedData;
        } else if (parsedData.records && Array.isArray(parsedData.records)) {
            rawRecords = parsedData.records;
        } else {
            throw new Error(`不正なデータセット形式: 配列またはrecordsプロパティが必要`);
        }

        const allReferences: Array<Reference & { label_included: number }> = rawRecords.map((r: Record<string, unknown>) => ({
            ref_id: (r.ref_id || r.id || crypto.randomUUID()) as string,
            title: (r.title || '') as string,
            abstract: (r.abstract || '') as string,
            year: r.year as number | undefined,
            journal: r.journal as string | undefined,
            doi: r.doi as string | undefined,
            pmid: (r.pmid || r.pubmed_id) as string | undefined,
            label_included: ((r.label_included ?? r.label_tiab ?? r.label ?? 0) as number),
        }));

        logger.addConsole(`${allReferences.length}件の文献を${args.dataset}から読み込み`);

        const positiveCount = allReferences.filter(r => r.label_included === 1).length;
        logger.addConsole(`ラベル分布: 陽性=${positiveCount}, 陰性=${allReferences.length - positiveCount}`);

        // サンプリング
        let references = allReferences;
        if (args.sample && args.sample < allReferences.length) {
            references = allReferences.slice(0, args.sample);
            logger.addConsole(`${args.sample}件にサンプリング`);
        }

        // 条件取得
        const condition = config.conditions.find(c => c.id === args.condition);
        if (!condition) {
            throw new Error(`不明な条件: ${args.condition}`);
        }

        // 料金設定（モデルごと。config.json 冒頭の note のとおり実行前に要更新）
        const modelPricing = config.pricing.models[condition.model];
        if (!modelPricing) {
            throw new Error(`pricing.models に ${condition.model} がありません`);
        }

        // レート制限設定
        const rateLimitConfig = config.tierConfigs[args.tier];
        if (!rateLimitConfig) {
            throw new Error(`不明なtier: ${args.tier}`);
        }

        // プロンプト変種の読み込み（{{CRITERIA}} をデータセット基準で置換）
        const promptFile = config.promptVariants[condition.promptVariant];
        if (!promptFile) {
            throw new Error(`不明なプロンプト変種: ${condition.promptVariant}`);
        }
        const promptTemplate = fs.readFileSync(path.join(__dirname, promptFile), 'utf-8');
        const criteria = config.datasetConfigs?.[args.dataset]?.criteria || '';
        const screeningPrompt = promptTemplate.replace('{{CRITERIA}}', criteria).trimEnd();

        logger.setParameters({
            dataset: args.dataset,
            datasetPath: fullDatasetPath,
            totalRecords: allReferences.length,
            sampleSize: args.sample,
            condition,
            tier: args.tier,
            rateLimitConfig,
            promptVariant: condition.promptVariant,
            promptFile,
            screeningPromptChars: screeningPrompt.length,
            warmupCount: args.warmup,
            screeningPrompt,
        });

        logger.addConsole(`条件: ${JSON.stringify(condition)}`);
        logger.addConsole(`プロンプト変種: ${condition.promptVariant} (${promptFile}, ${screeningPrompt.length} chars)`);
        logger.addConsole(`レート制限: concurrency=${rateLimitConfig.concurrency}, delay=${rateLimitConfig.delayBetweenRequests}ms`);

        // ウォームアップ: バッチの一斉発射前に逐次リクエストを送り、implicit cache に
        // プレフィックスを載せる。同時多発の初回リクエストは全て cache miss になりうるため、
        // 「キャッシュが立ち上がった後」の挙動を測るのが目的。
        // 対象文献はバッチと同じ先頭レコードを使う（decisions には別途含まれるので二重計上しない）。
        if (args.warmup > 0 && references.length > 0) {
            logger.addConsole(`ウォームアップ ${args.warmup} 件を逐次送信...`);
            const warmupLogs: NonNullable<ExperimentLog['warmup']> = [];
            for (let i = 0; i < args.warmup; i++) {
                const ref = references[i % references.length];
                const { usageMetadata } = await screenWithProvider('gemini', {
                    title: ref.title,
                    abstract: ref.abstract || '',
                    screeningPrompt,
                    model: condition.model,
                    temperature: condition.temperature,
                    topP: condition.topP,
                    thinkingLevel: condition.thinkingLevel,
                    maxOutputTokens: condition.maxOutputTokens,
                    outputLanguage: 'ja',
                });
                warmupLogs.push({ refId: ref.ref_id, usageMetadata });
                logger.addConsole(`  warmup#${i + 1}: prompt=${usageMetadata.promptTokenCount}, cached=${usageMetadata.cachedInputTokens ?? 0}`);
            }
            logger.setWarmup(warmupLogs);
        }

        // バッチ処理実行
        const startTime = Date.now();

        const options: BatchProcessOptions = {
            batchSize: Math.max(50, rateLimitConfig.concurrency),
            screeningPrompt,
            model: condition.model,
            temperature: condition.temperature,
            topP: condition.topP,
            thinkingLevel: condition.thinkingLevel,
            maxOutputTokens: condition.maxOutputTokens,
            outputLanguage: 'ja',
            rateLimitConfig,
            onProgress: (progress) => {
                const percent = ((progress.processed / progress.total) * 100).toFixed(1);
                process.stdout.write(`\rProgress: ${progress.processed}/${progress.total} (${percent}%) - Success: ${progress.succeeded}, Failed: ${progress.failed}`);
            },
        };

        const result: BatchProcessResult = await processBatch(references, options);

        const endTime = Date.now();
        const durationMs = endTime - startTime;

        console.log('\n');

        logger.setResults({
            processedCount: result.processedCount,
            successCount: result.successCount,
            failCount: result.failCount,
            durationMs,
            avgTimePerItem: durationMs / result.processedCount,
        });

        logger.addConsole(`完了: ${result.successCount}/${result.processedCount} 成功 (${(durationMs / 1000).toFixed(1)}秒)`);
        logger.addConsole(`平均処理時間: ${(durationMs / result.processedCount).toFixed(0)}ms/件`);

        // 結果保存
        const decisionsPath = path.join(resultsDir, `decisions_${experimentId}.json`);
        fs.writeFileSync(decisionsPath, JSON.stringify(result.decisions, null, 2));
        logger.addConsole(`判定結果を保存: ${decisionsPath}`);

        // usage / コスト集計（本実験の主要アウトカム）
        const usageSummary = summarizeUsage(result.decisions);
        logger.setUsageSummary(usageSummary);
        const costSummary = summarizeCost(usageSummary, modelPricing, config.pricing.cachedInputMultiplier);
        logger.setCostSummary(costSummary);

        logger.addConsole(`\n=== キャッシュ集計 ===`);
        logger.addConsole(`usageあり判定: ${usageSummary.decisionsWithUsage}件 (usageなし: ${usageSummary.decisionsWithoutUsage}件)`);
        logger.addConsole(`入力トークン合計: ${usageSummary.totalPromptTokens} (うちキャッシュ: ${usageSummary.totalCachedInputTokens}, ${(usageSummary.cachedTokenShare * 100).toFixed(1)}%)`);
        logger.addConsole(`出力トークン合計: candidates=${usageSummary.totalCandidatesTokens}, thoughts=${usageSummary.totalThoughtsTokens}`);
        logger.addConsole(`キャッシュヒット率: ${(usageSummary.cacheHitRate * 100).toFixed(1)}% (${usageSummary.cacheHitCount}/${usageSummary.decisionsWithUsage}件)`);
        logger.addConsole(`推定コスト: $${costSummary.estimatedCostUsd.toFixed(4)} (キャッシュなし想定: $${costSummary.noCacheCostUsd.toFixed(4)}, 削減率 ${(costSummary.savingsRatio * 100).toFixed(1)}%)`);
        logger.addConsole(`  内訳: 入力 $${costSummary.inputCostUsd.toFixed(4)} + キャッシュ入力 $${costSummary.cachedInputCostUsd.toFixed(4)} + 出力 $${costSummary.outputCostUsd.toFixed(4)}`);

        // 評価（精度劣化チェック用の副次アウトカム）
        const threshold = args.threshold || 0.5;
        const evaluation = calculateMetrics(result.decisions, references, threshold);
        logger.setEvaluation(evaluation);

        logger.addConsole(`\n=== 評価結果 (threshold=${threshold}) ===`);
        logger.addConsole(`TP: ${evaluation.truePositives}, FP: ${evaluation.falsePositives}`);
        logger.addConsole(`TN: ${evaluation.trueNegatives}, FN: ${evaluation.falseNegatives}`);
        logger.addConsole(`Sensitivity: ${(evaluation.sensitivity * 100).toFixed(2)}%`);
        logger.addConsole(`Specificity: ${(evaluation.specificity * 100).toFixed(2)}%`);
        logger.addConsole(`Precision: ${(evaluation.precision * 100).toFixed(2)}%`);
        logger.addConsole(`Fβ(β=7): ${(evaluation.fBetaScore * 100).toFixed(2)}%`);

        logger.finish();
        logger.addConsole(`\nログ保存先: ${logger.getLogPath()}`);

    } catch (error) {
        logger.setError((error as Error).message);
        logger.finish();
        console.error('実験失敗:', error);
        process.exit(1);
    }
}

main().catch(console.error);
