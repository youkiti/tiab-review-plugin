/**
 * パラメータ実験スクリプト
 * 
 * NB alpha と Balanced ratio を段階的に変化させ、
 * 適切なランキング性能指標で評価する
 * 
 * 評価指標：
 * - WSS@95: 95%の relevant を発見するまでの労力削減率
 * - Average Precision (AP): ランキング全体の品質
 * - AUC-ROC: 分類性能（閾値非依存）
 * - Recall@10/50/100: 上位k件での再現率
 * - Top100 ID Match vs Python: Python実装とのランキング一致率
 */

import fs from "fs";
import path from "path";
import { computeBalancedSampleWeight } from "./src/balanced";
import { loadDataset, resolveDatasetPath } from "./src/dataset";
import { fitMultinomialNb, predictProba } from "./src/nb";
import { queryMax } from "./src/querier";
import { createDefaultTfidfParams } from "./src/text";
import { fitTfidf, transformTfidf } from "./src/tfidf";
import { Label } from "./src/types";

interface ExperimentConfig {
  alpha: number;
  ratio: number;
}

interface Metrics {
  wss_95: number;
  wss_100: number;
  ap: number;          // Average Precision
  auc_roc: number;
  recall_at_10: number;
  recall_at_50: number;
  recall_at_100: number;
  top100_match_vs_python: number;  // Python実装とのID一致率
}

interface FoldResult {
  fold: number;
  test_size: number;
  top_indices: number[];  // グローバルインデックス（Python出力形式と比較用）
  top_ids: string[];      // グローバルID（Python出力形式と比較用）
  metrics: Metrics;
}

interface ExperimentResult {
  config: ExperimentConfig;
  dataset: string;
  folds: FoldResult[];
  summary: {
    mean_wss_95: number;
    mean_wss_100: number;
    mean_ap: number;
    mean_auc_roc: number;
    mean_recall_at_10: number;
    mean_recall_at_50: number;
    mean_recall_at_100: number;
    mean_top100_match: number;
    std_wss_95: number;
    std_wss_100: number;
    std_ap: number;
    std_auc_roc: number;
    std_recall_at_10: number;
    std_recall_at_50: number;
    std_recall_at_100: number;
    std_top100_match: number;
  };
}

interface FoldConfig {
  test_indices: number[];
}

interface FoldsPayload {
  dataset: string;
  datasetPath: string;
  k: number;
  seed: number;
  folds: FoldConfig[];
}

function parseArgs(argv: string[]): { 
  dataset: string; 
  foldsPath: string; 
  outputDir: string;
  pythonResultPath?: string;
} {
  const datasetIndex = argv.indexOf("--dataset");
  const foldsIndex = argv.indexOf("--folds");
  const outputIndex = argv.indexOf("--output");
  const pythonIndex = argv.indexOf("--python-result");

  const dataset = datasetIndex >= 0 ? argv[datasetIndex + 1] : "cq1";
  if (!dataset) {
    throw new Error("--dataset の値が指定されていません");
  }

  const foldsPath =
    foldsIndex >= 0
      ? argv[foldsIndex + 1]
      : `experiments/asreview/splits/${dataset}_k10_seed42.json`;
  
  const outputDir = outputIndex >= 0 
    ? argv[outputIndex + 1]
    : "experiments/asreview/outputs";

  const pythonResultPath = pythonIndex >= 0 ? argv[pythonIndex + 1] : undefined;

  return { dataset, foldsPath, outputDir, pythonResultPath };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadFolds(foldsPath: string): FoldsPayload {
  return JSON.parse(fs.readFileSync(foldsPath, "utf-8")) as FoldsPayload;
}

interface PythonCVResult {
  dataset: string;
  datasetPath: string;
  foldsPath: string;
  top: number;
  folds: Array<{
    fold: number;
    test_size: number;
    top_indices: number[];
    top_ids: string[];
  }>;
}

function loadPythonResult(pythonResultPath: string): PythonCVResult {
  return JSON.parse(fs.readFileSync(pythonResultPath, "utf-8")) as PythonCVResult;
}

function findLatestPythonResult(outputDir: string, dataset: string): string | null {
  const pattern = `asreview_py_cv_${dataset}`;
  const files = fs.readdirSync(outputDir)
    .filter(f => f.startsWith(pattern) && f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(outputDir, f),
      mtime: fs.statSync(path.join(outputDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  
  return files.length > 0 ? files[0].path : null;
}

function getRecordId(record: { id?: string | number }, fallback: number): string {
  if (record.id === undefined || record.id === null) {
    return String(fallback);
  }
  return String(record.id);
}

/**
 * WSS@recall (Work Saved over Sampling) を計算
 */
function calculateWSS(
  ranking: number[],
  labels: Label[],
  testIndices: number[],
  recallTarget: number
): number {
  const relevantInTest = testIndices.filter(idx => labels[idx] === 1);
  const totalRelevant = relevantInTest.length;
  
  if (totalRelevant === 0) {
    return 0;
  }

  const target = Math.ceil(totalRelevant * recallTarget);
  let foundRelevant = 0;
  let screened = 0;

  for (const localIdx of ranking) {
    const globalIdx = testIndices[localIdx];
    screened += 1;
    if (labels[globalIdx] === 1) {
      foundRelevant += 1;
      if (foundRelevant >= target) {
        break;
      }
    }
  }

  const wss = (testIndices.length - screened) / testIndices.length - (1 - recallTarget);
  return wss;
}

/**
 * Average Precision を計算
 */
function calculateAP(
  ranking: number[],
  labels: Label[],
  testIndices: number[]
): number {
  const relevantInTest = testIndices.filter(idx => labels[idx] === 1);
  const totalRelevant = relevantInTest.length;
  
  if (totalRelevant === 0) {
    return 0;
  }

  let relevantFound = 0;
  let sumPrecision = 0;

  for (let rank = 0; rank < ranking.length; rank++) {
    const globalIdx = testIndices[ranking[rank]];
    if (labels[globalIdx] === 1) {
      relevantFound += 1;
      const precision = relevantFound / (rank + 1);
      sumPrecision += precision;
    }
  }

  return sumPrecision / totalRelevant;
}

/**
 * AUC-ROC を計算（台形法）
 */
function calculateAUC(proba: Float64Array, labels: Label[], testIndices: number[]): number {
  // (確率, ラベル) のペアを作成
  const pairs: Array<{ prob: number; label: number }> = [];
  for (let i = 0; i < testIndices.length; i++) {
    const idx = testIndices[i];
    pairs.push({ prob: proba[i], label: labels[idx] });
  }

  // 確率の降順でソート
  pairs.sort((a, b) => b.prob - a.prob);

  const positives = pairs.filter(p => p.label === 1).length;
  const negatives = pairs.length - positives;

  if (positives === 0 || negatives === 0) {
    return 0.5; // 片方のクラスしかない場合
  }

  let tpr = 0; // True Positive Rate
  let fpr = 0; // False Positive Rate
  let auc = 0;

  for (const pair of pairs) {
    if (pair.label === 1) {
      tpr += 1 / positives;
    } else {
      // 台形の面積を加算
      auc += tpr / negatives;
      fpr += 1 / negatives;
    }
  }

  return auc;
}

/**
 * Recall@k を計算
 */
function calculateRecallAtK(
  ranking: number[],
  labels: Label[],
  testIndices: number[],
  k: number
): number {
  const relevantInTest = testIndices.filter(idx => labels[idx] === 1);
  const totalRelevant = relevantInTest.length;
  
  if (totalRelevant === 0) {
    return 0;
  }

  const topK = ranking.slice(0, Math.min(k, ranking.length));
  const foundInTopK = topK.filter(localIdx => {
    const globalIdx = testIndices[localIdx];
    return labels[globalIdx] === 1;
  }).length;

  return foundInTopK / totalRelevant;
}

/**
 * Top 100 ID一致率を計算
 */
function calculateTop100Match(idsA: string[], idsB: string[]): number {
  const setA = new Set(idsA.slice(0, 100));
  const setB = new Set(idsB.slice(0, 100));
  const intersection = new Set([...setA].filter(id => setB.has(id)));
  const denom = Math.min(setA.size, setB.size);
  return denom > 0 ? intersection.size / denom : 0;
}

function runFold(
  records: Array<{ title?: string; abstract?: string; id?: string | number }>,
  labels: Label[],
  testIndices: number[],
  config: ExperimentConfig,
  pythonTop100Ids?: string[]
): FoldResult {
  const testSet = new Set(testIndices);
  const trainIndices: number[] = [];
  const trainLabels: number[] = [];
  
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label !== 0 && label !== 1) {
      continue;
    }
    if (!testSet.has(i)) {
      trainIndices.push(i);
      trainLabels.push(label);
    }
  }

  const trainRecords = trainIndices.map((idx) => records[idx]);
  const params = createDefaultTfidfParams();
  const { state, X } = fitTfidf(trainRecords, params);
  
  // パラメータを適用
  const weights = computeBalancedSampleWeight(trainLabels, config.ratio);
  const nbState = fitMultinomialNb(X, trainLabels, weights, config.alpha);

  const testRecords = testIndices.map((idx) => records[idx]);
  const XTest = transformTfidf(testRecords, state);
  const proba = predictProba(XTest, nbState);
  const ranking = queryMax(proba);

  // Top 100を取得（Python出力形式に合わせる）
  const top100LocalIndices = ranking.slice(0, 100); // テストセット内での相対インデックス
  const top100GlobalIndices = top100LocalIndices.map(localIdx => testIndices[localIdx]); // グローバルインデックス
  const top100Ids = top100GlobalIndices.map(globalIdx => getRecordId(records[globalIdx], globalIdx)); // グローバルID

  // メトリクス計算
  const wss_95 = calculateWSS(ranking, labels, testIndices, 0.95);
  const wss_100 = calculateWSS(ranking, labels, testIndices, 1.0);
  const ap = calculateAP(ranking, labels, testIndices);
  const auc_roc = calculateAUC(proba, labels, testIndices);
  const recall_at_10 = calculateRecallAtK(ranking, labels, testIndices, 10);
  const recall_at_50 = calculateRecallAtK(ranking, labels, testIndices, 50);
  const recall_at_100 = calculateRecallAtK(ranking, labels, testIndices, 100);
  
  const top100_match_vs_python = pythonTop100Ids 
    ? calculateTop100Match(top100Ids, pythonTop100Ids)
    : 0.0; // Python結果がない場合は0

  return {
    fold: -1, // 後で設定
    test_size: testIndices.length,
    top_indices: top100GlobalIndices, // Python出力形式と比較用
    top_ids: top100Ids,                // Python出力形式と比較用
    metrics: {
      wss_95,
      wss_100,
      ap,
      auc_roc,
      recall_at_10,
      recall_at_50,
      recall_at_100,
      top100_match_vs_python,
    },
  };
}

function calculateSummary(folds: FoldResult[]): ExperimentResult["summary"] {
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr: number[]) => {
    const m = mean(arr);
    const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  };

  const extract = (key: keyof Metrics) => folds.map(f => f.metrics[key]);

  return {
    mean_wss_95: mean(extract("wss_95")),
    mean_wss_100: mean(extract("wss_100")),
    mean_ap: mean(extract("ap")),
    mean_auc_roc: mean(extract("auc_roc")),
    mean_recall_at_10: mean(extract("recall_at_10")),
    mean_recall_at_50: mean(extract("recall_at_50")),
    mean_recall_at_100: mean(extract("recall_at_100")),
    mean_top100_match: mean(extract("top100_match_vs_python")),
    std_wss_95: std(extract("wss_95")),
    std_wss_100: std(extract("wss_100")),
    std_ap: std(extract("ap")),
    std_auc_roc: std(extract("auc_roc")),
    std_recall_at_10: std(extract("recall_at_10")),
    std_recall_at_50: std(extract("recall_at_50")),
    std_recall_at_100: std(extract("recall_at_100")),
    std_top100_match: std(extract("top100_match_vs_python")),
  };
}

function runExperiment(
  records: Array<{ title?: string; abstract?: string; id?: string | number }>,
  labels: Label[],
  foldsPayload: FoldsPayload,
  config: ExperimentConfig,
  dataset: string,
  pythonFoldResults?: Map<number, string[]>
): ExperimentResult {
  const folds = foldsPayload.folds.map((fold, index) => {
    const pythonTop100 = pythonFoldResults?.get(index);
    const result = runFold(records, labels, fold.test_indices, config, pythonTop100);
    result.fold = index;
    return result;
  });

  const summary = calculateSummary(folds);

  return {
    config,
    dataset,
    folds,
    summary,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolveDatasetPath(args.dataset);
  const { records, labels } = loadDataset(datasetPath);
  const resolvedFoldsPath = path.resolve(process.cwd(), args.foldsPath);
  const foldsPayload = loadFolds(resolvedFoldsPath);

  console.log(`データセット: ${args.dataset}`);
  console.log(`レコード数: ${records.length}`);
  console.log(`Folds: ${foldsPayload.folds.length}`);
  console.log("");

  // Python実装の結果をロード
  let pythonResultPath: string | null = args.pythonResultPath ?? null;
  if (!pythonResultPath) {
    pythonResultPath = findLatestPythonResult(args.outputDir, args.dataset);
    if (pythonResultPath) {
      console.log(`Python結果を自動検出: ${pythonResultPath}`);
    } else {
      console.log(`⚠ Python結果が見つかりません。Top100 Match vs Python は計算されません。`);
    }
  }

  const pythonTop100Map = new Map<number, string[]>();
  if (pythonResultPath) {
    const pythonResult = loadPythonResult(pythonResultPath);
    pythonResult.folds.forEach(fold => {
      pythonTop100Map.set(fold.fold, fold.top_ids);
    });
    console.log(`✓ Python結果をロード完了 (${pythonResult.folds.length} folds)\n`);
  }

  // パラメータグリッド定義
  const alphaValues = [1.0, 2.0, 3.822, 5.0, 10.0];  // 3.822がデフォルト
  const ratioValues = [1.0, 1.2, 1.5, 2.0];          // 1.2がデフォルト
  const defaultConfig: ExperimentConfig = { alpha: 3.822, ratio: 1.2 };

  console.log("Phase 1: デフォルト設定でベースライン作成");
  const defaultResult = runExperiment(
    records,
    labels,
    foldsPayload,
    defaultConfig,
    args.dataset,
    pythonTop100Map
  );

  console.log("✓ デフォルト設定完了\n");

  // デフォルト設定の結果をPython出力形式で保存（Python実装との比較用）
  ensureDir(args.outputDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pythonFormatOutPath = path.join(
    args.outputDir,
    `asreview_ts_cv_${args.dataset}_${timestamp}.json`
  );

  const pythonFormatOutput = {
    dataset: args.dataset,
    datasetPath,
    foldsPath: resolvedFoldsPath,
    top: 100,
    folds: defaultResult.folds.map(fold => ({
      fold: fold.fold,
      test_size: fold.test_size,
      top_indices: fold.top_indices,
      top_ids: fold.top_ids,
    })),
  };

  fs.writeFileSync(pythonFormatOutPath, JSON.stringify(pythonFormatOutput, null, 2), "utf-8");
  console.log(`Python比較用出力を保存: ${pythonFormatOutPath}\n`);

  const experiments: ExperimentResult[] = [defaultResult];
  const totalExperiments = alphaValues.length * ratioValues.length;
  let completed = 1; // デフォルト設定分

  console.log(`Phase 2: パラメータスイープ実験（${totalExperiments}通り）\n`);

  for (const alpha of alphaValues) {
    for (const ratio of ratioValues) {
      // デフォルト設定はスキップ（すでに実行済み）
      if (alpha === defaultConfig.alpha && ratio === defaultConfig.ratio) {
        continue;
      }

      const config: ExperimentConfig = { alpha, ratio };
      
      console.log(`[${completed + 1}/${totalExperiments}] alpha=${alpha}, ratio=${ratio}`);
      
      const result = runExperiment(
        records,
        labels,
        foldsPayload,
        config,
        args.dataset,
        pythonTop100Map
      );

      experiments.push(result);
      completed += 1;

      console.log(`  WSS@95: ${result.summary.mean_wss_95.toFixed(4)} ± ${result.summary.std_wss_95.toFixed(4)}`);
      console.log(`  AP: ${result.summary.mean_ap.toFixed(4)} ± ${result.summary.std_ap.toFixed(4)}`);
      console.log(`  AUC-ROC: ${result.summary.mean_auc_roc.toFixed(4)} ± ${result.summary.std_auc_roc.toFixed(4)}`);
      console.log(`  Recall@10: ${result.summary.mean_recall_at_10.toFixed(4)} ± ${result.summary.std_recall_at_10.toFixed(4)}`);
      console.log(`  Recall@50: ${result.summary.mean_recall_at_50.toFixed(4)} ± ${result.summary.std_recall_at_50.toFixed(4)}`);
      console.log(`  Recall@100: ${result.summary.mean_recall_at_100.toFixed(4)} ± ${result.summary.std_recall_at_100.toFixed(4)}`);
      console.log(`  Top100 Match: ${result.summary.mean_top100_match.toFixed(4)} ± ${result.summary.std_top100_match.toFixed(4)}`);
      console.log("");
    }
  }

  // パラメータスイープ結果を保存
  const sweepOutPath = path.join(
    args.outputDir,
    `sweep_${args.dataset}_${timestamp}.json`
  );

  const sweepOutput = {
    dataset: args.dataset,
    datasetPath,
    foldsPath: resolvedFoldsPath,
    alphaValues,
    ratioValues,
    defaultConfig,
    experiments,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(sweepOutPath, JSON.stringify(sweepOutput, null, 2), "utf-8");
  console.log(`\nパラメータスイープ結果を保存: ${sweepOutPath}`);

  // ベスト設定を表示（WSS@95基準）
  const sorted = [...experiments].sort(
    (a, b) => b.summary.mean_wss_95 - a.summary.mean_wss_95
  );

  console.log("\n=== ベスト設定 (WSS@95 上位5件) ===");
  sorted.slice(0, 5).forEach((exp, idx) => {
    const isDefault = exp.config.alpha === defaultConfig.alpha && exp.config.ratio === defaultConfig.ratio;
    const marker = isDefault ? " [DEFAULT]" : "";
    console.log(
      `${idx + 1}. alpha=${exp.config.alpha}, ratio=${exp.config.ratio}${marker}\n` +
      `   WSS@95=${exp.summary.mean_wss_95.toFixed(4)}, ` +
      `AP=${exp.summary.mean_ap.toFixed(4)}, ` +
      `AUC=${exp.summary.mean_auc_roc.toFixed(4)}, ` +
      `Top100Match=${exp.summary.mean_top100_match.toFixed(4)}`
    );
  });
}

main();
