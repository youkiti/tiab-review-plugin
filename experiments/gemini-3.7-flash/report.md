# 実験レポート: gemini-3.7-flash

**実施日**: 2026-08-16
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — [experiments/report.md](../report.md)（現行精度枠のチャンピオン、depression Recall 96.1% / $1.70per1K）
- gemini-3.6-flash（最良 D1）— [experiments/gemini-3.6-flash/report.md](../gemini-3.6-flash/report.md)（直前の同格モデル、depression Recall 94.6% / $1.70per1K、フォールバック候補止まり）
- 現行デフォルト `gemini-3.1-flash-lite`（GA C1, [src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `DEFAULT_MODEL_CONFIG`, depression Recall 93.6% / $0.30per1K）

## 1. 目的

`gemini-3.7-flash` がリーダーボードに追加可能か（B4 を上回るか、あるいは前世代 gemini-3.6-flash・現行デフォルト GA C1 を上回るか）を検証する。
公式価格（2026-08-16 時点）は **入力 $0.75 / 出力 $3.75（思考トークン含む）per 1M tokens** — `gemini-3.6-flash`（入力 $1.50 / 出力 $7.50）から**価格が半額**。ただし **2027-01-01 から入力 $1.50 / 出力 $7.50 へ改定予定**であり、価格半額は期間限定。

**RQ1**: depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: $/1K件は B4 の ~$1.70 と比較して許容範囲か？

## 2. 実験設計

depression データセット (n=1,993, 陽性 280件) で thinking_level マトリクスを比較。
TopP 0.95 / Temp 1.0 固定、`thinking_level` のみ変動。

| 条件 | thinking_level | maxOutputTokens | 備考 |
|---|---|---|---|
| E1 | LOW | 8,192 | B4 相当 |
| E2 | MINIMAL | 4,096 | モデル非対応（後述） |
| E3 | MEDIUM | 16,384 | |
| E4 | HIGH | 32,768 | ユーザー判断により今回は実施せず（既定除外。`gemini-3.5-flash` HIGH で $104/データセット・`gemini-3.6-flash` HIGH で約$79/データセットと2世代連続で $20 閾値を大きく超過したため） |

threshold は全条件で 0.5 固定。実行ルールは「疎通確認 (n=50, tier_smoke) → 実測コストを全件 (1,993件) に外挿 → $20 未満ならフル実行 (tier_max)、$20 以上ならフル実行せず smoke 実測値のみで記録」。

## 3. Phase 1 結果 (depression, n=1,993, 陽性 280件)

| 条件 | thinking | maxOut | TP | FP | TN | FN | Recall | Specificity | Precision | Fβ(7) | ms/件 | $/1K件 | 総コスト | 切り詰め |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| E1 | LOW | 8,192 | 254 | 123 | 1,590 | 26 | **90.71%** | 92.82% | 67.37% | 90.09% | 42.6 | $1.239 | $2.470 | 0件 |
| E3 | MEDIUM | 16,384 | 255 | 134 | 1,579 | 25 | **91.07%** | 92.18% | 65.55% | 90.37% | 56.9 | $3.271 | $6.518 | 0件 |
| **B4 (参考)** | LOW | - | 269 | 235 | 1,478 | 11 | **96.1%** | 86.3% | 53.4% | 95.0% | ≈300 | ~$1.70 | - | - |
| gemini-3.6-flash D1 (参考) | LOW | 8,192 | 265 | 269 | 1,444 | 15 | **94.6%** | - | 49.6% | 93.0% | 31 | $1.70 | $3.39 | 0件 |
| GA C1 (参考, 現行デフォルト) | - | - | 262 | 163 | 1,550 | 18 | **93.6%** | - | 61.6% | 92.6% | 9 | ~$0.30 | - | - |

トークン: E1 = prompt 979,459 / candidates 270,353 / thoughts 192,505。E3 = prompt 979,459 / candidates 266,297 / **thoughts 1,275,976**。両条件とも 1,993/1,993 成功・フォールバック0。

### 疎通確認のみ (n=50, tier_smoke、統計的有意性なし)

| 条件 | Recall | Precision | $/1K件 (実測) |
|---|---|---|---|
| E1 | 100.0% | 88.9% | $1.234 |
| E3 | 100.0% | 80.0% | $3.962 |

**Phase 1 実コスト合計: 約 $9.25**（内訳: E1 smoke $0.062 + E3 smoke $0.198 + E1 full $2.470 + E3 full $6.518 + E2 smoke $0）

## 4. 分析

### 4.1 Recall は B4・gemini-3.6-flash・現行デフォルトのいずれにも届かない

最良条件の E3 (MEDIUM) で Recall 91.07%。B4（96.1%）に -5.0pp、前世代 gemini-3.6-flash 最良 D1（94.6%）に -3.5pp、現行デフォルト GA C1（93.6%）にも -2.5pp と、比較対象すべてを下回った。世代交代による精度向上は見られず、むしろ後退している。

### 4.2 Recall は下がったが Precision は大きく上がっている — 判断が除外方向に寄っている

gemini-3.6-flash の Precision 49.6%（D1）に対し、本モデルは E1 で 67.37%、E3 で 65.55% と大幅に改善している。これは「全体として賢くなった」のではなく、**判断が除外（exclude）方向に寄っている**ことの表れであり、感度最優先のスクリーニングという用途とは方向性が合わない。

同じ傾向は [experiments/gpt-5.6/report.md](../gpt-5.6/report.md) でも観測されている（reasoning_effort を none→low/medium に上げると Recall 92.9%→91.4%、Precision 49.1%→64.3%）。今回はモデルの世代交代（`gemini-3.6-flash`→`gemini-3.7-flash`）でも同じ「Recall↓・Precision↑」という形が出ており、reasoning/thinking を強めるチューニングだけでなく、モデル自体の傾向としても再現性のあるパターンであることが示唆される。

### 4.3 thinking_level を上げてもコストに見合うだけの Recall 改善が無い

LOW (E1) → MEDIUM (E3) で Recall は **+0.36pp**（90.71%→91.07%）しか動かない一方、思考トークンは 192,505 → 1,275,976 と**約6.6倍**に増え、$/1K件は $1.239 → $3.271 と**約2.6倍**になっている。thinking を積む費用対効果はほぼ無い。

### 4.4 コスト面は価格半減が効いており、本モデルの数少ない長所

E1 は $1.239/1K件で、B4（~$1.70/1K件）比 **0.73倍**。ただし公式価格は**2027-01-01 に入力 $1.50 / 出力 $7.50 へ改定予定**（`gemini-3.6-flash` の現行価格と同額になる）であり、この優位性は**期間限定（2026-12-31まで）**であることに留意する。改定後は本モデルのコスト優位性は消失する見込み。

### 4.5 MAX_TOKENS 切り詰めは両条件で0件

`maxOutputTokens` の段階設定（E1: 8,192 / E3: 16,384）は妥当で、切り詰めは発生していない。

## 5. E2 (MINIMAL) はモデル非対応 — 独立した落とし穴として記録

`thinking_level: MINIMAL` を指定して `generateContent` を呼ぶと **HTTP 400 `INVALID_ARGUMENT`** が返る。エラーメッセージ原文:

```
Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.
```

コマンダーが `generateContent` を直接叩いて確認済み。同モデルで **LOW / MEDIUM / HIGH はいずれも HTTP 200** が返り、MINIMAL のみ非対応。

**この事実に気づかないまま E2 の疎通確認 (n=50) を実行したため、50件すべてが API エラーとなりフォールバック判定（`include_probability=1.0`、すなわち全件 include）に落ちた。** その結果、見かけ上 **Recall 100% / Precision 16.0%** という数値が出力された。

**この数値は無効であり、「全件失敗」として記録する。** 実際には1件も正常な判定が行われていない。

**検知の手がかり**: フォールバックは安全側（`include_probability=1.0`）に倒すため、全滅すると必ず全件 include となり、母集団の陽性を機械的に100%拾う。したがって **Recall 100% と極端に低い Precision（本件では16.0%、B4の53.4%やE1/E3の65〜67%と比べて明らかに異常）がセットで出た場合は、フォールバック全滅（＝API呼び出し自体が機能していない）を疑う**のが実務上のチェックポイントになる。E2 の疎通確認結果はこの理由でフル実行に進めず、`config.json` の `excludedConditions` へ移した。

## 6. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.96 & B4比コスト ≤ 2倍 → デフォルト切替候補 | ❌ 未達 |
| Recall 0.95–0.96 & コスト ≤ 5倍 → UI公開（上位互換枠） | ❌ 未達 |
| Recall 0.93–0.95 → フォールバック検討 | ❌ 未達 |
| Recall < 0.93 → 現行維持（却下） | ✅ **該当**（最良 E3: Recall 91.07%） |

**判定: 却下（現行維持）**

- 最良条件 E3 (MEDIUM) でも depression Recall **91.07%** に留まり、前世代 `gemini-3.6-flash`（94.6%）はもちろん、現行デフォルト GA C1（`gemini-3.1-flash-lite`, 93.6%）にも届かない。判定表の「Recall < 0.93 → 現行維持」に該当する。
- Precision の大幅改善（49.6%→67.4%）は「判断が除外方向に寄った」ことの裏返しであり、SR スクリーニングの用途（見逃しを避ける）とは相性が悪い。同じ形状のトレードオフは `gpt-5.6` の reasoning_effort 実験でも観測されており、reasoning/thinking を強めるほど Recall が犠牲になる傾向は複数モデルで再現している。
- thinking_level を LOW→MEDIUM に上げてもコストに見合う Recall 改善が無く（+0.36pp に対し思考トークン約6.6倍・コスト2.6倍）、thinking を積む戦略自体が本モデルでは有効でない。
- コスト面の優位（B4比0.73倍）は本モデルの数少ない長所だが、2027-01-01 の価格改定で消える期間限定のもの。
- E4 (HIGH) はユーザー判断により今回は実施していない。E2 (MINIMAL) はモデル非対応のため実行不能（`config.json` の `excludedConditions` へ移動済み）。

**推奨**:
- **UI公開・デフォルト切替は見送り**（[src/lib/gemini-api.ts](../../src/lib/gemini-api.ts) `AVAILABLE_MODELS` / `DEFAULT_MODEL_CONFIG` への追加は行わない）
- リーダーボード（[README.md](../../README.md)）へは参考記録として追記するに留める

## 7. ソースコード・元データ

- 実験計画: [plan.md](plan.md)（末尾に実行結果の追記あり）
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- 結果サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下（`depression_E1_items.jsonl` / `depression_E3_items.jsonl` がフル実行分、`depression_E2_items.jsonl` が E2 の失敗記録、`.bak` は smoke 実行時のスナップショット）
- 元データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md) (B4)、[experiments/gemini-3.6-flash/report.md](../gemini-3.6-flash/report.md) (前世代)、[experiments/gpt-5.6/report.md](../gpt-5.6/report.md) (reasoning↑でRecall↓の同型事例)
