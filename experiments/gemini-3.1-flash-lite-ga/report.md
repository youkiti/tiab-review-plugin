# 実験レポート: gemini-3.1-flash-lite (GA)

**実施日**: 2026-05-15
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — `experiments/report.md`
- Preview (`gemini-3.1-flash-lite-preview`, 4 条件) — `experiments/gemini-3.1-flash-lite/report.md`

## 1. 目的

2026-05 に GA リリースされた `gemini-3.1-flash-lite` (preview suffix なし) が、preview 版 (2026-03 評価) と比較して改善しているかを検証する。
preview 版では C1 Recall 92.9% で B4 (96.1%) より -3.2pp 低下し、デフォルト切替は見送られていた。

## 2. 実験設計

Preview 版と同じ 2 段階構造で再評価:

- **Phase 1**: depression × 4 条件 (C1: temp 0 / C2: temp 1 / C3: temp 1 + Thinking MINIMAL / C4: temp 1 + Thinking LOW)
- **Phase 2**: Phase 1 で最良の条件を cq1 / cq2 / cq3 / cq4 / cq5 / wilson の 6 データセットへ適用

threshold は全条件で 0.5 固定。

## 3. Phase 1 結果 (depression, n=1993, 陽性 280 件)

| 条件 | Temp | TopP | Thinking | Recall | Precision | Fβ(7) | TP | FP | TN | FN | 時間(s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **C1** | 0 | - | - | **93.6%** | 61.6% | 92.6% | 262 | 163 | 1550 | 18 | 18 |
| C2 | 1.0 | 0.95 | - | 93.2% | 62.1% | 92.3% | 261 | 159 | 1554 | 19 | 19 |
| C3 | 1.0 | 0.95 | MINIMAL | 92.9% | 62.2% | 92.0% | 260 | 158 | 1555 | 20 | 19 |
| C4 | 1.0 | 0.95 | LOW | 91.1% | 63.9% | 90.3% | 255 | 144 | 1569 | 25 | 301 |
| Preview C1 (参考) | 0 | - | - | 92.9% | 62.4% | 92.0% | 260 | 157 | 1556 | 20 | 30 |
| **B4 (参考)** | 1.0 | 0.95 | LOW | **96.1%** | 53.4% | 95.0% | 269 | 235 | 1478 | 11 | — |

**最適条件**: C1 (Recall 93.6%)。

**所見**:
- Preview 版同様 4 条件すべてで Recall < 95%。B4 比 -2.5pp。
- 一方、Preview C1 比では **+0.7pp** の改善 (92.9% → 93.6%)。
- Thinking を入れた C3 / C4 は Preview と同じく寄与せず、特に C4 (LOW) は処理時間が約 16 倍 (19s → 301s) に増えた割に Recall は最低 (91.1%)。
- 速度: C1〜C3 は約 18–19 秒で 1,993 件を処理 (≈10ms/件)。Preview 版 (30 秒) より高速化。

## 4. Phase 2 結果 (最適条件 C1 × 6 データセット)

| データセット | n | 陽性 | C1 Recall | C1 Precision | TP | FP | TN | FN | Preview C1 Recall | B4 Recall | GA−B4 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| depression | 1,993 | 280 | **93.6%** | 61.6% | 262 | 163 | 1,550 | 18 | 92.9% | 96.1% | -2.5pp |
| cq1 | 5,628 | 113 | **83.2%** | 4.1% | 94 | 2,172 | 3,343 | 19 | 85.0% | 99.1% | **-15.9pp** |
| cq2 | 3,400 | 17 | **100.0%** | 1.6% | 17 | 1,018 | 2,365 | 0 | 100.0% | 100.0% | 0.0pp |
| cq3 | 1,038 | 16 | **87.5%** | 3.7% | 14 | 362 | 660 | 2 | 87.5% | 100.0% | **-12.5pp** |
| cq4 | 4,326 | 72 | **98.6%** | 7.3% | 71 | 895 | 3,359 | 1 | 98.6% | 100.0% | -1.4pp |
| cq5 | 2,253 | 41 | **97.6%** | 17.9% | 40 | 184 | 2,028 | 1 | 97.6% | 97.6% | 0.0pp |
| wilson | 3,451 | 173 | **45.7%** | 15.3% | 79 | 439 | 2,839 | 94 | 45.7% | N/A | N/A |

### Recall の Preview vs GA 比較

| データセット | Preview C1 | GA C1 | Δ |
|---|---|---|---|
| depression | 92.9% | 93.6% | **+0.7pp** |
| cq1 | 85.0% | 83.2% | -1.8pp |
| cq2 | 100.0% | 100.0% | 0.0pp |
| cq3 | 87.5% | 87.5% | 0.0pp |
| cq4 | 98.6% | 98.6% | 0.0pp |
| cq5 | 97.6% | 97.6% | 0.0pp |
| wilson | 45.7% | 45.7% | 0.0pp |

→ depression 以外はほぼ同等。GA 版は preview 版とほぼ同じ判定挙動。

## 5. 分析

### 期待された GA 改善は乏しい

preview 版の弱点 (低 prevalence データセットでの Recall 低下、wilson の研究デザイン判定難) は GA 版でも未解決。
depression での +0.7pp はノイズ域に近く、判定能力に本質的な改善はない。

### B4 とのギャップは依然大きい

低 prevalence の cq1 (-15.9pp) / cq3 (-12.5pp) は systematic review の用途で許容困難。
B4 は陽性に高確率 (>0.8) を割り当てる傾向が強く、threshold 0.5 固定で頑健。GA Flash Lite は中間帯 (0.3–0.7) に集中するため threshold 付近で滑る挙動も preview と同じ。

### 速度・コスト面

- 1,993 件を 18 秒で処理 (Preview の 30 秒、B4 推定 600 秒に対し優位)。
- Thinking LOW (C4) は精度面の利得なく、時間コストのみ増加するため不採用が妥当。

## 6. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.95 → デフォルト切り替え | ❌ 未達 (最良 93.6%) |
| Recall 0.93–0.95 → フォールバック枠 | ⚠️ 該当 (93.6%) |
| Recall < 0.93 → 現行構成維持 | — |

**`gemini-3.1-flash-lite` (GA) は、依然として systematic review 用途で B4 (`gemini-3-flash-preview`) の代替にはならない。**

- preview 比で改善はわずか (+0.7pp@depression、他はほぼ不変)
- 低 prevalence データセット (cq1 / cq3) で B4 比 -10pp 超の Recall 低下
- wilson の研究デザイン判定能力は preview と同水準で不十分

**推奨**: 現行デフォルト `gemini-3-flash-preview` (B4) を維持。GA 版は **コスト優位なフォールバック・廉価枠** として位置づけ、将来的に Recall 改善が確認された時点で再評価する。

## 7. ソースコード・元データ

- 実験計画: [plan.md](plan.md)
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)
- Phase 1 実行: [run_phase1.ts](run_phase1.ts)
- Phase 2 実行: [run_phase2.ts](run_phase2.ts)
- 結果サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下
- 元データセット: `scripts/asreview-baseline/datasets/`
- 比較対象: `experiments/report.md` (B4)、`experiments/gemini-3.1-flash-lite/report.md` (Preview)
