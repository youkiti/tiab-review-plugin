# gemini-3.8-flash threshold スイープ (depression)

保存済み JSONL (results/depression_<条件ID>_items.jsonl) から再計算（API 追加コストなし）。既定 threshold=0.5。採用基準 Recall≥95%。

データセット: scripts/asreview-baseline/datasets/depression_slim_labeled.json (n=1993, 陽性=280)

## F1

集計対象: 1993件 (JSONL全体からエラー/未判定 0件、ラベル不一致 0件を除外)

確率分布: <0.1=1499 / 0.1-0.5=149 / 0.5-0.9=99 / ≥0.9=246

| threshold | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN |
|---|---|---|---|---|---|---|---|---|
| 0.05 | **97.5%** ✅ | 75.0% | 38.9% | 94.6% | 273 | 429 | 1284 | 7 |
| 0.10 | **94.3%** | 86.6% | 53.4% | 92.9% | 264 | 230 | 1483 | 16 |
| 0.15 | **92.9%** | 89.4% | 59.0% | 91.8% | 260 | 181 | 1532 | 20 |
| 0.20 | **92.9%** | 89.5% | 59.1% | 91.8% | 260 | 180 | 1533 | 20 |
| 0.30 | **92.1%** | 91.6% | 64.2% | 91.3% | 258 | 144 | 1569 | 22 |
| 0.40 | **90.7%** | 92.6% | 66.7% | 90.1% | 254 | 127 | 1586 | 26 |
| 0.50 | **88.9%** | 94.4% | 72.2% | 88.5% | 249 | 96 | 1617 | 31 |

## F2

対象データが無い（C:\Users\youki\codes\tiab-review-plugin\experiments\gemini-3.8-flash\results\depression_F2_items.jsonl が未生成）。runner.ts の実行後に再度実行してください。

