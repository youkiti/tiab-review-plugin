"""Debug the label lookup issue in detail."""
import csv
from pathlib import Path

csv_path = Path("vendor/synergy-dataset/datasets/Kwok_2020/Kwok_2020_ids.csv")

with open(csv_path, "r", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

# Find included rows
included_rows = [r for r in rows if r.get("label_included") == "1"]
print(f"Rows with label_included=='1': {len(included_rows)}")

# Now simulate what the lookup does
label_lookup = {}
for row in rows:
    oid = row.get("openalex_id")
    if oid:
        label_str = row.get("label_included", "0")
        try:
            label_int = int(label_str)
        except ValueError as e:
            print(f"ValueError for '{label_str}': {e}")
            label_int = 0
        label_lookup[oid] = label_int

included_count = sum(1 for v in label_lookup.values() if v == 1)
print(f"Included count in label_lookup: {included_count}")

# If still 0, check first included row's label
if included_rows:
    first = included_rows[0]
    print(f"\nFirst included row label_included: repr='{repr(first['label_included'])}'")
    print(f"  in label_lookup: {label_lookup.get(first['openalex_id'], 'NOT FOUND')}")
