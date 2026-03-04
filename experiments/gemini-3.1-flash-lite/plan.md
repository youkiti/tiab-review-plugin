# 実験計画: gemini-3.1-flash-lite-preview vs gemini-3-flash-preview

## コンテキスト

2026-03-03 リリースの `gemini-3.1-flash-lite-preview` は、コスト・速度で優位な新モデル。
Thinking対応＋構造化出力対応のため、現行デフォルト `gemini-3-flash-preview`（B4: Recall 0.96）との精度比較が必要。

**RQ**: 3.1 Flash Lite は、現行 3.0 Flash と同等のスクリーニング精度（Recall ≥ 0.95）を達成できるか？

## 2段階の実験設計

### Phase 1: depression で最適条件探索（4条件）

| 条件ID | モデル | Temp | TopP | Thinking | 目的 |
|---|---|---|---|---|---|
| C1 | gemini-3.1-flash-lite-preview | 0.0 | — | なし | ベースライン |
| C2 | gemini-3.1-flash-lite-preview | 1.0 | 0.95 | なし | 高温度 |
| C3 | gemini-3.1-flash-lite-preview | 1.0 | 0.95 | MINIMAL | 軽量Thinking |
| C4 | gemini-3.1-flash-lite-preview | 1.0 | 0.95 | LOW | B4同一パラメータ |

→ Recall最高の条件を「最適条件」として選定

### Phase 2: 最適条件を全データセットで検証（6データセット）

| データセット | レコード数 | 陽性率 | 既存B4 Recall |
|---|---|---|---|
| cq1 | 5,628 | 2.01% | 0.99 |
| cq2 | 3,400 | 0.50% | 1.00 |
| cq3 | 1,038 | 1.54% | 1.00 |
| cq4 | 4,326 | 1.66% | 1.00 |
| cq5 | 2,253 | 1.82% | 0.98 |
| wilson | 3,453 | 5.04% | ラベル修正後に初測定 |

## Wilson データセット前処理

**問題**: `wilson_tiab_labeled.json` のラベルフィールドが `label_tiab` / `label_final_included`。
runner が認識する `label_included` / `label` にマッチしない → 全件 label=0 扱いで TP=0, FN=0 だった。

**解決**: runner.ts のフィールド正規化で `label_tiab` も認識する。

```typescript
// 修正: label_tiab を認識
label_included: ((r.label_included ?? r.label_tiab ?? r.label ?? 0) as number),
```

TiAbスクリーニング文脈では `label_tiab`（TiAb通過=1, 174件/3453件）を使用。
`label_final_included`（最終採用=26件）はフルテキスト審査後の基準なのでTiAbレベルでは不適切。

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall) | ★最重要 | ≥ 0.95 |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | ≥ 0.93 |
| 処理時間 (ms/件) | 参考 | — |
| 成功率 | 参考 | ≥ 99% |

## 判断基準

- 最適条件 Recall ≥ 0.95 → デフォルト切り替え候補
- 最適条件 Recall 0.93-0.95 → フォールバック枠として検討
- 最適条件 Recall < 0.93 → 現行構成維持

## 実行コマンド

```bash
# Phase 1: depression で最適条件探索
npx ts-node --project experiments/gemini-3.1-flash-lite/tsconfig.json experiments/gemini-3.1-flash-lite/run_phase1.ts

# Phase 2: 最適条件を全データセットで検証（例: C4が最適の場合）
npx ts-node --project experiments/gemini-3.1-flash-lite/tsconfig.json experiments/gemini-3.1-flash-lite/run_phase2.ts --condition C4

# サマリー生成
npx ts-node --project experiments/gemini-3.1-flash-lite/tsconfig.json experiments/gemini-3.1-flash-lite/summarize.ts
```

## ソースコード

- `runner.ts` — 実験ランナー（本フォルダ内）
- `run_phase1.ts` — Phase 1 一括実行
- `run_phase2.ts` — Phase 2 一括実行
- `summarize.ts` — 結果サマリー生成
- `config.json` — 実験条件定義

## 元データ

- データセット: `scripts/asreview-baseline/datasets/` 配下
- 既存実験結果: `experiments/report.md`, `experiments/report_verification.md`
