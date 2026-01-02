import fs from "fs";
import path from "path";
import { Label, ReferenceRecord } from "./types";

export function loadDataset(datasetPath: string): { records: ReferenceRecord[]; labels: Label[] } {
  const raw = fs.readFileSync(datasetPath, "utf-8");
  const parsed = JSON.parse(raw);
  const records: ReferenceRecord[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.records)
      ? parsed.records
      : [];

  if (records.length === 0) {
    throw new Error("Invalid dataset format: expected array or object with records");
  }

  const labels: Label[] = records.map((rec) => {
    if (rec.label_included === 1) {
      return 1;
    }
    if (rec.label_included === 0) {
      return 0;
    }
    return -1;
  });

  return { records, labels };
}

export function resolveDatasetPath(name: string): string {
  const datasetMap: Record<string, string> = {
    cq3: "scripts/asreview-baseline/datasets/cq3_labeled.json",
    depression: "scripts/asreview-baseline/datasets/depression_slim_labeled.json",
  };

  const datasetPath = datasetMap[name];
  if (!datasetPath) {
    throw new Error(`Unknown dataset: ${name}`);
  }

  return path.resolve(process.cwd(), datasetPath);
}
