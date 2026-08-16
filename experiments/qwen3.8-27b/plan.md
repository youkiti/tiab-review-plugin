# 実験計画: qwen/qwen3.8-27b (OpenRouter)

## 目的

2026-08-14 にリリースされた `qwen/qwen3.8-27b`（OpenRouter 経由、配信プロバイダ AkashML、quantization bf16）が、現行 Gemini ベースの TiAb スクリーニングの代替・拡張として有用かを定量的に判断する。

`experiments/openrouter-bench/`（[report.md](../openrouter-bench/report.md)）で先行評価した `qwen/qwen3-235b-a22b-2507`（Instruct, 非thinking）は depression Recall 93.9% / Precision 47.9% / $0.07 per 1K件 / 650ms per件だった。超低価格ではあるが、Recall 93.9% は採用基準の 0.95 に**届いておらず**（`openrouter-bench/report.md` に記録された全件比較の中にも Recall ≥95% に達したモデルは無い）、フォールバック枠（0.93–0.95）止まりの評価だった。`qwen3.8-27b` は同じ Qwen 系列の新世代・小型（27B）モデルで、価格帯は235Bより高い（$0.45/$3.20 vs $0.071/$0.10）ものの、精度改善（Recall 0.95 到達）が期待できるかを確認する。

**RQ1**: `qwen3.8-27b` は depression Recall ≥0.95（B4 パリティ）を達成できるか？
**RQ2**: 非thinking (Q1) と reasoning=low (Q2) で Recall・コスト・レイテンシがどう変わるか？
**RQ3**: レイテンシは実運用（並列スクリーニング）に耐えるか？

## 比較対象

| モデル | 由来 | depression Recall | Precision | $/1K件 | レイテンシ(ms/件) |
|---|---|---|---|---|---|
| B4 (`gemini-3-flash-preview`) | `experiments/report.md` | 0.961 | 0.534 | ~$1.70 | ~300 |
| `qwen/qwen3-235b-a22b-2507`（Instruct, 非thinking） | `experiments/openrouter-bench/report.md` | 0.939 | 0.479 | $0.07 | 650 |
| **`qwen/qwen3.8-27b`** | 今回 | TBD | TBD | TBD | TBD |

## 条件

| ID | Provider | Model | Temperature | TopP | Reasoning | 備考 |
|---|---|---|---|---|---|---|
| REF-B | Gemini | `gemini-3-flash-preview` | 1.0 | 0.95 | thinkingLevel=LOW | 既存B4相当のベースライン（参照用、コピー元と同一） |
| Q1 | OpenRouter | `qwen/qwen3.8-27b` | 0 | - | `enabled: false`（非thinking） | 主軸条件 |
| Q2 | OpenRouter | `qwen/qwen3.8-27b` | 1.0 | 0.95 | `effort: low` | smoke → コストゲート判定してからフル実行 |

## Phase 0 で確認済みの事実（2026-08-16、再確認不要）

コマンダーが実 API を叩いて確認済み。以下を前提に実装・実行する。

| 項目 | 結果 |
|---|---|
| 配信プロバイダ | AkashML の1社のみ（quantization: bf16、モデルタグ `qwen3.8-27b-20260814`） |
| 公式価格 | 入力 $0.45 / 出力 $3.20 per 1M tokens |
| thinking のデフォルト挙動 | 何も指定しないと reasoning トークンが出る（デフォルトON）。`reasoning: { enabled: false }` を明示送信すると reasoning トークン数 0 を実測確認 |
| `response_format: json_schema` (strict) | 動作する。50件でパース失敗0・フォールバック0・打ち切り0 |
| レート制限 | 並列10・並列25 のいずれでも 429 は発生せず（各50件）。レート関連レスポンスヘッダは空 |
| 実レイテンシ | 約 11.8 秒/件（`fetch()` の解決＝ヘッダ受信は 861ms だが、ボディ読了まで含めるとこの値）。並列25で全1,993件が約17分の見込み |
| 実コスト | $0.94 per 1K件 → 全1,993件で約 $1.90 |

### レイテンシに関する重要な留意点

`qwen3.8-27b` の逐次レイテンシ（約11.8秒/件、1リクエストの往復時間）は並列処理（concurrency 25）で吸収する前提の数値であり、先行評価した `qwen/qwen3-235b-a22b-2507` のスループット値（650ms/件、並列後の実効値）と直接割り算できる指標ではない。フル実行後の実測では `qwen3.8-27b` のスループットは870ms/件（Q1、[report.md](report.md) 6.3節）で、235Bのスループット比では約1.3倍にとどまる。ただし**指標を揃えても `qwen3.8-27b` は B4・235B Instruct のいずれにも負けている**点はレポートで明記する。Recall/コストで優位でも、レイテンシ面での採用理由にはならない。

## データセット

`scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 全件: 1,993 件
- 陽性: 280 件 / 陰性: 1,713 件
- 既知 B4 ベースライン: Recall 96.1% / Precision 53% / FN 11 件

## プロンプト

`experiments/qwen3.8-27b/config.json` の `defaultScreeningPrompt` を使用。既存 [experiments/experiments.json](../experiments.json) と同一。

## 出力スキーマ

`include_probability` (0-1) / `reasons` (string[]) / `evidence` ({field, quote, start_char, end_char}[]) を `response_format: json_schema`（strict）で強制する。AkashML では strict schema が動作することを Phase 0 で実測確認済みのため、`openrouter-bench` 版と異なり実送信する（詳細は [openrouter-client.ts](openrouter-client.ts) のコメント参照）。

## 評価指標

`runner.ts` の `calculateMetrics` で計算（既存 [experiments/openrouter-bench/runner.ts](../openrouter-bench/runner.ts) と同一実装）:
- Sensitivity / Specificity / Precision
- Fβ score (β=7)
- TP / FP / TN / FN
- tokens (prompt/completion/reasoning)
- 推定コスト（USD、config.json の `pricing` から算出）
- 1 件あたり平均レイテンシ (ms)

## 判定基準

`experiments/openrouter-bench/plan.md` の基準を踏襲する:

- **採用候補**: Recall ≥ 0.95 かつ、Precision・コスト・レイテンシのいずれかで B4 を上回る
- **フォールバック枠**: Recall 0.93-0.95（オプション選択肢として残す）
- **不採用**: Recall < 0.93

上記のレイテンシ実測（約11.8秒/件）を踏まえると、レイテンシでの優位性は事前に見込めない。採用可否は実質 Recall とコストで決まる。

## リスクと対応

- **配信プロバイダが AkashML 1社のみ**: 他プロバイダへのフォールバックが無いため、AkashML 側で障害が起きると実験全体が止まる。`allow_fallbacks: false` を明示しているのは、精度が変わりうる他 quantization へ黙って流れるより、エラーとして検知できる方を優先する設計判断（詳細は [openrouter-client.ts](openrouter-client.ts) 参照）。
- **新モデルのため実測データが少ない**: リリース直後（2026-08-14）のため、他ユーザーのフィードバックや長期安定性の情報が乏しい。
- JSON Schema strict は Phase 0 で動作確認済みだが、`tryParseJson` によるテキスト抽出フォールバックは念のため残している。

## 中断耐性

外部API呼び出しが1,993件×2条件=約4,000回に及ぶため、[runner.ts](runner.ts) は1件処理するたびに `results/<dataset>_<condition>_items.jsonl` へ即時 append する。再実行時は成功済み（`error` なし）の ref_id をスキップし、未処理分・前回エラーだった分だけ再試行する。詳細は runner.ts 冒頭のコメントを参照。

## 実行コマンド

```bash
# 0. .env に OPENROUTER_API_KEY を追加（GEMINI_API_KEY と並列）

# 1. 動作確認 (sample=50 で 1 条件だけ)
npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/runner.ts \
    --dataset depression --condition Q1 --sample 50

# 2. Q2 (reasoning=low) は smoke → コストゲート判定してからフル実行判断
npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/runner.ts \
    --dataset depression --condition Q2 --sample 50

# 3. 結果が許容範囲なら全件で本番実行（中断した場合はそのまま再実行すれば自動的に再開する。
#    最初からやり直す場合は --fresh を付ける）。
#    --only Q1,Q2 が必須: run_all.ts は --only を省略すると config.conditions を
#    全件回してしまい、REF-B (gemini-3-flash-preview) まで depression 全1,993件で
#    再実行してしまう。REF-B は既に B4 として公開済みの参照ベースラインであり、
#    今回の新規課金対象ではないため、REF-B を回したい場合のみ明示的に条件へ加える。
npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/run_all.ts \
    --dataset depression --only Q1,Q2

# 4. レポート集約
npx ts-node --project experiments/qwen3.8-27b/tsconfig.json experiments/qwen3.8-27b/summarize.ts
```

## ソースコード

- ランナー: [runner.ts](runner.ts)
- 全条件実行: [run_all.ts](run_all.ts)
- OpenRouter クライアント: [openrouter-client.ts](openrouter-client.ts)
- サマリー: [summarize.ts](summarize.ts)
- 設定: [config.json](config.json)

## 元データ

- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`
- 比較対象: [experiments/report.md](../report.md)（B4）、[experiments/openrouter-bench/report.md](../openrouter-bench/report.md)（`qwen/qwen3-235b-a22b-2507` 等の先行評価）

## 実行結果（2026-08-16）

Q1（非thinking, Temp 0, フル実行 1,993件）の最終確定値: Recall **85.00%** / Precision 73.68% / Fβ(7) 84.74%。**判定: 不採用**（先行の `qwen/qwen3-235b-a22b-2507` の93.9%を8.9pp下回る）。

- **429エラー**: Q1 初回パスで1,993件中82件（4.1%）が HTTP 429 で失敗したが、中断耐性の再開機能で未処理分だけ再試行して解消した。1,993件級の連続実行では `openrouter_akashml`（concurrency 25）は強気すぎると判断し、より安全な `openrouter_akashml_safe`（concurrency 10, delayBetweenRequests 200）を `config.json` に追加した。
- **Q2（reasoning=low）は48/50で中断**。理由はコストではなくスループット（終盤の失速により全件外挿で約12時間の見込み）。部分データ（n=48）はコストゲート自体は通過していたが（全件外挿$9.49）、統計的有意性がないため精度の判断には使わない。

詳細は [report.md](report.md) を参照。
