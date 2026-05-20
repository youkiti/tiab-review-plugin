# 実験計画: gemini-3.5-flash

## コンテキスト

2026-05 リリースの `gemini-3.5-flash` は、Thinking 対応 Flash モデルの後継。
公式公表値で **入力 $1.50 / 出力 $9.00 (思考トークン含む)** と高価格帯。
リーダーボードへの追加可否を判定するため、B シリーズ（B4 = `gemini-3-flash-preview`, Recall 96.1%）と同じ thinking_level マトリクスで再評価する。

**RQ1**: B4 と同等以上の depression Recall (≥0.95) を達成できるか？
**RQ2**: コスト（$/1K件）は B4 と比較して許容範囲か？
**RQ3**: thinking_level=HIGH で MAX_TOKENS 切り詰めが頻発しないか？

## 比較対象

| モデル | 由来 | depression Recall | 備考 |
|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | `experiments/report.md` | 0.961 | 現行精度枠 |
| GA C1 (`gemini-3.1-flash-lite`) | `experiments/gemini-3.1-flash-lite-ga/report.md` | 0.936 | 現行デフォルト |
| **`gemini-3.5-flash`** | 今回 | TBD | |

## 実験設計

### Phase 1 のみ: depression × 3 条件（D4=HIGH は除外、Phase 2 は実施しない）

TopP 0.95 / Temp 1.0 固定、thinking_level のみ振る。B シリーズで TopP 0.65 が劣勢と確認済みのため除外。

| 条件 | thinking_level | maxOutputTokens | B シリーズ相当 | 備考 |
|---|---|---|---|---|
| D1 | LOW | 8,192 | B4 | |
| D2 | MINIMAL | 4,096 | B2 | |
| D3 | MEDIUM | 16,384 | B6 | |
| ~~D4~~ | ~~HIGH~~ | ~~32,768~~ | ~~B8~~ | **除外**: 疎通確認で $104/データセット と判明、コスト過大（2026-05-20 判断） |

`maxOutputTokens` は thinking_level に応じて段階的に設定。thinking tokens は出力枠を消費するため、MEDIUM では十分余裕を持たせる。

### MAX_TOKENS 切り詰め対策（コード側改修）

1. **`src/lib/gemini-api.ts`**: ストリーミング応答から `finishReason` を抽出し、`MAX_TOKENS` を検出したら `code='max_tokens_truncated'` の専用エラー（retryable=false）を投げる。
2. **`src/lib/llm-processor.ts`**: 上記コードを受け取ったら即座にフォールバック処理へ（無駄な指数バックオフを回避）。フォールバックは include_probability=1.0 = include 扱いで記録。
3. **集計**: フォールバック件の中で MAX_TOKENS 起因の件数を別途集計し、レポートに明示。

## 評価指標

| 指標 | 重要度 | 目標 |
|---|---|---|
| Sensitivity (Recall@0.5) | ★最重要 | ≥ 0.95 |
| Precision | 参考 | — |
| Fβ(β=7) | 参考 | ≥ 0.93 |
| 処理時間 (ms/件) | コスト評価 | — |
| **$/1K件** | ★新規追加 | B4 比 ≤ 5倍 |
| MAX_TOKENS 切り詰め率 | 信頼性 | ≤ 5% |

## 判断基準

| Recall | B4比コスト | 結論 |
|---|---|---|
| ≥ 0.96 | ≤ 2倍 | デフォルト切替候補 |
| ≥ 0.95 | 2–5倍 | UI公開（上位互換枠） |
| ≥ 0.95 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.93–0.95 | — | フォールバック検討 |
| < 0.93 | — | 現行維持 |

## 実行コマンド

```bash
# 疎通確認 (depression 50件, D1)
npx ts-node --project experiments/gemini-3.5-flash/tsconfig.json \
  experiments/gemini-3.5-flash/runner.ts --dataset depression --condition D1 --tier tier_smoke --sample 50

# 疎通確認 (D1-D4 すべて、サンプル 50件)
npx ts-node --project experiments/gemini-3.5-flash/tsconfig.json \
  experiments/gemini-3.5-flash/run_phase1.ts --sample 50 --tier tier_smoke

# Phase 1 本実行 (D1-D4 全件)
npx ts-node --project experiments/gemini-3.5-flash/tsconfig.json \
  experiments/gemini-3.5-flash/run_phase1.ts

# サマリー
npx ts-node --project experiments/gemini-3.5-flash/tsconfig.json \
  experiments/gemini-3.5-flash/summarize.ts
```

## コスト見積もり

- depression 1,993件 × 3条件 ≈ 6,000リクエスト
- 50件疎通確認の実測トークンから外挿:
  - D1 (LOW): 約 $17.7
  - D2 (MINIMAL): 約 $3.8
  - D3 (MEDIUM): 約 $61.4
  - 合計: **約 $83**（D4=HIGH を除外したため）

## ソースコード

- ランナー: [runner.ts](runner.ts)
- Phase 1: [run_phase1.ts](run_phase1.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 既存実験: `experiments/report.md`、`experiments/gemini-3.1-flash-lite-ga/report.md`
