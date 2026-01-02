import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
ASREVIEW_ROOT = ROOT / "vendor" / "asreview"
sys.path.insert(0, str(ASREVIEW_ROOT))

from asreview.learner import ActiveLearningCycle  # noqa: E402
from asreview.models.balancers import Balanced  # noqa: E402
from asreview.models.classifiers import NaiveBayes  # noqa: E402
from asreview.models.feature_extractors import Tfidf  # noqa: E402
from asreview.models.queriers import Max  # noqa: E402


def resolve_dataset_path(name: str) -> Path:
    dataset_map = {
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
    raw = dataset_path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
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
    return df


def build_debug_state(cycle) -> dict:
    vectorizer = cycle.feature_extractor.named_steps["tfidf"]
    vocab_items = sorted(vectorizer.vocabulary_.items(), key=lambda item: item[1])
    vocabulary = [token for token, _ in vocab_items]
    idf = vectorizer.idf_.tolist()

    classifier = cycle.classifier
    class_log_prior = classifier.class_log_prior_.tolist()
    feature_log_prob = classifier.feature_log_prob_.tolist()

    return {
        "vocabulary": vocabulary,
        "idf": idf,
        "class_log_prior": class_log_prior,
        "feature_log_prob": feature_log_prob,
    }


def build_cycle_elas_u3() -> ActiveLearningCycle:
    return ActiveLearningCycle(
        querier=Max(),
        classifier=NaiveBayes(alpha=3.822),
        balancer=Balanced(ratio=1.2),
        feature_extractor=Tfidf(stop_words="english"),
    )


def run(dataset: str) -> Path:
    dataset_path = resolve_dataset_path(dataset)
    df = load_dataset(dataset_path)
    labels = df["label_included"].fillna(-1).astype(int).to_numpy()
    labeled_mask = (labels == 0) | (labels == 1)

    cycle = build_cycle_elas_u3()

    features = cycle.transform(df[["title", "abstract"]])
    cycle.fit(features[labeled_mask], labels[labeled_mask])

    proba = cycle.classifier.predict_proba(features)[:, 1]
    indices = np.arange(len(proba))
    ranking = np.lexsort((indices, -proba))

    outputs_dir = ROOT / "experiments" / "asreview" / "outputs"
    outputs_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.utcnow().isoformat().replace(":", "-").replace(".", "-")
    out_path = outputs_dir / f"asreview_py_{dataset}_{timestamp}.json"

    payload = {
        "dataset": dataset,
        "datasetPath": str(dataset_path),
        "count": int(len(df)),
        "proba_included": proba.tolist(),
        "ranking": ranking.tolist(),
        "debug_state": build_debug_state(cycle),
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    return out_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="cq3", choices=["cq3", "depression"])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    out_path = run(args.dataset)
    print(f"Wrote: {out_path}")


if __name__ == "__main__":
    main()
