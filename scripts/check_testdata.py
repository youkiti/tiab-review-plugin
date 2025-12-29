import json
from pathlib import Path

OUTPUT_DIR = Path("scripts/asreview-baseline")

for name in ["Cohen_2006_OralHypoglycemics", "Kwok_2020", "Wolters_2018"]:
    json_path = OUTPUT_DIR / f"{name}.json"
    if json_path.exists():
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        total = len(data)
        included = sum(1 for r in data if r["label_included"] == 1)
        excluded = sum(1 for r in data if r["label_included"] == 0)
        print(f"{name}: Total={total}, Included={included}, Excluded={excluded}")
    else:
        print(f"{name}: NOT FOUND")
