import csv

# Read index.csv
with open('vendor/synergy-dataset/index.csv', 'r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    datasets = []
    for row in reader:
        n_papers = int(row.get('n_papers', 0) or 0)
        n_included = int(row.get('n_included', 0) or 0)
        if n_papers > 0:
            rate = n_included / n_papers * 100
            datasets.append({
                'name': row['dataset_id'],
                'n_papers': n_papers,
                'n_included': n_included,
                'rate': rate
            })

# Sort by inclusion rate
datasets.sort(key=lambda x: x['rate'], reverse=True)

print('Rank | Dataset                        | Papers | Included | Rate')
print('-----|--------------------------------|--------|----------|------')
for i, d in enumerate(datasets):
    print(f"{i+1:4} | {d['name'][:30]:<30} | {d['n_papers']:>6} | {d['n_included']:>8} | {d['rate']:>5.2f}%")
