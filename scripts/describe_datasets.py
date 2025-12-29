"""Analyze SYNERGY dataset structure and detect duplicates."""
import csv
from pathlib import Path
from collections import Counter

SYNERGY_DIR = Path("vendor/synergy-dataset/datasets")

datasets = [
    ("Cohen_2006_OralHypoglycemics", "Cohen_2006/Cohen_2006_OralHypoglycemics_ids.csv"),
    ("Kwok_2020", "Kwok_2020/Kwok_2020_ids.csv"),
    ("Wolters_2018", "Wolters_2018/Wolters_2018_ids.csv"),
]

output_lines = []

for name, csv_path in datasets:
    csv_full_path = SYNERGY_DIR / csv_path
    
    output_lines.append("")
    output_lines.append("=" * 60)
    output_lines.append(f"Dataset: {name}")
    output_lines.append("=" * 60)
    
    with open(csv_full_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    
    output_lines.append(f"Total rows: {len(rows)}")
    output_lines.append(f"Columns: {list(rows[0].keys()) if rows else 'N/A'}")
    
    # Count non-empty values per ID type
    id_counts = {
        "doi": sum(1 for r in rows if r.get("doi")),
        "openalex_id": sum(1 for r in rows if r.get("openalex_id")),
        "pmid": sum(1 for r in rows if r.get("pmid")),
    }
    
    output_lines.append("")
    output_lines.append("--- ID Coverage ---")
    for id_type, count in id_counts.items():
        pct = count / len(rows) * 100 if rows else 0
        output_lines.append(f"  {id_type}: {count}/{len(rows)} ({pct:.1f}%)")
    
    # Check for duplicates in each ID type
    output_lines.append("")
    output_lines.append("--- Duplicate Analysis ---")
    for id_type in ["doi", "openalex_id", "pmid"]:
        values = [r.get(id_type) for r in rows if r.get(id_type)]
        unique = set(values)
        duplicates = len(values) - len(unique)
        
        if duplicates > 0:
            counter = Counter(values)
            dup_ids = [(v, c) for v, c in counter.items() if c > 1]
            output_lines.append(f"  {id_type}: {duplicates} duplicates ({len(unique)} unique / {len(values)} total)")
            
            # Check if duplicates have different labels
            dup_label_conflicts = 0
            for dup_id, _ in dup_ids:
                labels = [r.get("label_included") for r in rows if r.get(id_type) == dup_id]
                if len(set(labels)) > 1:
                    dup_label_conflicts += 1
            
            if dup_label_conflicts > 0:
                output_lines.append(f"    WARNING: {dup_label_conflicts} duplicates have CONFLICTING labels!")
            
            sample = dup_ids[:3]
            output_lines.append(f"    Sample: {[f'{v[-20:]}({c}x)' for v,c in sample]}")
        else:
            output_lines.append(f"  {id_type}: No duplicates")
    
    # Label distribution
    labels = Counter(r.get("label_included") for r in rows)
    output_lines.append("")
    output_lines.append("--- Label Distribution ---")
    for label, count in sorted(labels.items()):
        pct = count / len(rows) * 100 if rows else 0
        output_lines.append(f"  label_included='{label}': {count} ({pct:.1f}%)")

# Write to file
with open("scripts/dataset_analysis.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(output_lines))

print("Analysis saved to scripts/dataset_analysis.txt")
