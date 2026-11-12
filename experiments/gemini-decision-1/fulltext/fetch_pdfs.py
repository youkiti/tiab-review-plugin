# 全文入力に対応する PDF を検証付きで並列取得し、再開用の台帳へ追記する。
import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
import random
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

LOCAL = threading.local()


def md5(file):
    digest = hashlib.md5()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch(record, directory):
    pmcid = record["report_pmcid"]
    target = directory / f"{pmcid}.pdf"
    expected = record["pdf_md5"].lower()
    status, size, attempts = "network", 0, 0
    if target.exists() and md5(target) == expected:
        status, size = "ok", target.stat().st_size
    else:
        if not hasattr(LOCAL, "session"):
            LOCAL.session = requests.Session()
        mismatches = 0
        temporary = target.with_suffix(".pdf.tmp")
        for attempts in range(1, 6):
            try:
                with LOCAL.session.get(record["pdf_url"], timeout=120, stream=True) as response:
                    status = f"http_{response.status_code}"
                    if response.status_code == 200:
                        size = 0
                        with temporary.open("wb") as stream:
                            for block in response.iter_content(1024 * 1024):
                                stream.write(block)
                                size += len(block)
                        if md5(temporary) == expected:
                            os.replace(temporary, target)
                            status = "ok"
                        else:
                            status = "md5_mismatch"
                            mismatches += 1
                    else:
                        size = 0
            except requests.RequestException:
                status, size = "network", 0
            finally:
                if temporary.exists():
                    temporary.unlink()
            if status in ("ok", "http_404") or mismatches >= 2:
                break
            if attempts < 5:
                time.sleep(min(60, 2 * 2 ** (attempts - 1) * random.uniform(1, 2)))
    return dict(report_pmcid=pmcid, status=status, bytes=size, attempts=attempts,
                completed_at=datetime.now(timezone.utc).isoformat())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tier", choices=("cc-by", "cc-by-nc"), required=True)
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()
    if args.concurrency < 1:
        parser.error("並列数は1以上にしてください")
    directory = Path(__file__).parent / "data" / args.tier
    records = {}
    for line in (directory / "records.jsonl").read_text(encoding="utf-8").splitlines():
        record = json.loads(line)
        if not record["pdf_url"]:
            continue
        pmcid = record["report_pmcid"]
        if not re.fullmatch(r"PMC[0-9]+", pmcid) or not re.fullmatch(r"[a-fA-F0-9]{32}", record["pdf_md5"] or ""):
            raise ValueError("PDF の識別子または MD5 が不正です")
        previous = records.get(pmcid)
        if previous and (previous["pdf_url"], previous["pdf_md5"]) != (record["pdf_url"], record["pdf_md5"]):
            raise ValueError("同じ PDF の対応が一致しません")
        records[pmcid] = record
    pdf_dir = directory / "pdf"
    pdf_dir.mkdir(parents=True, exist_ok=True)
    counts = collections.Counter()
    ledger = directory / "pdf_fetch.jsonl"
    if ledger.exists() and ledger.stat().st_size and not ledger.read_bytes().endswith(b"\n"):
        with ledger.open("ab") as stream:
            stream.write(b"\n")
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(fetch, record, pdf_dir) for record in records.values()]
        with ledger.open("a", encoding="utf-8", newline="\n") as stream:
            for future in concurrent.futures.as_completed(futures):
                row = future.result()
                stream.write(json.dumps(row) + "\n")
                stream.flush()
                counts[row["status"]] += 1
    failures = sum(n for status, n in counts.items() if status != "ok")
    detail = ", ".join(f"{s}: {n}" for s, n in sorted(counts.items()) if s != "ok") or "なし"
    print(f"ok {counts['ok']} / 失敗 {failures}（{detail}）", flush=True)
    return 2 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError):
        print("PDF 取得の入出力に失敗しました。入力と保存先を確認してください。", file=sys.stderr)
        sys.exit(1)
