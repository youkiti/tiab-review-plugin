# 実験レポート: qwen/qwen3.8-27b (OpenRouter)

**実施日**: 2026-08-16
**実験者**: Claude Code (自動実行)
**比較対象**:
- B4 (`gemini-3-flash-preview`, TopP 0.95, Think LOW) — [experiments/report.md](../report.md)（現行精度枠のチャンピオン、depression Recall 96.1% / $1.70per1K）
- `qwen/qwen3-235b-a22b-2507`（Instruct, 非thinking）— [experiments/openrouter-bench/report.md](../openrouter-bench/report.md)（先行評価、depression Recall 93.9% / Precision 47.9% / $0.07per1K、フォールバック枠止まり）

## 1. 目的

2026-08-14 にリリースされた `qwen/qwen3.8-27b`（OpenRouter 経由、配信プロバイダ AkashML, quantization bf16）が、現行 Gemini ベースの TiAb スクリーニングの代替・拡張として有用かを定量的に判断する。

**RQ1**: depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: 非thinking (Q1) と reasoning=low (Q2) で Recall・コスト・レイテンシがどう変わるか？
**RQ3**: レイテンシは実運用（並列スクリーニング）に耐えるか？

## 2. 実験設計

depression データセット (n=1,993, 陽性 280件) で以下2条件を比較。

| ID | Temperature | TopP | Reasoning | 備考 |
|---|---|---|---|---|
| Q1 | 0 | - | `enabled: false`（非thinking） | 主軸条件 |
| Q2 | 1.0 | 0.95 | `effort: low` | smoke → コストゲート判定してからフル実行 |

判定基準（[experiments/openrouter-bench/plan.md](../openrouter-bench/plan.md) の基準を踏襲）:
- **採用候補**: Recall ≥ 0.95 かつ、Precision・コスト・レイテンシのいずれかで B4 を上回る
- **フォールバック枠**: Recall 0.93–0.95
- **不採用**: Recall < 0.93

## 3. Q1 (非thinking, Temp 0) フル実行 — 最終確定値

depression 全1,993件で実行し確定した最終値:

| 指標 | 値 |
|---|---|
| TP / FP / TN / FN | 238 / 85 / 1,628 / 42 |
| Recall (Sensitivity) | **85.00%** |
| Specificity | 95.04% |
| Precision | 73.68% |
| Fβ(7) | 84.74% |
| tokens (prompt / completion / reasoning) | 1,304,135 / 392,703 / **0**（thinking無効化が効いていることの実証） |
| コスト | $1.8435（$0.925 per 1K件） |
| 完走 | 1,993/1,993 に判定あり、未解決エラー0件 |

疎通確認 (n=50, 統計的有意性なし): Recall 87.5% / Precision 100% / $0.874per1K / 実時間1.0分。

## 4. 429 エラーと再開機能による解消

**Q1 の初回パスは 1,993件中82件（4.1%）が HTTP 429 で失敗した**（全82件が `OpenRouter API error 429: Provider returned error`）。Phase 0 の疎通確認（n=50）では429ゼロだったが、1,993件の連続実行では配信プロバイダ AkashML が絞ってくることが実測で判明した。

[runner.ts](runner.ts) の中断耐性の再開機能（`results/depression_Q1_items.jsonl` から成功済み ref_id をスキップし、未処理分だけ再試行する仕組み）で、未処理82件だけを再試行して解消した（実行ログに「再開: 既存JSONLから1911件をスキップ (未処理 82/1993件)」の記録あり）。上記§3の確定値はこの再試行後のもの。

**初回パス単独の数値（Recall 84.8% 相当・失敗82件）は、429による取りこぼしで Recall が過小評価されていた値であり、参考にしない。**

**教訓**: `config.json` の `rateLimits.openrouter_akashml`（concurrency 25, delayBetweenRequests 0）は、疎通確認（n=50）では429を出さなかったが、1,993件級の連続実行には強気すぎる設定だった。今回は再開機能で解消できたが、より安全なプロファイル `openrouter_akashml_safe`（concurrency 10, delayBetweenRequests 200）を新設した（詳細は §7）。

## 5. Q2 (reasoning=low) — 中断（理由はスループット、コストではない）

Q2 は 50件中 **48件で中断**した。

- **中断理由はスループット**。50件のうち終盤が極端に失速し、44件→47件に9分かかった。開始から15分で47件しか進まず、全1,993件に外挿すると**約12時間**の見込みとなり、実行が現実的でないと判断してユーザー指示で停止した。
- **コストは中断理由ではない**: 部分実測 n=48 で prompt 33,076 / completion 66,804 / **reasoning 40,220**（838トークン/件）、コスト $0.2287 = **$4.76 per 1K件 → 全件外挿 $9.49** であり、$20 ゲート自体は通過していた。
- n=48 の部分データは [results/depression_Q2_items.jsonl](results/depression_Q2_items.jsonl) に保全済み。**統計的有意性はないため精度の主張には使わない。**

## 6. 分析

### 6.1 Recall は先行の qwen3-235b-a22b-2507 (Instruct) を大きく下回る

Q1 の Recall 85.00% は、先行評価した `qwen/qwen3-235b-a22b-2507`（Instruct, 93.9%）を **8.9pp も下回る**。同じ Qwen 系列でも小型（27B）版はスクリーニング用途で明確に劣ることが確認された。

### 6.2 Precision は高いが、これも「除外方向に寄っている」ことの表れ

Precision 73.68% は 235B（47.9%）より高いが、Recall が大きく落ちている以上、これは判断が除外方向に寄っていることの裏返しであり、SR のスクリーニング（見逃しを避ける）では長所にならない。`gemini-3.7-flash` 実験（[experiments/gemini-3.7-flash/report.md](../gemini-3.7-flash/report.md)）や `gpt-5.6` の reasoning 実験と同型のトレードオフ。

### 6.3 レイテンシ・スループットとも235Bに劣る

2種類の指標を分けて記録する。

- **逐次レイテンシ（1リクエストの往復時間）**: 実測 **11.8秒/件**（Phase 0 で逐次計測。`fetch()` の解決＝ヘッダ受信は861msだが、ボディ読了まで含めるとこの値）
- **スループット（並列25で吸収したあとの実効値、`durationMs / 件数`）**: Q1 フル実行で **870ms/件**。並列25で全件約29分

このうち README の OpenRouter 表に載せている ms/件、および他モデルとの比較に使うのは**スループット**の方である。先行の 235B Instruct のスループット（650ms/件）と比べると、本モデルは**約1.3倍**（870ms ÷ 650ms）。逐次レイテンシの11.8秒/件は235Bの650ms/件（スループット）と直接割り算できる数値ではない（指標が異なる）ため、単純な「約18倍」という比較はしない。

いずれの指標で見ても本モデルは235Bに劣っており、実運用の並列スクリーニングでは235Bより不利という結論自体は変わらない。

## 7. `openrouter_akashml_safe` プロファイルの追加

§4 の429経験を踏まえ、[config.json](config.json) の `rateLimits` へ `openrouter_akashml_safe`（concurrency 10, delayBetweenRequests 200）を追加した。既存 Q1/Q2 条件が参照する `openrouter_akashml`（concurrency 25, delayBetweenRequests 0）の値は実測の再現性を保つため変更していない。1,993件級の連続実行を今後 AkashML 配信モデルで行う場合は `openrouter_akashml_safe` の使用を推奨する。

## 8. 結論

| 判断基準 | 結果 |
|---|---|
| Recall ≥ 0.95 かつ Precision/コスト/レイテンシのいずれかで B4 を上回る → 採用候補 | ❌ 未達 |
| Recall 0.93–0.95 → フォールバック枠 | ❌ 未達 |
| Recall < 0.93 → 不採用 | ✅ **該当**（Q1: Recall 85.00%） |

**判定: 不採用**

- Q1（最終確定値）の Recall 85.00% は判定基準の「Recall < 0.93 → 不採用」に明確に該当し、先行評価した同系列の `qwen/qwen3-235b-a22b-2507`（93.9%）にも 8.9pp 及ばない。
- Precision の高さ（73.68%）は除外方向への偏りの表れであり、採用理由にならない。
- レイテンシ面でも235Bに劣る（スループット比較で約1.3倍、逐次レイテンシは11.8秒/件と235Bのスループット650ms/件より大幅に遅い。指標の違いは§6.3参照）。
- Q2（reasoning=low）はスループット上の理由（全件外挿 約12時間）で中断しており、精度面の結論には使えない。今回のコスト（全件外挿 $9.49）自体はゲートを通過していたため、再検証する場合は時間を確保した上での再実行が必要（本レポートの範囲では新規実行を行わない）。
- Q1 の実行中に発生した429エラー（82件, 4.1%）は再開機能で解消できたが、今後の同規模実行では `openrouter_akashml_safe`（concurrency 10）の使用を推奨する。

**実費**: Q1 smoke $0.044 + Q1 full $1.844 + Q2 部分 $0.229 = 約 $2.12

## 9. ソースコード・元データ

- 実験計画: [plan.md](plan.md)（末尾に実行結果の追記あり）
- 実験設定: [config.json](config.json)
- ランナー: [runner.ts](runner.ts)
- 全条件実行: [run_all.ts](run_all.ts)
- OpenRouter クライアント: [openrouter-client.ts](openrouter-client.ts)
- サマリー: [summarize.ts](summarize.ts)
- 結果 JSON: [results/](results/) 配下（`depression_Q1_items.jsonl` がQ1フル実行分、`depression_Q2_items.jsonl` がQ2の部分データ48件、`.bak` はsmoke実行時のスナップショット）
- 元データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md)（B4）、[experiments/openrouter-bench/report.md](../openrouter-bench/report.md)（`qwen/qwen3-235b-a22b-2507` 等の先行評価）、[experiments/gemini-3.7-flash/report.md](../gemini-3.7-flash/report.md)（同時期の「Recall↓Precision↑」同型事例）
