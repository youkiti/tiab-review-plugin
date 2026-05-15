/**
 * gemini-3.1-flash-lite (GA) 実験ランナー
 * 既存 experiments/runner.ts をベースに、本フォルダ用に調整
 */
import dotenv from 'dotenv';
import path from 'path';

// プロジェクトルートから.envを読み込む
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { processBatch, BatchProcessOptions, BatchProcessResult } from '../../src/lib/llm-processor';
import type { Reference, RateLimitConfig } from '../../src/lib/types';

// ============================================================
// 型定義
// ============================================================

interface ExperimentConfig {
    description: string;
    version: string;
    datasets: Record<string, string>;
    datasetConfigs?: Record<string, { criteria: string }>;
    defaultScreeningPrompt: string;
    tierConfigs: Record<string, RateLimitConfig>;
    conditions: Condition[];
}

interface Condition {
    id: string;
    model: string;
    temperature: number;
    topP?: number;
    thinkingLevel?: string;
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
        screeningPrompt: string;
    };
    results?: {
        processedCount: number;
        successCount: number;
        failCount: number;
        durationMs: number;
        avgTimePerItem: number;
    };
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
        condition: result.condition || 'C1',
        tier: result.tier || 'tier_max',
        sample: result.sample ? parseInt(result.sample, 10) : undefined,
        threshold: result.threshold ? parseFloat(result.threshold) : 0.5,
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

    setResults(results: ExperimentLog['results']): void {
        this.log.results = results;
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

        // noteからinclude_probabilityを取得
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

    // Fβ score (β=7)
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
    logger.addConsole(`Dataset: ${args.dataset}, Condition: ${args.condition}, Tier: ${args.tier}`);

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

        // オブジェクト形式（records配列を持つ）か配列形式かを判定
        let rawRecords: Array<Record<string, unknown>>;
        if (Array.isArray(parsedData)) {
            rawRecords = parsedData;
        } else if (parsedData.records && Array.isArray(parsedData.records)) {
            rawRecords = parsedData.records;
        } else {
            throw new Error(`不正なデータセット形式: 配列またはrecordsプロパティが必要`);
        }

        // フィールド名を正規化（label_tiab対応: Wilson用）
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

        // ラベル分布の表示
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

        // レート制限設定
        const rateLimitConfig = config.tierConfigs[args.tier];
        if (!rateLimitConfig) {
            throw new Error(`不明なtier: ${args.tier}`);
        }

        // スクリーニングプロンプト構築
        let screeningPrompt = config.defaultScreeningPrompt;
        const datasetConfig = config.datasetConfigs?.[args.dataset];
        const criteria = datasetConfig?.criteria || '';

        if (screeningPrompt.includes('{{CRITERIA}}')) {
            screeningPrompt = screeningPrompt.replace('{{CRITERIA}}', criteria);
        } else if (criteria) {
            screeningPrompt = `## Inclusion Criteria\n${criteria}\n\n${screeningPrompt}`;
        }

        // パラメータログ
        logger.setParameters({
            dataset: args.dataset,
            datasetPath: fullDatasetPath,
            totalRecords: allReferences.length,
            sampleSize: args.sample,
            condition,
            tier: args.tier,
            rateLimitConfig,
            screeningPrompt,
        });

        logger.addConsole(`条件: ${JSON.stringify(condition)}`);
        logger.addConsole(`レート制限: concurrency=${rateLimitConfig.concurrency}, delay=${rateLimitConfig.delayBetweenRequests}ms`);

        // バッチ処理実行
        const startTime = Date.now();

        const options: BatchProcessOptions = {
            batchSize: Math.max(50, rateLimitConfig.concurrency),
            screeningPrompt,
            model: condition.model,
            temperature: condition.temperature,
            topP: condition.topP,
            thinkingLevel: condition.thinkingLevel,
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

        // 結果ログ
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

        // 評価
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
