/**
 * Phase 3 性能ベンチマーク
 * 
 * TS 実装の fit/rank 処理時間を計測し、Phase 3 の性能目標の妥当性を検証する。
 * 
 * 使用法:
 *   npx ts-node --project experiments/asreview/tsconfig.json experiments/asreview/benchmark.ts
 *   npx ts-node --project experiments/asreview/tsconfig.json experiments/asreview/benchmark.ts --dataset cq1
 */

import fs from "fs";
import path from "path";
import { computeBalancedSampleWeight } from "./src/balanced";
import { loadDataset, resolveDatasetPath } from "./src/dataset";
import { fitMultinomialNb, predictProba } from "./src/nb";
import { queryMax } from "./src/querier";
import { createDefaultTfidfParams } from "./src/text";
import { fitTfidf } from "./src/tfidf";
import { Label } from "./src/types";

interface BenchmarkResult {
    dataset: string;
    recordCount: number;
    labeledCount: number;
    includeCount: number;
    excludeCount: number;
    timings: {
        tfidfFit: number;
        balancedWeight: number;
        nbFit: number;
        nbPredict: number;
        queryMax: number;
        total: number;
    };
}

function benchmark(
    records: Array<{ title?: string; abstract?: string }>,
    labels: Label[]
): BenchmarkResult["timings"] {
    const tfidfParams = createDefaultTfidfParams();

    // TF-IDF fit
    const t0 = performance.now();
    const { state: tfidfState, X } = fitTfidf(records, tfidfParams);
    const t1 = performance.now();

    // Extract labeled data
    const labeledIndices: number[] = [];
    const labeledLabels: number[] = [];
    for (let i = 0; i < labels.length; i += 1) {
        if (labels[i] === 1 || labels[i] === 0) {
            labeledIndices.push(i);
            labeledLabels.push(labels[i]);
        }
    }
    const XTrain = labeledIndices.map((idx) => X[idx]);
    const yTrain = labeledLabels;

    // Balanced sample weight
    const t2 = performance.now();
    const weights = computeBalancedSampleWeight(yTrain, 1.2);
    const t3 = performance.now();

    // NB fit
    const nbState = fitMultinomialNb(XTrain, yTrain, weights, 3.822);
    const t4 = performance.now();

    // NB predict
    const probaIncluded = predictProba(X, nbState);
    const t5 = performance.now();

    // Query max
    const _ranking = queryMax(probaIncluded);
    const t6 = performance.now();

    return {
        tfidfFit: t1 - t0,
        balancedWeight: t3 - t2,
        nbFit: t4 - t3,
        nbPredict: t5 - t4,
        queryMax: t6 - t5,
        total: t6 - t0,
    };
}

function runBenchmark(datasetName: string): BenchmarkResult {
    const datasetPath = resolveDatasetPath(datasetName);
    const { records, labels } = loadDataset(datasetPath);

    const includeCount = labels.filter((l) => l === 1).length;
    const excludeCount = labels.filter((l) => l === 0).length;
    const labeledCount = includeCount + excludeCount;

    const timings = benchmark(records, labels);

    return {
        dataset: datasetName,
        recordCount: records.length,
        labeledCount,
        includeCount,
        excludeCount,
        timings,
    };
}

function formatMs(ms: number): string {
    return ms.toFixed(1) + " ms";
}

function printResult(result: BenchmarkResult): void {
    console.log(`\n=== ${result.dataset} ===`);
    console.log(`Records: ${result.recordCount}`);
    console.log(`Labeled: ${result.labeledCount} (include=${result.includeCount}, exclude=${result.excludeCount})`);
    console.log(`Timings:`);
    console.log(`  TF-IDF fit:      ${formatMs(result.timings.tfidfFit)}`);
    console.log(`  Balanced weight: ${formatMs(result.timings.balancedWeight)}`);
    console.log(`  NB fit:          ${formatMs(result.timings.nbFit)}`);
    console.log(`  NB predict:      ${formatMs(result.timings.nbPredict)}`);
    console.log(`  Query max:       ${formatMs(result.timings.queryMax)}`);
    console.log(`  ----------------------`);
    console.log(`  Total:           ${formatMs(result.timings.total)}`);
}

function main(): void {
    const datasetArg = process.argv.indexOf("--dataset");
    const datasets =
        datasetArg >= 0
            ? [process.argv[datasetArg + 1]]
            : ["cq1", "cq2", "cq3", "cq4", "cq5", "depression", "wilson"];

    console.log("Phase 3 Performance Benchmark");
    console.log("==============================");

    const results: BenchmarkResult[] = [];

    for (const dataset of datasets) {
        try {
            const result = runBenchmark(dataset);
            results.push(result);
            printResult(result);
        } catch (e) {
            console.log(`\n=== ${dataset} ===`);
            console.log(`  Error: ${(e as Error).message}`);
        }
    }

    // Save results
    const outputsDir = path.resolve(process.cwd(), "experiments/asreview/outputs");
    if (!fs.existsSync(outputsDir)) {
        fs.mkdirSync(outputsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outputsDir, `benchmark_${timestamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\nResults saved to: ${outPath}`);

    // Summary table
    console.log("\n=== Summary ===");
    console.log("Dataset         | Records | Total (ms)");
    console.log("----------------|---------|----------");
    for (const r of results) {
        const name = r.dataset.padEnd(15);
        const count = String(r.recordCount).padStart(7);
        const total = r.timings.total.toFixed(1).padStart(10);
        console.log(`${name} | ${count} | ${total}`);
    }
}

main();
