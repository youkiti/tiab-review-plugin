# 実験計画: gemini-3.6-flash

## コンテキスト

2026-07 リリースの `gemini-3.6-flash` は、Thinking 対応 Flash モデルの最新版。
公式価格（ユーザー提供, 2026-07-22）で **入力 $1.50 / 出力 $7.50 (思考トークン含む)** — 前世代 `gemini-3.5-flash`（入力 $1.50 / 出力 $9.00）より出力単価が引き下げられた。
直前の同格モデル `gemini-3.5-flash`（`experiments/gemini-3.5-flash/report.md`）は depression Recall 93.2%（最良条件 D2）で 95% バーに届かず **却下** されている。
今回は同じ thinking_level マトリクスで再評価し、`gemini-3.6-flash` が B4 に並ぶ精度を達成できたか、また値下げされた出力単価がコスト評価にどう影響するかを確認する。

**RQ1**: `gemini-3.6-flash` は depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: $/1K件は B4 の ~$1.70 と比較して許容範囲か？

## 比較対象

| モデル | 由来 | depression Recall | 備考 |
|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | `experiments/report.md` | 0.961 | 現行精度枠（チャンピオン） |
| gemini-3.5-flash (最良 D2) | `experiments/gemini-3.5-flash/report.md` | 0.932 | 同格モデル、却下済み（Recall未達） |
| **`gemini-3.6-flash`** | 今回 | TBD | |

## 実験設計

### Phase 1 のみ: depression × 3条件（D1-D3）フル実行、D4 は既定で除外

TopP 0.95 / Temp 1.0 固定、thinking_level のみ振る。

| 条件 | thinking_level | maxOutputTokens | 備考 |
|---|---|---|---|
| D1 | LOW | 8,192 | B4 相当 |
| D2 | MINIMAL | 4,096 | |
| D3 | MEDIUM | 16,384 | |
| D4 (既定で除外) | HIGH | 32,768 | gemini-3.5-flash の先例（HIGH で $104/データセット）を踏まえ既定除外。ただし新モデルのため疎通確認（smoke, n=50）は実施し、実測コストが $20/データセット未満ならフル実行に格上げする |

### 実行ルール（疎通確認 → コスト判定 → フル実行）

各条件について:
1. `--tier tier_smoke --sample 50` で疎通確認
2. `cost.totalUSD / 50 * 1993` で全件コストを外挿
3. 外挿コスト < $20 → `--tier tier_max`（フル件数）で本実行
4. 外挿コスト ≥ $20 → フル実行せず、smoke の実測値のみで記録（除外）

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall@0.5) | ★最重要 | ≥ 0.95 |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | ≥ 0.93 |
| 処理時間 (ms/件) | コスト評価 | — |
| **$/1K件** | ★新規追加 | B4 比 ≤ 5倍 |
| MAX_TOKENS 切り詰め率 | 信頼性 | ≤ 5% |

## 判断基準（採用判定表）

| Recall | B4比コスト | 結論 |
|---|---|---|
| ≥ 0.96 | ≤ 2倍 | デフォルト切替候補 |
| ≥ 0.95 | 2–5倍 | UI公開（上位互換枠） |
| ≥ 0.95 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.93–0.95 | — | フォールバック検討 |
| < 0.93 | — | 現行維持（却下） |

## 実行コマンド

```bash
# 疎通確認 (depression 50件, 条件ごと)
npx ts-node --project experiments/gemini-3.6-flash/tsconfig.json \
  experiments/gemini-3.6-flash/runner.ts --dataset depression --condition D1 --tier tier_smoke --sample 50

# Phase 1 本実行 (D1-D3、D4は個別に判断)
npx ts-node --project experiments/gemini-3.6-flash/tsconfig.json \
  experiments/gemini-3.6-flash/run_phase1.ts

# サマリー
npx ts-node --project experiments/gemini-3.6-flash/tsconfig.json \
  experiments/gemini-3.6-flash/summarize.ts
```

## ソースコード

- ランナー: [runner.ts](runner.ts)
- Phase 1: [run_phase1.ts](run_phase1.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 既存実験: `experiments/report.md`（B4 チャンピオン）、`experiments/gemini-3.5-flash/report.md`（直前の同格モデル、却下事例）
