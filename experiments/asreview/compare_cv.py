import argparse
import json
from pathlib import Path
from statistics import mean


ROOT = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = ROOT / "experiments" / "asreview" / "outputs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="cq1")
    parser.add_argument("--ts", help="TS側のCV出力JSON")
    parser.add_argument("--py", help="Python側のCV出力JSON")
    return parser.parse_args()


def find_latest(prefix: str) -> Path:
    candidates = sorted(OUTPUTS_DIR.glob(f"{prefix}_*.json"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise FileNotFoundError(f"{prefix}_*.json が見つかりません")
    return candidates[-1]


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def compare_fold(ts_ids: list[str], py_ids: list[str]) -> tuple[int, int, float]:
    ts_set = set(ts_ids)
    py_set = set(py_ids)
    overlap = len(ts_set & py_set)
    denom = min(len(ts_ids), len(py_ids)) or 1
    return overlap, denom, overlap / denom


def main() -> None:
    args = parse_args()
    ts_path = Path(args.ts) if args.ts else find_latest(f"asreview_ts_cv_{args.dataset}")
    py_path = Path(args.py) if args.py else find_latest(f"asreview_py_cv_{args.dataset}")

    ts_payload = load_payload(ts_path)
    py_payload = load_payload(py_path)

    ts_folds = ts_payload["folds"]
    py_folds = py_payload["folds"]

    fold_results = []
    for index, (ts_fold, py_fold) in enumerate(zip(ts_folds, py_folds)):
        overlap, denom, ratio = compare_fold(ts_fold["top_ids"], py_fold["top_ids"])
        fold_results.append(
            {
                "fold": index,
                "overlap": overlap,
                "denom": denom,
                "ratio": ratio,
            }
        )

    ratios = [item["ratio"] for item in fold_results]
    summary = {
        "folds": len(fold_results),
        "mean": mean(ratios) if ratios else 0.0,
        "min": min(ratios) if ratios else 0.0,
        "max": max(ratios) if ratios else 0.0,
        "perfect": sum(1 for r in ratios if r == 1.0),
    }

    output = {
        "dataset": args.dataset,
        "ts_path": str(ts_path),
        "py_path": str(py_path),
        "summary": summary,
        "folds": fold_results,
    }

    print(json.dumps(output, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
