import argparse
import json
import random
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def resolve_dataset_path(name: str) -> Path:
    dataset_map = {
        "cq1": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq1_labeled.json",
        "cq2": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq2_labeled.json",
        "cq3": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq3_labeled.json",
        "cq4": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq4_labeled.json",
        "cq5": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq5_labeled.json",
        "depression": ROOT
        / "scripts"
        / "asreview-baseline"
        / "datasets"
        / "depression_slim_labeled.json",
    }
    if name not in dataset_map:
        raise ValueError(f"Unknown dataset: {name}")
    return dataset_map[name]


def load_records(dataset_path: Path) -> list[dict]:
    parsed = json.loads(dataset_path.read_text(encoding="utf-8"))
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
        return parsed["records"]
    raise ValueError("Invalid dataset format: expected array or object with records")


def load_labels(records: list[dict]) -> list[int]:
    labels = []
    for record in records:
        raw = record.get("label_included", record.get("label"))
        if raw == 1:
            labels.append(1)
        elif raw == 0:
            labels.append(0)
        else:
            labels.append(-1)
    return labels


def stratified_folds(labels: list[int], k: int, seed: int) -> list[list[int]]:
    positives = [idx for idx, label in enumerate(labels) if label == 1]
    negatives = [idx for idx, label in enumerate(labels) if label == 0]
    rng = random.Random(seed)
    rng.shuffle(positives)
    rng.shuffle(negatives)

    folds = [[] for _ in range(k)]
    for i, idx in enumerate(positives):
        folds[i % k].append(idx)
    for i, idx in enumerate(negatives):
        folds[i % k].append(idx)

    for fold in folds:
        fold.sort()

    return folds


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="cq1")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_path = resolve_dataset_path(args.dataset)
    records = load_records(dataset_path)
    labels = load_labels(records)
    folds = stratified_folds(labels, args.k, args.seed)

    output_dir = ROOT / "experiments" / "asreview" / "splits"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{args.dataset}_k{args.k}_seed{args.seed}.json"

    payload = {
        "dataset": args.dataset,
        "datasetPath": str(dataset_path),
        "seed": args.seed,
        "k": args.k,
        "folds": [{"test_indices": fold} for fold in folds],
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Wrote: {output_path}")


if __name__ == "__main__":
    main()
