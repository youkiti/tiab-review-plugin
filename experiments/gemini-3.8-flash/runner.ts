/**
 * gemini-3.8-flash 実験ランナー
 * gemini-3.7-flash 版ランナーをベースに、以下を変更している:
 * - サンプリングパラメータ（temperature / topP）は条件 (config.json の conditions) に
 *   定義されていなければ送らない。公式移行ガイドが非推奨としているため、本実験では
 *   F1/F2 とも temperature / topP キー自体を持たせていない
 *   （generationConfig 側は undefined を JSON.stringify が落とすことで自然に省略される）。
 *
 * 中断耐性: results/<dataset>_<condition>_items.jsonl に1件ごとの判定結果を
 * 追記保存する。再実行時はこの JSONL を読み込み、既に判定済み（decision あり）
 * の ref_id をスキップして未処理分だけを processBatch に渡す。--fresh を付けると
 * 既存 JSONL を無視し、最初からやり直す（既存ファイルは削除せず .bak にリネーム）。
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

import fs from 'fs';
import { processBatch, BatchProcessOptions, BatchProcessResult, parseLlmDecisionNote } from '../../src/lib/llm-processor';
import type { Reference, RateLimitConfig, LlmDecisionNote, Decision } from '../../src/lib/types';

// ============================================================
// 型定義
// ============================================================

interface ExperimentConfig {
    description: string;
    version: string;
    pricing: {
        inputPerMTok: number;
        outputPerMTok: number;
        note?: string;
    };
    datasets: Record<string, string>;
    datasetConfigs?: Record<string, { criteria: string }>;
    defaultScreeningPrompt: string;
    tierConfigs: Record<string, RateLimitConfig>;
    conditions: Condition[];
    excludedConditions?: Array<Partial<Condition> & { id: string; reason?: string }>;
}

interface Condition {
    id: string;
    model: string;
    temperature?: number;
    topP?: number;
    thinkingLevel?: string;
    maxOutputTokens?: number;
}

interface UsageAggregate {
    promptTokens: number;
    candidatesTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
    samples: number;
    maxTokensTruncated: number;
    parseErrorFallback: number;
}

interface CostEstimate {
    inputUSD: number;
    outputUSD: number;
    totalUSD: number;
    usdPer1000Items: number;
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
        fallbackCount: number;
        durationMs: number;
        avgTimePerItem: number;
        modelVersions: string[];
        resumedFromJsonl?: number;
    };
    usage?: UsageAggregate;
    cost?: CostEstimate;
    evaluation?: EvaluationResult;
    error?: string;
}

// JSONL の1行分（再開用の永続化レコード）。
// decision が入っていれば「判定済み」としてスキップ対象、error が入っていれば
// 「一過性の失敗として否定的な結果は残さず」再開時に再試行対象へ含める。
//
// 注意: processWithRetry はリトライを使い切ると include_probability=1.0 の
// フォールバック判定（note.parse_error === true）を返す。これは processBatch の
// 戻り値としては「成功」扱い（Recall 集計上も陽性としてカウントする現行仕様）だが、
// JSONL の再開判定にそのまま流すと「一過性の API 失敗で作られた確率1.0＝include」が
// 判定済みとして焼き付き、二度と再試行されなくなる。そのため JSONL への書き込みだけは
// parse_error なフォールバックを decision 行ではなく error 行として記録する
// （appendJsonlResults 参照）。今回セッションの集計・fallbackCount 報告は
// processBatch の戻り値 (result.decisions) をそのまま使うため、この書き分けの
// 影響を受けない。
interface JsonlRow {
    ref_id: string;
    decision?: Decision;
    error?: string;
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
    fresh: boolean;
} {
    const args = process.argv.slice(2);
    const result: Record<string, string> = {};
    let fresh = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--fresh') {
            fresh = true;
            continue;
        }
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
        condition: result.condition || 'F1',
        tier: result.tier || 'tier_max',
        sample: result.sample ? parseInt(result.sample, 10) : undefined,
        threshold: result.threshold ? parseFloat(result.threshold) : 0.5,
        fresh,
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
// JSONL 再開ロジック
// ============================================================

/**
 * JSONL を読み込み、判定済み（decision あり）の ref_id と Decision を復元する。
 * 壊れた行（パース不能）はスキップして続行する（1行の破損で再開処理全体を止めない）。
 */
function loadJsonlState(jsonlPath: string): { doneDecisions: Map<string, Decision> } {
    const doneDecisions = new Map<string, Decision>();
    if (!fs.existsSync(jsonlPath)) {
        return { doneDecisions };
    }
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
        try {
            const row: JsonlRow = JSON.parse(line);
            if (row.decision) {
                // 後勝ち: 同じ ref_id が複数回書かれていても最後の行を採用する
                doneDecisions.set(row.ref_id, row.decision);
            } else if (row.error) {
                // エラー行は「判定できなかった」ものとして扱う。既に success 行が
                // 後から書かれていれば上の分岐で上書きされるため、ここでは何もしない
                // （否定的な結果を確定させないため、doneDecisions には入れない）。
            }
        } catch {
            // 破損行はスキップ（クラッシュ時の書きかけ行を想定）
        }
    }
    return { doneDecisions };
}

/**
 * 既存ファイルを潰さない .bak パスを決める。単純な `<path>.bak` は2回目の --fresh で
 * 前回のバックアップを黙って上書きしてしまうため、既に存在する場合はタイムスタンプ
 * （さらに衝突すれば連番）を付けて必ず新しい名前を返す。
 */
function uniqueBakPath(targetPath: string): string {
    const base = `${targetPath}.bak`;
    if (!fs.existsSync(base)) return base;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let candidate = `${targetPath}.bak-${ts}`;
    let n = 1;
    while (fs.existsSync(candidate)) {
        candidate = `${targetPath}.bak-${ts}-${n}`;
        n++;
    }
    return candidate;
}

/**
 * processBatch の onSaveBatch から渡される Decision を JSONL へ追記する。
 * note.parse_error === true（リトライを使い切った末のフォールバック判定）は
 * 「判定できた」ものとして焼き付けず、error 行として記録する
 * （loadJsonlState の再開ロジックにより、次回実行時に再試行対象へ戻る）。
 */
function appendJsonlResults(jsonlPath: string, decisions: Decision[]): void {
    if (decisions.length === 0) return;
    const lines = decisions.map(d => {
        const note = d.note ? parseLlmDecisionNote(d.note) : null;
        const row: JsonlRow = note?.parse_error
            ? { ref_id: d.ref_id, error: note.error_message || 'LLM出力のパースに失敗（フォールバック判定）' }
            : { ref_id: d.ref_id, decision: d };
        return JSON.stringify(row);
    }).join('\n') + '\n';
    fs.appendFileSync(jsonlPath, lines);
}

// ============================================================
// ロガー
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
    setUsage(usage: UsageAggregate, cost: CostEstimate): void {
        this.log.usage = usage;
        this.log.cost = cost;
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
        const output = { ...this.log, consoleLog: this.console };
        fs.writeFileSync(this.logPath, JSON.stringify(output, null, 2));
    }
    getLogPath(): string {
        return this.logPath;
    }
}

// ============================================================
// usage / cost 集計
// ============================================================

function aggregateUsage(
    decisions: Array<{ note?: string }>
): UsageAggregate {
    const agg: UsageAggregate = {
        promptTokens: 0,
        candidatesTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
        samples: 0,
        maxTokensTruncated: 0,
        parseErrorFallback: 0,
    };
    for (const d of decisions) {
        const note: LlmDecisionNote | null = d.note ? parseLlmDecisionNote(d.note) : null;
        if (!note) continue;
        if (note.parse_error) {
            agg.parseErrorFallback++;
            if (note.error_message && note.error_message.includes('MAX_TOKENS')) {
                agg.maxTokensTruncated++;
            }
        }
        const u = note.usageMetadata;
        if (u) {
            agg.promptTokens += u.promptTokenCount || 0;
            agg.candidatesTokens += u.candidatesTokenCount || 0;
            agg.thoughtsTokens += u.thoughtsTokenCount || 0;
            agg.totalTokens += u.totalTokenCount || 0;
            agg.samples++;
        }
    }
    return agg;
}

function estimateCost(
    usage: UsageAggregate,
    pricing: ExperimentConfig['pricing'],
    itemCount: number
): CostEstimate {
    // 出力料金は thoughtsTokens + candidatesTokens（モデル仕様: 思考トークンも出力課金対象）
    const inputUSD = (usage.promptTokens / 1_000_000) * pricing.inputPerMTok;
    const outputTokens = usage.candidatesTokens + usage.thoughtsTokens;
    const outputUSD = (outputTokens / 1_000_000) * pricing.outputPerMTok;
    const totalUSD = inputUSD + outputUSD;
    const usdPer1000Items = itemCount > 0 ? (totalUSD / itemCount) * 1000 : 0;
    return { inputUSD, outputUSD, totalUSD, usdPer1000Items };
}

// ============================================================
// 評価指標
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
            } catch { /* ignore */ }
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
        truePositives: tp, falsePositives: fp, trueNegatives: tn, falseNegatives: fn,
        sensitivity, specificity, precision, fBetaScore,
    };
}

// ============================================================
// メイン
// ============================================================

async function main(): Promise<void> {
    const args = parseArgs();
    const experimentId = generateExperimentId();
    const resultsDir = path.join(__dirname, 'results');
    const logger = new ExperimentLogger(experimentId, resultsDir);

    logger.addConsole(`=== Starting Experiment ${experimentId} ===`);
    logger.addConsole(`Dataset: ${args.dataset}, Condition: ${args.condition}, Tier: ${args.tier}`);

    try {
        const configPath = path.join(__dirname, 'config.json');
        const config: ExperimentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        const datasetPath = config.datasets[args.dataset];
        if (!datasetPath) throw new Error(`不明なデータセット: ${args.dataset}`);

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

        const allReferences: Array<Reference & { label_included: number }> = rawRecords.map((r) => ({
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

        let references = allReferences;
        if (args.sample && args.sample < allReferences.length) {
            references = allReferences.slice(0, args.sample);
            logger.addConsole(`${args.sample}件にサンプリング`);
        }

        // excludedConditions は既定でフル実行対象外だが、疎通確認（smoke）目的では
        // ここから条件定義を拾って実行できるようにする（本格実行は呼び出し側の判断に委ねる）。
        // 3.7 版は `excluded.temperature !== undefined` で条件の完全性を判定していたが、
        // 3.8 の条件は temperature を持たない（送らない方針）ためこの判定は常に false になり、
        // 除外条件を smoke で拾えなくなる。model の有無だけで判定する。
        const excluded = config.excludedConditions?.find(c => c.id === args.condition);
        const condition = config.conditions.find(c => c.id === args.condition)
            ?? (excluded && excluded.model
                ? (excluded as Condition)
                : undefined);
        if (!condition) throw new Error(`不明な条件: ${args.condition}`);
        if (excluded) {
            logger.addConsole(`注意: ${args.condition} は excludedConditions に定義された条件です (理由: ${excluded.reason ?? '不明'})`);
        }

        const rateLimitConfig = config.tierConfigs[args.tier];
        if (!rateLimitConfig) throw new Error(`不明なtier: ${args.tier}`);

        let screeningPrompt = config.defaultScreeningPrompt;
        const datasetConfig = config.datasetConfigs?.[args.dataset];
        const criteria = datasetConfig?.criteria || '';
        if (screeningPrompt.includes('{{CRITERIA}}')) {
            screeningPrompt = screeningPrompt.replace('{{CRITERIA}}', criteria);
        } else if (criteria) {
            screeningPrompt = `## Inclusion Criteria\n${criteria}\n\n${screeningPrompt}`;
        }

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
        if (condition.temperature === undefined && condition.topP === undefined) {
            logger.addConsole('サンプリングパラメータ: 送信しない（temperature / topP とも未指定）');
        } else {
            logger.addConsole(`サンプリングパラメータ: temperature=${condition.temperature ?? '(未指定)'}, topP=${condition.topP ?? '(未指定)'}`);
        }

        // --- 中断耐性: JSONL 再開ロジック ---
        // dataset × condition 単位でファイルを分ける（同じ組み合わせの再実行だけを再開対象にする）
        const jsonlPath = path.join(resultsDir, `${args.dataset}_${args.condition}_items.jsonl`);
        if (args.fresh && fs.existsSync(jsonlPath)) {
            const bakPath = uniqueBakPath(jsonlPath);
            fs.renameSync(jsonlPath, bakPath);
            logger.addConsole(`--fresh 指定: 既存JSONLを ${bakPath} に退避して最初からやり直します`);
        }
        const { doneDecisions } = args.fresh ? { doneDecisions: new Map<string, Decision>() } : loadJsonlState(jsonlPath);
        const referencesToProcess = references.filter(r => !doneDecisions.has(r.ref_id));
        if (doneDecisions.size > 0) {
            logger.addConsole(`再開: 既存JSONL(${jsonlPath})から${doneDecisions.size}件をスキップ (未処理 ${referencesToProcess.length}/${references.length}件)`);
        }

        const startTime = Date.now();
        const options: BatchProcessOptions = {
            // JSONL への即時 (1件ごとの) 追記を実現するため保存単位を1件に固定する
            // （このバッチサイズはスプレッドシート保存等では使われず、onSaveBatch の
            // フラッシュ粒度としてのみ機能する）
            batchSize: 1,
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
                process.stdout.write(`\rProgress: ${progress.processed}/${progress.total} (${percent}%) - Success: ${progress.succeeded}, Failed: ${progress.failed}, Fallback: ${progress.parseErrorFallback}`);
            },
            onSaveBatch: async (decisions) => {
                appendJsonlResults(jsonlPath, decisions);
            },
        };

        let result: BatchProcessResult;
        if (referencesToProcess.length > 0) {
            result = await processBatch(referencesToProcess, options);
        } else {
            // 全件スキップ（前回実行で完走済み）: processBatch を呼ばずに空結果を作る
            result = {
                executionId: `${condition.model}-resumed`,
                processedCount: 0,
                successCount: 0,
                failCount: 0,
                fallbackCount: 0,
                modelVersions: [],
                responseIds: [],
                decisions: [],
                failedRefIds: [],
                fallbackRefIds: [],
            };
        }
        const endTime = Date.now();
        const durationMs = endTime - startTime;
        console.log('\n');

        // 進捗ログは「作業単位（処理済み件数 / 全件数）」で出す（このセッションでの新規処理分）
        logger.setResults({
            processedCount: result.processedCount,
            successCount: result.successCount,
            failCount: result.failCount,
            fallbackCount: result.fallbackCount,
            durationMs,
            avgTimePerItem: result.processedCount > 0 ? durationMs / result.processedCount : 0,
            modelVersions: result.modelVersions,
            resumedFromJsonl: doneDecisions.size,
        });

        logger.addConsole(`今回セッション: ${result.successCount}/${result.processedCount} 成功, フォールバック ${result.fallbackCount} (${(durationMs / 1000).toFixed(1)}秒)`);
        if (result.processedCount > 0) {
            logger.addConsole(`平均処理時間: ${(durationMs / result.processedCount).toFixed(0)}ms/件`);
        }
        if (result.modelVersions.length > 0) {
            logger.addConsole(`実モデルバージョン: ${result.modelVersions.join(', ')}`);
        }

        // 集計・評価は「再開分（JSONLから復元）+ 今回新規処理分」の全件で行う。
        // これにより、再開後の Recall / コストが今回セッションの部分集合ではなく
        // 対象データセット全体を反映する。
        const allDecisions: Decision[] = [...doneDecisions.values(), ...result.decisions];
        logger.addConsole(`集計対象: 全${allDecisions.length}件 (再開分 ${doneDecisions.size}件 + 今回処理分 ${result.decisions.length}件)`);

        // 結果保存（再開分を含めた全件を保存する。既存の decisions_<id>.json の形式は変えない）
        const decisionsPath = path.join(resultsDir, `decisions_${experimentId}.json`);
        fs.writeFileSync(decisionsPath, JSON.stringify(allDecisions, null, 2));
        logger.addConsole(`判定結果を保存: ${decisionsPath}`);

        // usage / cost 集計
        const usage = aggregateUsage(allDecisions);
        const cost = estimateCost(usage, config.pricing, references.length);
        logger.setUsage(usage, cost);
        logger.addConsole(`\n=== Token / Cost ===`);
        logger.addConsole(`prompt=${usage.promptTokens}, candidates=${usage.candidatesTokens}, thoughts=${usage.thoughtsTokens}, total=${usage.totalTokens}`);
        logger.addConsole(`USD: input=$${cost.inputUSD.toFixed(4)}, output=$${cost.outputUSD.toFixed(4)}, total=$${cost.totalUSD.toFixed(4)} ($${cost.usdPer1000Items.toFixed(3)} / 1K件)`);
        logger.addConsole(`MAX_TOKENS で切り詰め: ${usage.maxTokensTruncated} 件 (フォールバック総数 ${usage.parseErrorFallback} 件中)`);

        // 評価
        const threshold = args.threshold || 0.5;
        const evaluation = calculateMetrics(allDecisions, references, threshold);
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
