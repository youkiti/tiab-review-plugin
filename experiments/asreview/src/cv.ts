import fs from "fs";
import path from "path";
import { computeBalancedSampleWeight } from "./balanced";
import { loadDataset, resolveDatasetPath } from "./dataset";
import { fitMultinomialNb, predictProba } from "./nb";
import { queryMax } from "./querier";
import { createDefaultTfidfParams } from "./text";
import { fitTfidf, transformTfidf } from "./tfidf";
import { Label } from "./types";

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

function parseArgs(argv: string[]): { dataset: string; foldsPath: string; top: number } {
  const datasetIndex = argv.indexOf("--dataset");
  const foldsIndex = argv.indexOf("--folds");
  const topIndex = argv.indexOf("--top");

  const dataset = datasetIndex >= 0 ? argv[datasetIndex + 1] : "cq1";
  if (!dataset) {
    throw new Error("--dataset の値が指定されていません");
  }

  const foldsPath =
    foldsIndex >= 0
      ? argv[foldsIndex + 1]
      : `experiments/asreview/splits/${dataset}_k10_seed42.json`;

  const top = topIndex >= 0 ? Number(argv[topIndex + 1]) : 100;

  return { dataset, foldsPath, top };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadFolds(foldsPath: string): FoldsPayload {
  return JSON.parse(fs.readFileSync(foldsPath, "utf-8")) as FoldsPayload;
}

function getRecordId(record: { id?: string | number }, fallback: number): string {
  if (record.id === undefined || record.id === null) {
    return String(fallback);
  }
  return String(record.id);
}

function runFold(
  records: Array<{ title?: string; abstract?: string; id?: string | number }>,
  labels: Label[],
  testIndices: number[],
  topN: number
): { top_indices: number[]; top_ids: string[] } {
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
  const weights = computeBalancedSampleWeight(trainLabels, 1.2);
  const nbState = fitMultinomialNb(X, trainLabels, weights, 3.822);

  const testRecords = testIndices.map((idx) => records[idx]);
  const XTest = transformTfidf(testRecords, state);
  const proba = predictProba(XTest, nbState);
  const rankingLocal = queryMax(proba);
  const topLocal = rankingLocal.slice(0, topN);

  const topIndices = topLocal.map((idx) => testIndices[idx]);
  const topIds = topIndices.map((idx) => getRecordId(records[idx], idx));

  return { top_indices: topIndices, top_ids: topIds };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolveDatasetPath(args.dataset);
  const { records, labels } = loadDataset(datasetPath);
  const resolvedFoldsPath = path.resolve(process.cwd(), args.foldsPath);
  const foldsPayload = loadFolds(resolvedFoldsPath);

  const folds = foldsPayload.folds.map((fold, index) => {
    const result = runFold(records, labels, fold.test_indices, args.top);
    return {
      fold: index,
      test_size: fold.test_indices.length,
      top_indices: result.top_indices,
      top_ids: result.top_ids,
    };
  });

  const outputsDir = path.resolve(process.cwd(), "experiments/asreview/outputs");
  ensureDir(outputsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outputsDir, `asreview_ts_cv_${args.dataset}_${timestamp}.json`);

  const payload = {
    dataset: args.dataset,
    datasetPath,
    foldsPath: resolvedFoldsPath,
    top: args.top,
    folds,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote: ${outPath}`);
}

main();
