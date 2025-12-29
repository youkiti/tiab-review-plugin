"""
Fetch title and abstract from OpenAlex API for SYNERGY dataset verification.
Creates a JSON file with records suitable for ASReview compatibility testing.

Usage:
  python scripts/fetch_openalex_testdata.py van_de_Schoot_2018    # Fetch specific dataset
  python scripts/fetch_openalex_testdata.py Nagtegaal_2019        # Another dataset
  python scripts/fetch_openalex_testdata.py --list                # List available datasets
  python scripts/fetch_openalex_testdata.py van_de_Schoot_2018 --max 200    # Limit records
  python scripts/fetch_openalex_testdata.py van_de_Schoot_2018 --resume     # Resume
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

def list_datasets():
    """List available SYNERGY datasets."""
    datasets = []
    for d in SYNERGY_DIR.iterdir():
        if d.is_dir():
            # Find *_ids.csv files
            ids_files = list(d.glob("*_ids.csv"))
            if ids_files:
                datasets.append(d.name)
    return sorted(datasets)

def find_ids_file(dataset_name: str) -> Path | None:
    """Find the IDs CSV file for a dataset."""
    dataset_dir = SYNERGY_DIR / dataset_name
    if not dataset_dir.exists():
        return None
    
    # Try exact match first
    ids_file = dataset_dir / f"{dataset_name}_ids.csv"
    if ids_file.exists():
        return ids_file
    
    # Fallback to any *_ids.csv
    ids_files = list(dataset_dir.glob("*_ids.csv"))
    if ids_files:
        return ids_files[0]
    
    return None

def fetch_openalex_work(openalex_id: str) -> dict | None:
    """Fetch work details from OpenAlex API."""
    if not openalex_id or not openalex_id.startswith("https://openalex.org/"):
        return None
    
    work_id = openalex_id.replace("https://openalex.org/", "")
    api_url = f"https://api.openalex.org/works/{work_id}"
    
    try:
        response = requests.get(api_url, headers={"User-Agent": "TiAbReviewPlugin/1.0"}, timeout=10)
        if response.status_code == 200:
            return response.json()
        else:
            print(f"  Failed: {response.status_code}")
            return None
    except Exception as e:
        print(f"  Error: {e}")
        return None

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
    parser.add_argument("dataset", nargs="?", help="Dataset name (e.g., van_de_Schoot_2018)")
    parser.add_argument("--list", action="store_true", help="List available datasets")
    parser.add_argument("--max", type=int, default=None, help="Maximum records to fetch")
    parser.add_argument("--resume", action="store_true", help="Resume from existing output file")
    parser.add_argument("--output", type=str, default=None, help="Output file path (default: auto)")
    args = parser.parse_args()
    
    # List datasets
    if args.list:
        print("Available SYNERGY datasets:")
        for ds in list_datasets():
            print(f"  {ds}")
        return
    
    # Require dataset name
    if not args.dataset:
        parser.print_help()
        print("\nError: Please specify a dataset name or use --list")
        return
    
    # Find dataset file
    ids_file = find_ids_file(args.dataset)
    if not ids_file:
        print(f"Error: Dataset '{args.dataset}' not found")
        print("Available datasets:")
        for ds in list_datasets():
            print(f"  {ds}")
        return
    
    # Determine output path
    output_path = Path(args.output) if args.output else OUTPUT_DIR / f"{args.dataset}.json"
    
    print(f"Dataset: {args.dataset}")
    print(f"Reading from: {ids_file}")
    print(f"Output to: {output_path}")
    
    # Read the dataset
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
    
    # Load existing data if resuming
    existing_ids = set()
    output_records = []
    if args.resume and output_path.exists():
        with open(output_path, "r", encoding="utf-8") as f:
            output_records = json.load(f)
            existing_ids = {r["id"] for r in output_records}
        print(f"Resuming: {len(existing_ids)} records already fetched")
    
    # Apply max limit
    if args.max:
        records = records[:args.max]
        print(f"Limited to {args.max} records")
    
    # Fetch from OpenAlex
    print("\nFetching from OpenAlex API...")
    fetched = 0
    skipped_existing = 0
    skipped_incomplete = 0
    
    for i, record in enumerate(records):
        openalex_id = record.get("openalex_id")
        label = int(record.get("label_included", 0))
        
        if openalex_id in existing_ids:
            skipped_existing += 1
            continue
        
        print(f"[{i+1}/{len(records)}] Fetching {openalex_id}...")
        
        work = fetch_openalex_work(openalex_id)
        if work:
            title = work.get("title", "")
            abstract = extract_abstract(work)
            
            if title and abstract:
                output_records.append({
                    "id": openalex_id,
                    "title": title,
                    "abstract": abstract,
                    "label_included": label
                })
                fetched += 1
                print(f"  OK: {title[:50]}...")
            else:
                skipped_incomplete += 1
                print(f"  Skipped: missing title or abstract")
        
        time.sleep(0.1)
        
        # Checkpoint every 50 records
        if fetched > 0 and fetched % 50 == 0:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(output_records, f, ensure_ascii=False, indent=2)
            print(f"  [Checkpoint] Saved {len(output_records)} records")
    
    # Final stats
    print(f"\n=== Fetch Complete ===")
    print(f"New records fetched: {fetched}")
    print(f"Skipped (already fetched): {skipped_existing}")
    print(f"Skipped (missing title/abstract): {skipped_incomplete}")
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
