import json

with open('scripts/asreview-baseline/test_data.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

total = len(data)
included = sum(1 for r in data if r.get("label_included") == 1)
excluded = sum(1 for r in data if r.get("label_included") == 0)

print(f"Total: {total}")
print(f"Included: {included}")
print(f"Excluded: {excluded}")
print(f"\nSample record:")
print(json.dumps(data[0], ensure_ascii=False, indent=2)[:500])
