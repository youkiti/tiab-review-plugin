"""
Fetch title and abstract from OpenAlex API for SYNERGY dataset verification.
Uses batch requests (up to 50 works per request) for faster processing.

Usage:
  python scripts/fetch_openalex_testdata.py Cohen_2006_OralHypoglycemics
  python scripts/fetch_openalex_testdata.py --list
  python scripts/fetch_openalex_testdata.py Kwok_2020 --resume
"""

import json
import time
import argparse
import requests
import csv
from pathlib import Path

# Configuration
SYNERGY_DIR = Path("vendor/synergy-dataset/datasets")
OUTPUT_DIR = Path("scripts/asreview-baseline")
BATCH_SIZE = 50  # OpenAlex max per request

def list_datasets():
    """List available SYNERGY datasets."""
    datasets = []
    for d in SYNERGY_DIR.iterdir():
        if d.is_dir():
            ids_files = list(d.glob("*_ids.csv"))
            if ids_files:
                datasets.append(d.name)
    return sorted(datasets)

def find_ids_file(dataset_name: str) -> Path | None:
    """Find the IDs CSV file for a dataset."""
    # Try direct directory match first
    dataset_dir = SYNERGY_DIR / dataset_name
    if dataset_dir.exists():
        ids_file = dataset_dir / f"{dataset_name}_ids.csv"
        if ids_file.exists():
            return ids_file
        ids_files = list(dataset_dir.glob("*_ids.csv"))
        if ids_files:
            return ids_files[0]
    
    # Try searching for file in all subdirectories (for Cohen_2006 sub-datasets)
    for subdir in SYNERGY_DIR.iterdir():
        if subdir.is_dir():
            ids_file = subdir / f"{dataset_name}_ids.csv"
            if ids_file.exists():
                return ids_file
    
    return None

def fetch_openalex_batch(openalex_ids: list[str]) -> dict:
    """Fetch multiple works from OpenAlex API in a single request."""
    if not openalex_ids:
        return {}
    
    # Extract work IDs
    work_ids = [oid.replace("https://openalex.org/", "") for oid in openalex_ids if oid]
    
    # Build filter query: openalex:W123|W456|W789
    filter_query = "|".join(work_ids)
    api_url = f"https://api.openalex.org/works?filter=openalex:{filter_query}&per_page={BATCH_SIZE}"
    
    try:
        response = requests.get(api_url, headers={"User-Agent": "TiAbReviewPlugin/1.0"}, timeout=30)
        if response.status_code == 200:
            data = response.json()
            results = {}
            for work in data.get("results", []):
                work_id = work.get("id", "")
                results[work_id] = work
            return results
        else:
            print(f"  Batch request failed: {response.status_code}")
            return {}
    except Exception as e:
        print(f"  Batch error: {e}")
        return {}

def extract_abstract(work: dict) -> str:
    """Extract abstract from OpenAlex work object (inverted index format)."""
    abstract_index = work.get("abstract_inverted_index")
    if not abstract_index:
        return ""
    
    word_positions = []
    for word, positions in abstract_index.items():
        for pos in positions:
            word_positions.append((pos, word))
    
    word_positions.sort(key=lambda x: x[0])
    return " ".join(word for _, word in word_positions)

def main():
    parser = argparse.ArgumentParser(description="Fetch OpenAlex data for SYNERGY dataset")
    parser.add_argument("dataset", nargs="?", help="Dataset name")
    parser.add_argument("--list", action="store_true", help="List available datasets")
    parser.add_argument("--max", type=int, default=None, help="Maximum records to fetch")
    parser.add_argument("--resume", action="store_true", help="Resume from existing output")
    parser.add_argument("--output", type=str, default=None, help="Output file path")
    args = parser.parse_args()
    
    if args.list:
        print("Available SYNERGY datasets:")
        for ds in list_datasets():
            print(f"  {ds}")
        return
    
    if not args.dataset:
        parser.print_help()
        print("\nError: Please specify a dataset name or use --list")
        return
    
    ids_file = find_ids_file(args.dataset)
    if not ids_file:
        print(f"Error: Dataset '{args.dataset}' not found")
        return
    
    output_path = Path(args.output) if args.output else OUTPUT_DIR / f"{args.dataset}.json"
    
    print(f"Dataset: {args.dataset}")
    print(f"Reading from: {ids_file}")
    print(f"Output to: {output_path}")
    print(f"Batch size: {BATCH_SIZE}")
    
    # Read dataset
    records = []
    with open(ids_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("openalex_id"):
                records.append(row)
    
    print(f"\nTotal records with OpenAlex ID: {len(records)}")
    included_count = sum(1 for r in records if r.get("label_included") == "1")
    excluded_count = sum(1 for r in records if r.get("label_included") == "0")
    print(f"  Included: {included_count}")
    print(f"  Excluded: {excluded_count}")
    
    # Load existing if resuming
    existing_ids = set()
    output_records = []
    if args.resume and output_path.exists():
        with open(output_path, "r", encoding="utf-8") as f:
            output_records = json.load(f)
            existing_ids = {r["id"] for r in output_records}
        print(f"Resuming: {len(existing_ids)} records already fetched")
    
    # Filter out already fetched
    records_to_fetch = [r for r in records if r.get("openalex_id") not in existing_ids]
    
    if args.max:
        records_to_fetch = records_to_fetch[:args.max]
    
    print(f"Records to fetch: {len(records_to_fetch)}")
    
    # Create lookup for labels from ALL records (FIRST occurrence wins for duplicates)
    def safe_int(val):
        try:
            return int(val)
        except (ValueError, TypeError):
            return 0
    
    label_lookup = {}
    for r in records:
        oid = r.get("openalex_id")
        if oid and oid not in label_lookup:
            label_lookup[oid] = safe_int(r.get("label_included", 0))
    
    # Fetch in batches
    print(f"\nFetching from OpenAlex API (batch mode)...")
    total_batches = (len(records_to_fetch) + BATCH_SIZE - 1) // BATCH_SIZE
    fetched = 0
    skipped = 0
    
    for batch_num in range(total_batches):
        start_idx = batch_num * BATCH_SIZE
        end_idx = min(start_idx + BATCH_SIZE, len(records_to_fetch))
        batch_records = records_to_fetch[start_idx:end_idx]
        batch_ids = [r["openalex_id"] for r in batch_records]
        
        print(f"[Batch {batch_num + 1}/{total_batches}] Fetching {len(batch_ids)} records...")
        
        results = fetch_openalex_batch(batch_ids)
        
        for openalex_id in batch_ids:
            work = results.get(openalex_id)
            if work:
                title = work.get("title", "")
                abstract = extract_abstract(work)
                
                if title and abstract:
                    output_records.append({
                        "id": openalex_id,
                        "title": title,
                        "abstract": abstract,
                        "label_included": label_lookup.get(openalex_id, 0)
                    })
                    fetched += 1
                else:
                    skipped += 1
            else:
                skipped += 1
        
        # Rate limiting (1 request per second is polite)
        time.sleep(1)
        
        # Checkpoint every 5 batches
        if (batch_num + 1) % 5 == 0:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(output_records, f, ensure_ascii=False, indent=2)
            print(f"  [Checkpoint] Saved {len(output_records)} records")
    
    # Final stats
    print(f"\n=== Fetch Complete ===")
    print(f"New records fetched: {fetched}")
    print(f"Skipped (missing data): {skipped}")
    print(f"\nFinal dataset:")
    print(f"  Total: {len(output_records)}")
    print(f"  Included: {sum(1 for r in output_records if r['label_included'] == 1)}")
    print(f"  Excluded: {sum(1 for r in output_records if r['label_included'] == 0)}")
    
    # Save
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output_records, f, ensure_ascii=False, indent=2)
    
    print(f"\nSaved to: {output_path}")

if __name__ == "__main__":
    main()
