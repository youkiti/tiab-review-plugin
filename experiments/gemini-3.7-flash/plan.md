# 実験計画: gemini-3.7-flash

## コンテキスト

`gemini-3.6-flash`（[experiments/gemini-3.6-flash/report.md](../gemini-3.6-flash/report.md)）は depression Recall 94.6%（最良条件 D1）・$1.70/1K件（B4比 1.0倍）で、**フォールバック候補どまり**（UI公開・デフォルト切替は見送り）と判定された。Recall が B4（96.1%）パリティの 0.95 に届かなかったことが直接の理由。

今回評価する `gemini-3.7-flash` は Phase 0 の事前確認で `models.list` に実在を確認済み（displayName "Gemini 3.7 Flash"、入力 1,048,576 / 出力 65,536 トークン、`generateContent`/`countTokens`/`createCachedContent`/`batchGenerateContent` 対応）。公式価格は**入力 $0.75 / 出力 $3.75**（思考トークン含む、per 1M tokens、2026-08-16 時点） — `gemini-3.6-flash`（入力 $1.50 / 出力 $7.50）から**価格が半額**になっている。

**重要な判定ライン**: `gemini-3.6-flash` は Recall 94.6% で「フォールバック候補（0.93-0.95）」止まりだった。今回は価格が半額なので、もし Recall が 95% に届けば（B4比コストが半額程度になるため）**初めて「デフォルト切替候補」判定表の上位区分（UI公開・デフォルト切替候補）に入る**可能性がある。逆に Recall が94%台に留まった場合でも、コスト半減により「フォールバック候補」としての魅力度は前世代より上がる。

**注意（価格改定予定）**: 上記価格は **2026-12-31 まで**の適用。**2027-01-01 からは入力 $1.50 / 出力 $7.50 へ倍増**（`gemini-3.6-flash` の現行価格と同額になる）予定であることが公式に案内されている。判定・レポートではこの期限を明記し、恒久的な優位性ではなく期間限定の優位性であることを明確にする。

**RQ1**: `gemini-3.7-flash` は depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: $/1K件は B4 の ~$1.70 と比較してどうか？（価格半額により `gemini-3.6-flash` の $1.70/1K件からさらに下がることが期待される）

## 比較対象

| モデル | 由来 | depression Recall | $/1K件 | 備考 |
|---|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | `experiments/report.md` | 0.961 | ~$1.70 | 現行精度枠（チャンピオン） |
| gemini-3.6-flash (最良 D1) | `experiments/gemini-3.6-flash/report.md` | 0.946 | $1.70 (B4比1.0倍) | 直前の同格モデル、フォールバック候補止まり |
| 現行デフォルト GA C1 (`gemini-3.1-flash-lite`) | `experiments/gemini-3.6-flash/report.md` | 0.936 | ~$0.30 | UI 既定モデル |
| **`gemini-3.7-flash`** | 今回 | TBD | TBD | 価格半額（期間限定、2026-12-31まで） |

## 実験設計

### Phase 1 のみ: depression × 3条件（E1-E3）フル実行、E4 は既定で除外

TopP 0.95 / Temp 1.0 固定、thinking_level のみ振る。

| 条件 | thinking_level | maxOutputTokens | 備考 |
|---|---|---|---|
| E1 | LOW | 8,192 | B4 相当 |
| E2 | MINIMAL | 4,096 | |
| E3 | MEDIUM | 16,384 | |
| E4 (既定で除外) | HIGH | 32,768 | `gemini-3.5-flash`（HIGH で $104/データセット）・`gemini-3.6-flash`（HIGH で約$79/データセット）と2世代連続で $20 閾値を大きく超過したため、今回は疎通確認も実施しない |

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

`gemini-3.6-flash` の判定表（Recall≥0.95 のコスト区分が「2–5倍」からしか始まらない）をそのまま流用すると、
今回のように価格半額でコストが下がった場合に「Recall 0.95〜0.96 かつ コスト ≤2倍」が
どの行にも当てはまらなくなる。そのため Recall 区分を「≥0.96」と「0.95–0.96」に分け、
コスト区分を漏れなく敷き詰めた（Recall×コストの全組み合わせを網羅する）。
`Recall ≥ 0.96 かつコスト ≤ 2倍 = デフォルト切替候補` はそのまま維持している。

| Recall | B4比コスト | 結論 |
|---|---|---|
| ≥ 0.96 | ≤ 2倍 | デフォルト切替候補 |
| ≥ 0.96 | 2–5倍 | UI公開（上位互換枠） |
| ≥ 0.96 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.95–0.96 | ≤ 5倍 | UI公開（上位互換枠） |
| 0.95–0.96 | > 5倍 | 実験記録のみ・UI非公開 |
| 0.93–0.95 | — | フォールバック検討 |
| < 0.93 | — | 現行維持（却下） |

## Phase 0 で確認済みの事実（2026-08-16、再確認不要）

- `models.list` に `gemini-3.7-flash` が実在。displayName "Gemini 3.7 Flash"、入力上限 1,048,576 / 出力上限 65,536 トークン
- 対応メソッド: `generateContent` / `countTokens` / `createCachedContent` / `batchGenerateContent`
- 公式価格: 入力 $0.75 / 出力 $3.75（思考トークン含む）per 1M tokens。**2026-12-31まで。2027-01-01 から入力 $1.50 / 出力 $7.50 へ倍増**（`gemini-3.6-flash` と同額になる）

## 実行コマンド

```bash
# 疎通確認 (depression 50件, 条件ごと)
npx ts-node --project experiments/gemini-3.7-flash/tsconfig.json \
  experiments/gemini-3.7-flash/runner.ts --dataset depression --condition E1 --tier tier_smoke --sample 50

# Phase 1 本実行 (E1-E3、E4は個別に判断)
npx ts-node --project experiments/gemini-3.7-flash/tsconfig.json \
  experiments/gemini-3.7-flash/run_phase1.ts

# 途中で中断した場合はそのまま再実行すれば JSONL (results/<dataset>_<condition>_items.jsonl)
# から未処理分だけ再開する。最初からやり直す場合は --fresh を付ける
npx ts-node --project experiments/gemini-3.7-flash/tsconfig.json \
  experiments/gemini-3.7-flash/runner.ts --dataset depression --condition E1 --tier tier_max --fresh

# サマリー
npx ts-node --project experiments/gemini-3.7-flash/tsconfig.json \
  experiments/gemini-3.7-flash/summarize.ts
```

## ソースコード

- ランナー: [runner.ts](runner.ts)
- Phase 1: [run_phase1.ts](run_phase1.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 既存実験: `experiments/report.md`（B4 チャンピオン）、`experiments/gemini-3.6-flash/report.md`（直前の同格モデル、フォールバック候補止まりの事例）、`experiments/gemini-3.5-flash/report.md`（2世代前、却下事例）

## 実行結果（2026-08-16）

本実行完了。最良条件 E3 (MEDIUM) でも depression Recall **91.07%**（E1 LOW は 90.71%）に留まり、B4（96.1%）・前世代 gemini-3.6-flash（94.6%）・現行デフォルト GA C1（93.6%）のいずれにも届かなかった。**判定: 却下（現行維持）**。

- **E2 (MINIMAL) はモデル非対応**（HTTP 400 `INVALID_ARGUMENT`）と判明したため `config.json` の `excludedConditions` へ移動し、`run_phase1.ts` のフル実行対象から除外した。
- **E4 (HIGH) は未実施**（ユーザー判断）。
- Recall は前世代より下がったが Precision は大幅に上昇（除外方向への偏り）しており、感度最優先のスクリーニング用途とは相性が悪いことが分析で判明した。

詳細は [report.md](report.md) を参照。
