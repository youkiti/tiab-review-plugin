# 実験計画: gemini-3.1-flash-lite (GA)

## コンテキスト

2026-05 時点で `gemini-3.1-flash-lite` (GA 版、preview suffix なし) が利用可能になった。
preview 版 (2026-03 評価) では C1 Recall 92.9% で B4 (`gemini-3-flash-preview`, Recall 96.1%) より -3.2pp 低下し、デフォルト切替は見送られた。
GA リリースで挙動が改善している可能性があるため、同条件で再評価する。

**RQ1**: GA 版は preview 版から精度改善しているか？
**RQ2**: GA 版は B4 と同等の Recall (≥0.95) を達成できるか？

## 比較対象

| モデル | 由来 | depression Recall |
|---|---|---|
| B4 (`gemini-3-flash-preview`) | `experiments/report.md` | 0.961 |
| Preview (`gemini-3.1-flash-lite-preview`) C1 | `experiments/gemini-3.1-flash-lite/report.md` | 0.929 |
| **GA (`gemini-3.1-flash-lite`)** | 今回 | TBD |

## 2 段階の実験設計 (preview 版と同構造)

### Phase 1: depression × 4 条件

| 条件 | Temp | TopP | Thinking |
|---|---|---|---|
| C1 | 0.0 | — | なし |
| C2 | 1.0 | 0.95 | なし |
| C3 | 1.0 | 0.95 | MINIMAL |
| C4 | 1.0 | 0.95 | LOW |

→ Recall 最高条件を最適として選定。

### Phase 2: 最適条件 × 全データセット

cq1 / cq2 / cq3 / cq4 / cq5 / wilson の 6 データセット (depression は Phase 1 で取得済)。

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall@0.5) | ★最重要 | ≥ 0.95 |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | ≥ 0.93 |
| AUC | preview の threshold パラドックス確認 | — |
| 処理時間 (ms/件) | コスト評価 | — |

## 判断基準

- Recall ≥ 0.95 → デフォルト切替候補
- Recall 0.93 – 0.95 → フォールバック枠検討
- Recall < 0.93 → 現行構成維持

## 実行コマンド

```bash
# 疎通確認 (depression 50 件)
npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json \
  experiments/gemini-3.1-flash-lite-ga/runner.ts --dataset depression --condition C1 --tier tier_max --sample 50

# Phase 1
npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json \
  experiments/gemini-3.1-flash-lite-ga/run_phase1.ts

# Phase 2 (例: C1 が最適なら)
npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json \
  experiments/gemini-3.1-flash-lite-ga/run_phase2.ts --condition C1

# サマリー
npx ts-node --project experiments/gemini-3.1-flash-lite-ga/tsconfig.json \
  experiments/gemini-3.1-flash-lite-ga/summarize.ts
```

## ソースコード

- ランナー: [runner.ts](runner.ts)
- Phase 1: [run_phase1.ts](run_phase1.ts)
- Phase 2: [run_phase2.ts](run_phase2.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/` 配下
- 既存実験: `experiments/report.md`、`experiments/gemini-3.1-flash-lite/report.md`
