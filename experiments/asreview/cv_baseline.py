import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
ASREVIEW_ROOT = ROOT / "vendor" / "asreview"

import sys

sys.path.insert(0, str(ASREVIEW_ROOT))

from asreview.models.balancers import Balanced  # noqa: E402
from asreview.models.classifiers import NaiveBayes  # noqa: E402
from asreview.models.feature_extractors import Tfidf  # noqa: E402
from asreview.models.queriers import Max  # noqa: E402


def resolve_dataset_path(name: str) -> Path:
    dataset_map = {
        "cq1": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq1_labeled.json",
        "cq3": ROOT / "scripts" / "asreview-baseline" / "datasets" / "cq3_labeled.json",
        "depression": ROOT
        / "scripts"
        / "asreview-baseline"
        / "datasets"
        / "depression_slim_labeled.json",
    }
    if name not in dataset_map:
        raise ValueError(f"Unknown dataset: {name}")
    return dataset_map[name]


def load_dataset(dataset_path: Path) -> pd.DataFrame:
    parsed = json.loads(dataset_path.read_text(encoding="utf-8"))
    if isinstance(parsed, list):
        records = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
        records = parsed["records"]
    else:
        raise ValueError("Invalid dataset format: expected array or object with records")

    df = pd.DataFrame(records)
    if "title" not in df.columns:
        df["title"] = ""
    if "abstract" not in df.columns:
        df["abstract"] = ""
    if "label_included" not in df.columns and "label" in df.columns:
        df["label_included"] = df["label"]
    if "label_included" not in df.columns:
        df["label_included"] = -1
    if "id" not in df.columns:
        df["id"] = df.index.astype(str)
    return df


def load_folds(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_cycle() -> tuple[Tfidf, NaiveBayes, Balanced, Max]:
    return (
        Tfidf(stop_words="english"),
        NaiveBayes(alpha=3.822),
        Balanced(ratio=1.2),
        Max(),
    )


def run_fold(
    df: pd.DataFrame, labels: np.ndarray, test_indices: list[int], top_n: int
) -> dict:
    test_set = set(test_indices)
    train_indices = [idx for idx, label in enumerate(labels) if label in (0, 1) and idx not in test_set]

    train_df = df.iloc[train_indices]
    test_df = df.iloc[test_indices]

    y_train = labels[train_indices]

    feature_extractor, classifier, balancer, querier = build_cycle()
    X_train = feature_extractor.fit_transform(train_df[["title", "abstract"]])
    sample_weight = balancer.compute_sample_weight(y_train)
    classifier.fit(X_train, y_train, sample_weight=sample_weight)

    X_test = feature_extractor.transform(test_df[["title", "abstract"]])
    proba = classifier.predict_proba(X_test)[:, 1]

    indices = np.arange(len(proba))
    ranking = np.lexsort((indices, -proba))
    top_local = ranking[:top_n]

    top_indices = [test_indices[idx] for idx in top_local]
    top_ids = [str(df.iloc[idx]["id"]) for idx in top_indices]

    return {
        "test_size": len(test_indices),
        "top_indices": top_indices,
        "top_ids": top_ids,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="cq1")
    parser.add_argument("--folds", default=None)
    parser.add_argument("--top", type=int, default=100)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_path = resolve_dataset_path(args.dataset)
    df = load_dataset(dataset_path)
    labels = df["label_included"].fillna(-1).astype(int).to_numpy()

    folds_path = (
        Path(args.folds)
        if args.folds
        else ROOT / "experiments" / "asreview" / "splits" / f"{args.dataset}_k10_seed42.json"
    )
    folds_payload = load_folds(folds_path)

    folds = []
    for index, fold in enumerate(folds_payload["folds"]):
        result = run_fold(df, labels, fold["test_indices"], args.top)
        folds.append(
            {
                "fold": index,
                "test_size": result["test_size"],
                "top_indices": result["top_indices"],
                "top_ids": result["top_ids"],
            }
        )

    outputs_dir = ROOT / "experiments" / "asreview" / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().isoformat().replace(":", "-").replace(".", "-")
    out_path = outputs_dir / f"asreview_py_cv_{args.dataset}_{timestamp}.json"

    payload = {
        "dataset": args.dataset,
        "datasetPath": str(dataset_path),
        "foldsPath": str(folds_path),
        "top": args.top,
        "folds": folds,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Wrote: {out_path}")


if __name__ == "__main__":
    main()
