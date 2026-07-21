# 実験計画: gemini-3.5-flash-lite

## コンテキスト

2026-07-22、Lite階層の新モデル `gemini-3.5-flash-lite` がリリースされた。
公式価格（ユーザー提供, 2026-07-22）: **入力 $0.30 / 出力 $2.50 (思考トークン含む) / 1M tokens**。

現行の本番デフォルトは `gemini-3.1-flash-lite` (GA, Temp 0 = C1) で、depression データセットにおいて
Recall 93.6% / Precision 61.6% / Fβ(7) 92.6%、コスト約 $0.30/1K件、約9ms/件を記録している
([experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md))。

**RQ1**: `gemini-3.5-flash-lite` は現行デフォルト `gemini-3.1-flash-lite` (GA C1, Recall 93.6%, ~$0.30/1K件) を上回るか？
**RQ2**: B4 (`gemini-3-flash-preview`, Recall 96.1%) に近づけるか？

## 比較対象

| モデル | 由来 | depression Recall | コスト (/1K件) |
|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | [experiments/report.md](../report.md) | 0.961 | 約$1.70 (推定) |
| GA C1 (`gemini-3.1-flash-lite`, 現行デフォルト) | [experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md) | 0.936 | 約$0.30 (推定) |
| **`gemini-3.5-flash-lite`** | 今回 | TBD | TBD (実測) |

## 実験設計: depression × 4 条件 (Lite階層の定番マトリクス)

本ラウンドは depression データセットのみで実施する（プロジェクトオーナーの指示）。

| 条件 | Temp | TopP | Thinking |
|---|---|---|---|
| C1 | 0.0 | — | なし |
| C2 | 1.0 | 0.95 | なし |
| C3 | 1.0 | 0.95 | MINIMAL |
| C4 | 1.0 | 0.95 | LOW |

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall@0.5) | ★最重要 | GA C1 (93.6%) を上回るか、B4 (96.1%) に近づくか |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | — |
| コスト ($/1K件) | 実測 (トークン集計ベース) | GA C1 (~$0.30) 対比 |
| 処理時間 (ms/件) | 参考 | — |

## 判断基準 (採用可否)

| Recall | コスト条件 (対 B4) | 判定 |
|---|---|---|
| ≥ 0.96 | B4比 ≤ 2倍 | デフォルト切替候補 |
| ≥ 0.95 | B4比 2〜5倍 | UI公開（上位互換枠） |
| ≥ 0.95 | B4比 > 5倍 | 実験記録のみ |
| 0.93 〜 0.95 | — | 現行デフォルト (GA C1) とのフォールバック比較検討 |
| < 0.93 | — | 却下 |

## 実行手順 (スモーク → コスト試算 → フル実行)

各条件 C1→C2→C3→C4 の順に:

1. スモークテスト (n=50, tier_smoke) を実行し `cost.totalUSD` を確認
2. `fullCostEstimate = totalUSD / 50 * 1993` でフル実行(1,993件)のコストを試算
3. `fullCostEstimate < $20` ならフル実行 (tier_max) へ進む
4. `$20` 以上ならフル実行をスキップし、スモーク結果のみ記録

```bash
# スモーク確認 (例: C1)
npx ts-node --project experiments/gemini-3.5-flash-lite/tsconfig.json \
  experiments/gemini-3.5-flash-lite/runner.ts --dataset depression --condition C1 --tier tier_smoke --sample 50

# フル実行 (例: C1)
npx ts-node --project experiments/gemini-3.5-flash-lite/tsconfig.json \
  experiments/gemini-3.5-flash-lite/runner.ts --dataset depression --condition C1 --tier tier_max

# サマリー
npx ts-node --project experiments/gemini-3.5-flash-lite/tsconfig.json \
  experiments/gemini-3.5-flash-lite/summarize.ts
```

Lite階層のモデルは歴史的に非常に安価（1データセットあたり1ドル未満が想定）なため、
$20 の閾値を超えることは基本的に想定していない。

## ソースコード

- ランナー: [runner.ts](runner.ts)（gemini-3.1-flash-lite-ga の引数処理・評価ロジック + gemini-3.5-flash のトークン集計・コスト試算ロジックを移植）
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 既存実験: [experiments/report.md](../report.md) (B4)、[experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md) (GA C1)、[experiments/gemini-3.5-flash/report.md](../gemini-3.5-flash/report.md) (コスト試算ロジックの参照元)
