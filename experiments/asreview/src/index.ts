import fs from "fs";
import path from "path";
import { fitAndRank } from "./cycle";
import { loadDataset, resolveDatasetPath } from "./dataset";

function parseArgs(argv: string[]): { dataset: string } {
  const datasetIndex = argv.indexOf("--dataset");
  const dataset = datasetIndex >= 0 ? argv[datasetIndex + 1] : "cq3";
  if (!dataset) {
    throw new Error("--dataset の値が指定されていません");
  }
  return { dataset };
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = resolveDatasetPath(args.dataset);
  const { records, labels } = loadDataset(datasetPath);

  const result = fitAndRank(records, labels);

  const outputsDir = path.resolve(process.cwd(), "experiments/asreview/outputs");
  ensureDir(outputsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outputsDir, `asreview_ts_${args.dataset}_${timestamp}.json`);

  const payload = {
    dataset: args.dataset,
    datasetPath,
    count: records.length,
    proba_included: Array.from(result.probaIncluded),
    ranking: result.ranking,
    debug_state: result.debugState,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote: ${outPath}`);
}

main();
