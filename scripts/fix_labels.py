"""Fix labels in already fetched JSON files by re-reading from CSV.
Uses first occurrence of each ID to handle duplicates correctly."""
import csv
import json
from pathlib import Path

SYNERGY_DIR = Path("vendor/synergy-dataset/datasets")
OUTPUT_DIR = Path("scripts/asreview-baseline")

def parse_label(val):
    """Parse label_included value, handling potential quotes."""
    if val is None:
        return 0
    val = str(val).strip().strip("'\"")
    try:
        return int(val)
    except ValueError:
        return 0

datasets = [
    ("Cohen_2006_OralHypoglycemics", "Cohen_2006/Cohen_2006_OralHypoglycemics_ids.csv"),
    ("Kwok_2020", "Kwok_2020/Kwok_2020_ids.csv"),
    ("Wolters_2018", "Wolters_2018/Wolters_2018_ids.csv"),
]

for name, csv_path in datasets:
    json_path = OUTPUT_DIR / f"{name}.json"
    csv_full_path = SYNERGY_DIR / csv_path
    
    if not json_path.exists():
        print(f"Skipping {name}: JSON not found")
        continue
    
    # Load JSON
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    # Load CSV and create label lookup (FIRST occurrence wins)
    with open(csv_full_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        label_lookup = {}
        for row in reader:
            oid = row.get("openalex_id")
            if oid and oid not in label_lookup:  # Only use first occurrence
                label_lookup[oid] = parse_label(row.get("label_included"))
    
    csv_included = sum(1 for v in label_lookup.values() if v == 1)
    print(f"{name}: CSV unique IDs={len(label_lookup)}, Included={csv_included}")
    
    # Fix labels in JSON
    fixed_count = 0
    for record in data:
        old_label = record["label_included"]
        new_label = label_lookup.get(record["id"], 0)
        if old_label != new_label:
            record["label_included"] = new_label
            fixed_count += 1
    
    # Save
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    # Stats
    total = len(data)
    included = sum(1 for r in data if r["label_included"] == 1)
    excluded = sum(1 for r in data if r["label_included"] == 0)
    print(f"  -> Fixed {fixed_count} labels. Final: Total={total}, Included={included}, Excluded={excluded}")
