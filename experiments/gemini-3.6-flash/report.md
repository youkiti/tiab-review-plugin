# 実験レポート: gemini-3.6-flash

**実施日**: 2026-07-22
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — [experiments/report.md](../report.md)（現行精度枠のチャンピオン）
- gemini-3.5-flash（最良 D2, Recall 93.2%）— [experiments/gemini-3.5-flash/report.md](../gemini-3.5-flash/report.md)（直前の同格モデル、却下済み）
- 現行デフォルト `gemini-3.1-flash-lite`（[src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `DEFAULT_MODEL_CONFIG`, Recall 93.6%）

## 1. 目的

2026-07 リリースの `gemini-3.6-flash` がリーダーボードに追加可能か（B4 を上回るか）を検証する。
公式価格（ユーザー提供, 2026-07-22）は **入力 $1.50 / 出力 $7.50 (思考トークン含む) / 1M tokens**。前世代 `gemini-3.5-flash`（入力 $1.50 / 出力 $9.00）から出力単価が引き下げられており、コスト面での期待もあった。

**RQ1**: depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: $/1K件は B4 の ~$1.70 と比較して許容範囲か？

## 2. 実験設計

depression データセット (n=1,993, 陽性 280件) で thinking_level マトリクスを比較。
TopP 0.95 / Temp 1.0 固定、`thinking_level` のみ変動。

| 条件 | thinking_level | maxOutputTokens | 備考 |
|---|---|---|---|
| D1 | LOW | 8,192 | B4 相当 |
| D2 | MINIMAL | 4,096 | |
| D3 | MEDIUM | 16,384 | |
| D4 | HIGH | 32,768 | 既定で `excludedConditions`。ただし新モデルのため疎通確認は実施 |

threshold は全条件で 0.5 固定。実行ルールは「疎通確認 (n=50, tier_smoke) → 実測コストを全件 (1,993件) に外挿 → $20 未満ならフル実行 (tier_max)、$20 以上ならフル実行せず smoke 実測値のみで記録」。

### 小さな実装追加: `excludedConditions` からの疎通確認対応

`gemini-3.5-flash` 版の `runner.ts` は条件 ID を `config.conditions` からのみ検索していたため、既定除外 (D4) の疎通確認ができなかった。
本実験では [runner.ts](runner.ts) の条件解決ロジックに `config.excludedConditions` へのフォールバック検索を追加し、除外条件でも疎通確認を実行できるようにした（フル実行対象は変わらず `conditions` 配列のみ）。コスト集計 (`UsageAggregate`/`CostEstimate`/`aggregateUsage`/`estimateCost`) のロジック自体は `gemini-3.5-flash` 版から変更なし。

## 3. Phase 1 結果 (depression, n=1,993, 陽性 280件)

| 条件 | thinking | Temp | TopP | maxOut | Recall | Precision | Fβ(7) | TP | FP | TN | FN | 時間(s) | $/1K件 | 総コスト | 実行規模 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D1 | LOW | 1.0 | 0.95 | 8,192 | **94.6%** | 49.6% | 93.0% | 265 | 269 | 1,444 | 15 | 61 | $1.70 | $3.39 | フル (1,993件) |
| D2 | MINIMAL | 1.0 | 0.95 | 4,096 | **94.3%** | 51.7% | 92.8% | 264 | 247 | 1,466 | 16 | 59 | $1.66 | $3.31 | フル (1,993件) |
| **B4 (参考)** | LOW | 1.0 | 0.95 | - | **96.1%** | 53.4% | 95.0% | 269 | 235 | 1,478 | 11 | - | ~$1.70 | - | - |
| GA C1 (参考, 現行デフォルト) | - | 0 | - | - | **93.6%** | 61.6% | 92.6% | 262 | 163 | 1,550 | 18 | - | ~$0.30 | - | - |

### 疎通確認のみで除外された条件 (n=50, 統計的有意性なし)

| 条件 | thinking | n | Recall | $/1K件 (実測) | 総コスト (n=50実測) | 外挿コスト (1,993件) | 判定 |
|---|---|---|---|---|---|---|---|
| D3 | MEDIUM | 50 | 100.0% | $22.82 | $1.14 | **約 $45** | $20 閾値超過のためフル実行せず除外 |
| D4 | HIGH | 50 | 100.0% | $39.70 | $1.99 | **約 $79** | $20 閾値超過のためフル実行せず除外（既定除外の判断を追認） |

**Phase 1 実コスト合計: $9.99**（内訳: D1 smoke $0.08 + D1 full $3.39 + D2 smoke $0.08 + D2 full $3.31 + D3 smoke $1.14 + D4 smoke $1.99）

## 4. 分析

### 4.1 Recall は B4 に届かないが、前世代 gemini-3.5-flash よりは大幅改善

最良条件の D1 (LOW) で Recall 94.6%、B4 (96.1%) に **-1.5pp**。
前世代 `gemini-3.5-flash`（最良 D2, MINIMAL: 93.2%）比では **+1.4pp** と明確に改善しており、モデル世代交代による精度向上は確認できた。ただし現行デフォルト `gemini-3.1-flash-lite`（93.6%）との比較でも D1 は +1.0pp とわずかに上回るのみで、B4 パリティ (≥0.95) には届かなかった。

### 4.2 thinking_level を上げるとコストが跳ね上がる傾向は前世代と同様

| thinking_level | Recall (smoke n=50 / full) | 思考トークン/件 (平均, smoke) | $/1K件 |
|---|---|---|---|
| MINIMAL (D2) | 100.0% (smoke) / 94.3% (full) | 0 | $1.66 |
| LOW (D1) | 100.0% (smoke) / 94.6% (full) | 約 1 (ほぼ0) | $1.70 |
| MEDIUM (D3) | 100.0% (smoke, n=50のみ) | 約 2,844 | $22.82 (除外) |
| HIGH (D4) | 100.0% (smoke, n=50のみ) | 約 5,084 | $39.70 (除外) |

MEDIUM・HIGH は思考トークンが急増し、$20/データセット の閾値を大きく超過（それぞれ約$45, 約$79）。この傾向は `gemini-3.5-flash`（HIGH で $104/データセット）と同じ形状であり、新モデルでも thinking_level を上げるコストペナルティは解消されていない。むしろ出力単価が下がった（$9.00→$7.50/MTok）にもかかわらず、MEDIUM/HIGH の絶対思考トークン数自体が増えているため、外挿コストは `gemini-3.5-flash` の D3実測（$63/データセット, MEDIUM）と比べても同程度〜やや高い水準になっている。
smoke (n=50) はサンプルサイズが小さく統計的有意性はないため、D3/D4 の Recall 100% は参考値に留める。

### 4.3 コスト面はB4とほぼ同水準、GA C1には見劣り

最良の D1 で $1.70/1K件、B4 推定 ($1.70/1K件) と**ほぼ同一（比率 1.0倍）**。
現行デフォルト GA C1 ($0.30/1K件) と比較すると約5.7倍のコスト増であり、コスト面での優位性はない。

### 4.4 MAX_TOKENS 切り詰めは全条件で0件

`gemini-3.5-flash` で実装した MAX_TOKENS 検出・即時フォールバック機構により、本実験でも全条件 (D1, D2, smoke含むD3, D4) で **MAX_TOKENS切り詰め 0件** を確認。`maxOutputTokens` の段階設定は今回のモデルでも妥当だった。

## 5. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.96 & B4比コスト ≤ 2倍 → デフォルト切替 | ❌ 未達 (最良 D1: Recall 94.6%) |
| Recall ≥ 0.95 & コスト 2–5倍 → UI公開 | ❌ 未達 (Recallが0.95に届かず) |
| Recall ≥ 0.95 & コスト > 5倍 → 実験記録のみ | ❌ 該当なし |
| Recall 0.93–0.95 → フォールバック候補 | ✅ **該当** (D1: Recall 94.6%, B4比コスト 1.0倍) |
| Recall < 0.93 → 現行維持（却下） | ❌ 該当なし |

**判定: フォールバック候補（採用は保留、UI公開・デフォルト切替は見送り）**

- 最良条件 D1 (LOW, maxOutputTokens 8,192) は depression Recall **94.6%**、B4比コスト **1.0倍**。
- B4 (96.1%) には届かないが、前世代 `gemini-3.5-flash`（93.2%、却下済み）より明確に改善しており、モデル世代としての精度向上は確認された。
- 現行デフォルト GA C1 (`gemini-3.1-flash-lite`, 93.6%) をわずかに上回るが、コストは約5.7倍と大幅増であり、単純な入れ替え候補にはならない。
- D3 (MEDIUM) / D4 (HIGH) は疎通確認の時点でそれぞれ約$45・約$79/データセットと判明し、$20 閾値超過のためフル実行を見送った。既定除外 (D4) の判断は実測でも裏付けられた。

**推奨**:
- **UI公開・デフォルト切替は見送り**（[src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `AVAILABLE_MODELS` / `DEFAULT_MODEL_CONFIG` への追加は本タスクの範囲外。この結果を踏まえた最終判断はプロジェクトオーナーが別途行う）
- 実験記録は本レポートで残し、`gemini-3.6-flash` のマイナーアップデートや `thinking_level` 以外のパラメータ探索（例: プロンプト改善との組み合わせ）で再評価する余地あり
- リーダーボード（[README.md](../../README.md)）への追記は本タスクの範囲外のため実施しない

## 6. ソースコード・元データ

- 実験計画: [plan.md](plan.md)
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- 結果サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下
- 元データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md) (B4)、[experiments/gemini-3.5-flash/report.md](../gemini-3.5-flash/report.md) (前世代・却下事例)
