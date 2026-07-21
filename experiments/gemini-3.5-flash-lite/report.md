# 実験レポート: gemini-3.5-flash-lite

**実施日**: 2026-07-22
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — [experiments/report.md](../report.md)
- GA C1 (`gemini-3.1-flash-lite`, Temp 0, 現行の本番デフォルト) — [experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md)

## 1. 目的

2026-07 に登場した Lite階層の新モデル `gemini-3.5-flash-lite` を評価する。
公式価格（ユーザー提供, 2026-07-22）は **入力 $0.30 / 出力 $2.50 (思考トークン含む) / 1M tokens** で、
現行デフォルト `gemini-3.1-flash-lite` (GA) と同水準の低価格帯にある。

**RQ1**: `gemini-3.5-flash-lite` は現行の本番デフォルト `gemini-3.1-flash-lite` (GA C1, depression Recall 93.6%, 約$0.30/1K件) を上回るか？
**RQ2**: B4 (`gemini-3-flash-preview`, Recall 96.1%) に近づけるか？

## 2. 実験設計

depression データセット (n=1,993, 陽性280件) のみで、Lite階層の定番4条件マトリクスを比較
(プロジェクトオーナーの指示により、本ラウンドは depression 単独。cq1-5/wilson は対象外)。
threshold は全条件 0.5 固定。

| 条件 | Temp | TopP | Thinking |
|---|---|---|---|
| C1 | 0.0 | — | なし |
| C2 | 1.0 | 0.95 | なし |
| C3 | 1.0 | 0.95 | MINIMAL |
| C4 | 1.0 | 0.95 | LOW |

各条件は「疎通確認 (n=50, tier_smoke) → コスト試算 → フル実行 (n=1,993, tier_max)」の順で実行。
全条件でフル実行コスト試算 (`totalUSD / 50 * 1993`) が $1 未満と判明し、$20 の閾値を大きく下回ったため、C1〜C4 すべてフル実行を完了した。

## 3. 結果 (depression, n=1,993, 陽性280件)

| 条件 | Temp | TopP | Thinking | Recall | Precision | Fβ(7) | TP | FP | TN | FN | フォールバック | MAX_TOK | 時間(s) | $/1K件 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 | 0 | - | - | **89.6%** | 64.4% | 88.9% | 251 | 139 | 1574 | 29 | 0 | 0 | 20 | $0.43 |
| C2 | 1.0 | 0.95 | - | **90.0%** | 65.3% | 89.3% | 252 | 134 | 1579 | 28 | 0 | 0 | 12 | $0.43 |
| C3 | 1.0 | 0.95 | MINIMAL | **90.4%** | 64.7% | 89.6% | 253 | 138 | 1575 | 27 | 0 | 0 | 50 | $0.43 |
| **C4** | 1.0 | 0.95 | LOW | **91.8%** | 64.4% | 91.0% | 257 | 142 | 1571 | 23 | 0 | 0 | 10 | $0.41 |
| B4 (参考) | 1.0 | 0.95 | LOW | **96.1%** | 53.4% | 95.0% | 269 | 235 | 1478 | 11 | - | - | - | $1.70 (推定) |
| GA C1 (参考, 現行デフォルト) | 0 | - | - | **93.6%** | 61.6% | 92.6% | 262 | 163 | 1550 | 18 | - | - | - | $0.30 (推定) |

**最適条件**: C4 (Temp 1.0 / TopP 0.95 / Thinking LOW)、Recall 91.8%、$0.41/1K件。

**所見**:
- Thinking を強めるほど（なし → MINIMAL → LOW）Recall が単調に改善 (89.6% → 90.0% → 90.4% → 91.8%)。GA版・preview版で観察された「thinking は寄与しない/逆相関」という傾向とは逆で、本モデルでは Thinking LOW が最良かつ最速 (10秒/1,993件)。
- 全条件で MAX_TOKENS 切り詰め・フォールバックは0件。実測トークン内訳では `thoughtsTokenCount` が常に0（Thinking指定時も含む）で、モデル側が明示的な思考トークンを出力していない可能性がある。
- 処理速度は極めて高速（5〜25ms/件）で、GA C1 (約9ms/件) と同等水準。

## 4. 分析

### 4.1 RQ1: 現行デフォルト GA C1 を上回れず

最良条件 C4 の Recall 91.8% は GA C1 (93.6%) を **-1.8pp** 下回った。コストは C4 $0.41/1K件 に対し GA C1 $0.30/1K件で、GA C1 比 約1.36倍。
Recall・コストの両面で現行デフォルトに対する優位性はない。

### 4.2 RQ2: B4 との差は依然大きい

B4 (96.1%) との差は **-4.3pp**。B4 実測コスト推定 ($1.70/1K件) に対しては `gemini-3.5-flash-lite` (C4) は約 **0.24倍** と大幅に安価だが、
Recall 目標 (≥0.95、もしくは採用基準の ≥0.93) に届かないため、コスト優位性だけでは採用理由にならない。

### 4.3 Thinking の効き方が過去の Lite系モデルと逆転

`gemini-3.1-flash-lite` (Preview/GA) や `gemini-3.5-flash` では Thinking を強めると Recall が横ばいまたは悪化する傾向だったが、
`gemini-3.5-flash-lite` では Thinking LOW (C4) が最良となった。ただし絶対値としては GA C1 (Thinkingなし, Temp 0) にまだ届いていない。

### 4.4 コスト面は圧倒的に優位だが、Recall 不足が採用のボトルネック

$0.41〜0.43/1K件 は B4 の 1/4 以下、GA C1 とほぼ同水準。コスト面では魅力的だが、
系統的レビューのスクリーニング用途では Recall（見逃しの少なさ）が最優先指標であり、
現行のFN比率 (23〜29件/280件中、約8〜10%見逃し) は許容できる水準ではない。

## 5. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.96 & B4比コスト ≤ 2倍 → デフォルト切替候補 | ❌ 未達 (最良 91.8%) |
| Recall ≥ 0.95 & コスト 2〜5倍 → UI公開 | ❌ 未達 |
| Recall ≥ 0.95 & コスト > 5倍 → 実験記録のみ | ❌ 未達 |
| Recall 0.93〜0.95 → 現行デフォルトとのフォールバック検討 | ❌ 該当せず (91.8% < 93%) |
| Recall < 0.93 → 却下 | ✅ 該当 (最良 91.8%) |

**`gemini-3.5-flash-lite` は、現時点で systematic review 用途において現行の本番デフォルト `gemini-3.1-flash-lite` (GA) の代替にも上位互換にもならない。**

- 現行デフォルト GA C1 (Recall 93.6%) を全条件で下回る（最良 C4 でも -1.8pp）
- B4 (96.1%) とのギャップは -4.3pp で、依然として大きい
- コストは GA C1 と同水準・B4 の約1/4と非常に安価だが、Recall 不足が採用のボトルネック

## 6. 採用判断

**却下 (Reject)。** `src/lib/gemini-api.ts` の `AVAILABLE_MODELS` / `DEFAULT_MODEL_CONFIG` / `LITE_MODEL_CONFIG` への追加は行わない（本タスクのスコープ外、かつ数値的にも採用基準を満たさない）。
本レポートを実験記録として残し、将来モデル更新時に再評価する。

## 7. ソースコード・元データ・実行コスト

- 実験計画: [plan.md](plan.md)
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)（gemini-3.1-flash-lite-ga の引数処理・評価ロジック + gemini-3.5-flash のトークン集計・コスト試算ロジックを移植）
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- 結果サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下
- 元データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md) (B4)、[experiments/gemini-3.1-flash-lite-ga/report.md](../gemini-3.1-flash-lite-ga/report.md) (GA C1)
- **実際のAPI利用コスト（本実験合計）**: 約 $3.48（疎通確認4回 + フル実行4回の合計。内訳は各 `results/experiment_*.log.json` の `cost.totalUSD`）
