# gpt-5.6-luna ベンチマーク結果

**depression データセット (1,993件 / 陽性 280件) での reasoning_effort 比較。**
探索軸は reasoning_effort (none/low/medium/high)。verbosity=low 固定、temperature/top_p は送信不可。
既存 B4 ベースライン (`gemini-3-flash-preview`, thinkingLevel=LOW) を基準とする。

## 全件 (N=1,993) ベンチマーク比較

| 条件 | Model | effort | Recall | Specificity | Precision | Fβ(7) | TP | FP | TN | FN | 時間(s) | コスト(USD) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **B4** (既存記録) | gemini-3-flash-preview | LOW | **96.1%** | 86.3% | 53.4% | 95.2% | 269 | 235 | 1478 | 11 | - | - |
| G56-low | gpt-5.6-luna | low | **91.4%** | 89.2% | 58.0% | 90.4% | 256 | 185 | 1528 | 24 | 644 | $4.547 |
| G56-med | gpt-5.6-luna | medium | **91.4%** | 91.7% | 64.3% | 90.7% | 256 | 142 | 1571 | 24 | 1140 | $7.678 |
| G56-none | gpt-5.6-luna | none | **92.9%** | 84.3% | 49.1% | 91.2% | 260 | 269 | 1444 | 20 | 515 | $3.732 |

## トークン消費 / レイテンシ (N=1,993)

| 条件 | 1件平均(ms) | prompt | cached | completion | reasoning | 失敗 |
|---|---|---|---|---|---|---|
| G56-low | 323 | 1900027 | 2398 | 441587 | 166837 | 0 |
| G56-med | 572 | 1899202 | 0 | 963092 | 728287 | 0 |
| G56-none | 258 | 1899202 | 3449 | 305905 | 0 | 0 |

## 採用判断

- ✅ Recall ≥ 95% かつ Precision または コスト or レイテンシで B4 を上回るモデルを採用候補とする
- ⚠️ Recall 93-95% はフォールバック / 予算オプションとして残す
- ❌ Recall < 93% は採用しない

## 結論・考察（2026-07-10）

**結論: gpt-5.6-luna は現行設定では depression スクリーニングで B4 を置き換える性能に達しない（採用見送り）。**

- 全3条件とも **Recall が採用基準 95% に未達**（none 92.9% / low 91.4% / medium 91.4%）で、B4（96.1%）を下回る。
- **reasoning_effort を上げても Recall は改善しない**。none → low/medium で Recall はむしろ微減（92.9% → 91.4%）。取りこぼし（FN）は none 20件 → low/medium 24件と増加。
- 一方で **Precision と Specificity は effort とともに改善**（Precision 49.1% → 58.0% → 64.3%）。reasoning は「除外方向」に判断を寄せるため、感度最優先のスクリーニング用途とは相性が悪い。
- **コスト**は none $3.73 / low $4.55 / medium $7.68（3条件合計 ≈ $16、失敗0件）。medium は reasoning トークン 728k で最も高価。
- **high（reasoning_effort=high）は未実行（保留）**。上記の単調傾向（effort↑で Recall 改善せず）から high でも Recall 改善は期待薄。確定には実行が必要（疎通実測で全件換算 ≈ $22）。

### threshold スイープ（[threshold_sweep.md](threshold_sweep.md) / API 追加コストなし）

出力確率が両極端に偏る（大半が <0.1 か ≥0.9）ため閾値の効きは限定的だが、境界は動く:

| 条件 | thr | Recall | Precision | Specificity | FN |
|---|---|---|---|---|---|
| **B4**（基準） | 0.50 | 96.1% | 53.4% | 86.3% | 11 |
| G56-none | 0.05 | **95.7%** ✅ | 38.3% | 74.8% | 12 |
| G56-low | 0.05 | **95.4%** ✅ | 47.5% | 82.8% | 13 |
| G56-med | 0.05 | 94.6% | 58.2% | 88.9% | 15 |

- **閾値 0.05 で none / low は Recall 95% を超える**が、Precision が大きく低下し、**同じ Recall 帯で B4 に劣る**（B4 は Recall 96.1% で Precision 53.4%）。
- **med は 0.05 でも Recall 94.6%**（TP 265、95% ライン=266 にあと1本）。ただし Precision 58.2% / Specificity 88.9% は B4 超で「高精度・予算枠」候補になり得る。
- 取りこぼし（FN）は確率 <0.05 の確信を持った誤りが中心で、閾値では救えない。
- **総合判定は変わらず**: 閾値調整でも gpt-5.6-luna は B4 を Recall・Precision 両面で上回れない。

### 補足
- **プロンプトキャッシュはほぼ効かず**（cached ≈ 0 / prompt ≈ 1.9M）。並列実行で同一接頭辞のヒットが分散したためと推測。コスト削減には Batch API（-50%）や逐次実行での共通接頭辞キャッシュが有効。
- **残る改善余地**: ①screening prompt の感度強化（<0.05 の hard miss を減らす）②上位ティア（Terra / Sol）③high effort の実行。

### 成果物・ソース
- 計画: [plan.md](plan.md) / 設定: [config.json](config.json) / ランナー: [runner.ts](runner.ts)
- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`（N=1,993 / 陽性280）
- 生ログ・per-item トークン: `experiments/gpt-5.6/results/`（cost は生トークンから再計算可能）
