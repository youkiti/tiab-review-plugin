import argparse
import json
import math
from pathlib import Path
from statistics import mean, median


ROOT = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = ROOT / "experiments" / "asreview" / "outputs"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="cq3", choices=["cq3", "depression"])
    parser.add_argument("--ts", help="TS出力JSONのパス")
    parser.add_argument("--py", help="Python出力JSONのパス")
    parser.add_argument("--top", type=int, default=10)
    return parser.parse_args()


def find_latest(prefix: str) -> Path:
    candidates = sorted(OUTPUTS_DIR.glob(f"{prefix}_*.json"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        raise FileNotFoundError(f"{prefix}_*.json が見つかりません")
    return candidates[-1]


def load_payload(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_proba(payload: dict) -> list[float]:
    return payload["proba_included"]


def load_ranking(payload: dict) -> list[int]:
    return payload.get("ranking", [])


def load_record_ids(dataset_path: str) -> list[str]:
    parsed = json.loads(Path(dataset_path).read_text(encoding="utf-8"))
    if isinstance(parsed, list):
        records = parsed
    elif isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
        records = parsed["records"]
    else:
        raise ValueError("Invalid dataset format: expected array or object with records")

    ids: list[str] = []
    for idx, record in enumerate(records):
        value = record.get("id")
        ids.append(str(value) if value is not None else str(idx))
    return ids


def compare_arrays(ts_vals: list[float], py_vals: list[float], top_n: int) -> dict:
    if len(ts_vals) != len(py_vals):
        raise ValueError("配列長が一致しません")

    diffs = []
    for idx, (ts_val, py_val) in enumerate(zip(ts_vals, py_vals)):
        diff = abs(ts_val - py_val)
        diffs.append((diff, idx, ts_val, py_val))

    diffs.sort(key=lambda item: item[0], reverse=True)
    diff_values = [d[0] for d in diffs]
    diff_values_sorted = sorted(diff_values)

    p99_index = max(0, math.ceil(len(diff_values_sorted) * 0.99) - 1)
    stats = {
        "count": len(diff_values),
        "max": diff_values[0] if diff_values else 0,
        "mean": mean(diff_values) if diff_values else 0,
        "median": median(diff_values) if diff_values else 0,
        "p99": diff_values_sorted[p99_index] if diff_values else 0,
        "over_1e-12": sum(1 for d in diff_values if d > 1e-12),
    }

    top = [
        {
            "index": idx,
            "diff": diff,
            "ts": ts_val,
            "py": py_val,
        }
        for diff, idx, ts_val, py_val in diffs[:top_n]
    ]

    return {"stats": stats, "top": top}


def compare_ranking(ts_rank: list[int], py_rank: list[int], k: int = 100) -> dict:
    if not ts_rank or not py_rank:
        return {"k": k, "mismatch": None}

    limit = min(k, len(ts_rank), len(py_rank))
    mismatch = sum(1 for i in range(limit) if ts_rank[i] != py_rank[i])
    return {"k": limit, "mismatch": mismatch}


def compare_ranking_by_id(ts_rank: list[int], py_rank: list[int], record_ids: list[str], k: int = 100) -> dict:
    if not ts_rank or not py_rank:
        return {"k": k, "mismatch": None}

    limit = min(k, len(ts_rank), len(py_rank), len(record_ids))
    mismatch = 0
    for i in range(limit):
        ts_id = record_ids[ts_rank[i]]
        py_id = record_ids[py_rank[i]]
        if ts_id != py_id:
            mismatch += 1
    return {"k": limit, "mismatch": mismatch}


def main() -> None:
    args = parse_args()

    ts_path = Path(args.ts) if args.ts else find_latest(f"asreview_ts_{args.dataset}")
    py_path = Path(args.py) if args.py else find_latest(f"asreview_py_{args.dataset}")

    ts_payload = load_payload(ts_path)
    py_payload = load_payload(py_path)

    ts_vals = load_proba(ts_payload)
    py_vals = load_proba(py_payload)
    result = compare_arrays(ts_vals, py_vals, args.top)

    ts_rank = load_ranking(ts_payload)
    py_rank = load_ranking(py_payload)
    rank_result = compare_ranking(ts_rank, py_rank)

    dataset_path = ts_payload.get("datasetPath") or py_payload.get("datasetPath")
    record_ids = load_record_ids(dataset_path) if dataset_path else []
    rank_id_result = compare_ranking_by_id(ts_rank, py_rank, record_ids)

    output = {
        "dataset": args.dataset,
        "ts_path": str(ts_path),
        "py_path": str(py_path),
        "stats": result["stats"],
        "top": result["top"],
        "ranking": rank_result,
        "ranking_by_id": rank_id_result,
    }

    print(json.dumps(output, indent=2, ensure_ascii=True))


if __name__ == "__main__":
    main()
