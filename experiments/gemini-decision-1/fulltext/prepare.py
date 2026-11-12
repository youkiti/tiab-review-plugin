# 凍結した全文課題を照合し、本文と比較確率を含む非公開入力を作る。
import argparse
import hashlib
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

EXPECTED = {"cc-by": (1274, 723, 551), "cc-by-nc": (5186, 2557, 2629)}
DEFAULT_CB = Path("C:/Users/youki/codes/Cochrane-bench")


def jsonl(file):
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def screening_prompt(task):
    return ("You are reproducing the FULL-TEXT SCREENING stage of a Cochrane systematic review. "
            "The review's authors read the full text of each candidate study and decided whether to "
            "include it. Decide whether the candidate study given as the record meets the review's "
            "eligibility criteria below, using only the record's title and full text.\n\n"
            f"Review objectives: {task['objectives']}\n\n"
            f"Eligibility criteria:\n{task['eligibility_text']}")


def unique(rows, key, name):
    result = {}
    for row in rows:
        k = key(row)
        if k in result:
            raise ValueError(f"{name}: 重複キー {k}")
        result[k] = row
    return result


def prepare(args):
    cb, tier = args.cochrane_bench, args.tier
    sys.path.insert(0, str(cb / "src"))
    from cochrane_bench.corpus.manifest import read_jsonl
    from cochrane_bench.schemas import Task2Gold
    from cochrane_bench.data_io.jats_fulltext import jats_to_screening_text

    baseline = "jev-1.14.0-t03" if tier == "cc-by" else "haiku-5-5-agent"
    inputs = args.inputs or cb / "data/baseline" / tier / baseline / "task2_fulltext_oa/inputs"
    jev_file = args.jev_ledger or Path(f"C:/tmp/dec1ft-inputs/jev_{tier}.jsonl")
    gold_file = cb / "data/processed" / tier / "gold/task2_screening_oa.jsonl"
    mapping_file = cb / "data/processed" / tier / "gold/task2_screening.jsonl"
    mappings = {r.pmcid: r.pmid_to_study_id for r in read_jsonl(mapping_file, Task2Gold)}
    tasks = [json.loads(file.read_text(encoding="utf-8")) for file in sorted(inputs.glob("*.json"))]
    gold = unique(
        [(review, record) for review in jsonl(gold_file) for record in review["records"]],
        lambda pair: (pair[0]["pmcid"], pair[1]["pmid"]), "ゴールド")
    source = unique([(task, record) for task in tasks for record in task["records"]],
                    lambda pair: (pair[0]["pmcid"], pair[1]["pmid"]), "入力")
    jev = unique(jsonl(jev_file), lambda row: (row["pmcid"], row["pmid"]), "jev")
    for name, other in [("ゴールド", gold), ("jev", jev)]:
        if source.keys() != other.keys():
            raise ValueError(f"{name}: 入力に不足 {len(other.keys() - source.keys())} / 余分 {len(source.keys() - other.keys())}")
    counts = (len(source), sum(r[1]["label"] == "included" for r in gold.values()),
              sum(r[1]["label"] == "excluded" for r in gold.values()))
    if counts != EXPECTED[tier]:
        raise ValueError(f"記録・陽性・陰性: 実測 {counts} / 期待 {EXPECTED[tier]}")
    cache = unique(jsonl(cb / "data/interim" / tier / "screening_fulltext_link_cache.jsonl"),
                   lambda row: row["pmid"], "PDF対応")
    for task, record in source.values():
        if task["tier"] != tier or task["pmcid"] not in mappings:
            raise ValueError("層または研究対応が一致しません")
        if not (cb / record["xml_path"]).is_file():
            raise ValueError(f"XML がありません: {record['xml_path']}")
    rows = []
    for key, (task, record) in source.items():
        review, answer = gold[key]
        probability = jev[key]["include_probability"]
        if isinstance(probability, bool) or not isinstance(probability, (int, float)) or not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError(f"jev 確率が不正: {key}")
        full = jats_to_screening_text((cb / record["xml_path"]).read_text(encoding="utf-8"))
        text = full[:120000]
        reports = cache.get(record["pmid"], {}).get("reports", [])
        matches = [r for r in reports if r["pmcid"] == record["report_pmcid"]]
        if len(matches) > 1:
            raise ValueError(f"PDF 対応が重複: {key}")
        report = matches[0] if matches else {}
        url = report.get("pdf_url") or None
        if url:
            parsed = urlsplit(url)
            if parsed.scheme != "s3" or parsed.netloc != "pmc-oa-opendata":
                raise ValueError(f"PDF URL の形式が不正: {key}")
            url = "https://pmc-oa-opendata.s3.amazonaws.com" + parsed.path
            if not report.get("pdf_md5"):
                raise ValueError(f"PDF MD5 がありません: {key}")
        studies = mappings[key[0]].get(key[1], [])
        rows.append(dict(key=f"{key[0]}:{key[1]}", pmcid=key[0], cochrane_id=review["cochrane_id"],
                         pmid=key[1], label=answer["label"], gold_exclusion_reason=answer.get("exclusion_reason"),
                         study_keys=sorted({f"study:{s}" for s in studies}) if studies else [f"pmid:{key[1]}"],
                         title=record["title"], screening_prompt=screening_prompt(task), text=text,
                         text_chars=len(text), text_truncated=len(full) > 120000, report_pmcid=record["report_pmcid"],
                         pdf_url=url, pdf_md5=report.get("pdf_md5") if url else None, jev_probability=probability))
    content = ("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n").encode("utf-8")
    manifest = dict(tier=tier, records=counts[0], positives=counts[1], negatives=counts[2],
                    pdf_available=sum(r["pdf_url"] is not None for r in rows),
                    text_truncated=sum(r["text_truncated"] for r in rows), records_sha256=sha(content),
                    gold_sha256=sha(gold_file.read_bytes()), created_at=datetime.now(timezone.utc).isoformat())
    directory = Path(__file__).parent / "data" / tier
    directory.mkdir(parents=True, exist_ok=True)
    records_tmp = directory / "records.jsonl.tmp"
    manifest_tmp = directory / "manifest.json.tmp"
    records_tmp.write_bytes(content)
    manifest_tmp.write_bytes((json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    os.replace(records_tmp, directory / "records.jsonl")
    os.replace(manifest_tmp, directory / "manifest.json")
    for name in ("tier", "records", "positives", "negatives", "pdf_available", "text_truncated"):
        print(f"{name}: {manifest[name]}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=EXPECTED, required=True)
    parser.add_argument("--cochrane-bench", type=Path, default=DEFAULT_CB)
    parser.add_argument("--inputs", type=Path)
    parser.add_argument("--jev-ledger", type=Path)
    try:
        prepare(parser.parse_args())
    except (ValueError, OSError, ImportError, KeyError) as error:
        print(f"準備失敗: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
