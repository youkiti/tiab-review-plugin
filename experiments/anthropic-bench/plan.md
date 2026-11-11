# Anthropic 同梱モデル depression ベンチマーク計画

## 目的
同梱している `claude-haiku-5-5` と `claude-sonnet-5-5` は、同梱の採用基準（depression 全 1,993 件で Recall ≥ 0.90）のベンチマークが未実施のまま同梱されている（README.md の同梱モデルの一覧）。アプリが送る設定のまま depression 全件を評価し、基準を満たすかを判定する。基準を満たしたモデルだけ CQ1〜5（計 16,645 件）も評価する（同梱の最新の前例 TypeSafe `jev-1.14.0` と同じ範囲）。

## RQ
- RQ1: 両モデルは、アプリの設定（effort `low`）・閾値 0.5 で depression の Recall ≥ 0.90 を満たすか。
- RQ2: 満たす場合、既定モデルの置き換え基準（Recall ≥ 0.95）も満たすか。CQ1〜5 でも Recall は保たれるか。
- RQ3: 閾値を下げると（API の追加費用なし）、Recall と Specificity はどう動くか。

## 条件
アプリの設定（`src/lib/model-generation-settings.ts` の `MODEL_GENERATION_SETTINGS`）と同じ。**条件の調整（effort を上げるなど）はしない。** 調整すると depression の値が楽観的になる。`runner.ts` は起動時に、条件の effort・max_tokens がアプリの設定と食い違っていたら止まる。

| ID | モデル | effort | max_tokens | 位置付け |
| --- | --- | --- | --- | --- |
| `A-H1` | `claude-haiku-5-5` | `low` | 20000（アプリは max_output_tokens を渡さないので `anthropicMaxOutputTokens(undefined)`） | アプリが送る設定。採用の判定に使う |
| `A-S1` | `claude-sonnet-5-5` | `low` | 同上 | 同上 |

- temperature・top_p・top_k・thinking は送らない（`screenViaAnthropic()` のまま。`src/lib/providers/anthropic.ts` の `buildRequest`）。
- 出力言語 `ja`。プロンプトと判定基準の文は `experiments/gpt-5.6/config.json` と同じ（depression）。CQ1〜5 の基準の文は `experiments/typesafe-jev/config.json` と同じ。

## 評価
- 閾値 0.5 固定（TypeSafe 以外の同梱モデルと同じ）。Recall / Specificity / Precision / Fβ(β=7)（`experiments/gpt-5.6/runner.ts` と同じ式）。
- 失敗した件（`include_probability` が null）は指標に数えない。偽の陽性（1.0）にはしない。
- wilson は評価しない（B4 は N/A、`jev-1.14.0` も未実施）。全文の AI 判定のベンチマークもしない。

## 段階実行ルール

```
疎通（各条件 --sample 5）: モデル ID の実在、JSON の出力、1件の費用の実測
  ↓
smoke（各条件 --sample 50）: 全件の費用を cost.totalUSD / 50 × 1,993 で外挿して本人に示す → 本人が実行を決める
  ↓
depression 全件（1,993件）、閾値 0.5
  ↓
  Recall ≥ 0.90 ?
   ├ Yes → 同梱の採用基準を満たす。CQ1〜5 の smoke（各データセット 50件）→ 外挿した費用を本人に示す → 本人が実行を決める → CQ1〜5 全件
   └ No  → CQ1〜5 は実行しない
  ↓
閾値のスイープ（追加費用なし）→ report.md → README の更新
```

- 失敗（API のエラーでフォールバックになった件数）が全体の 1% を超えたら、その実行を無効として扱い、原因を `report.md` に書いてから取り直す（`experiments/gemini-3.7-flash/report.md` 5節の前例）。`runner.ts` は失敗が 1% を超えると警告を出し、`summarize.ts` は無効と表示する。
- `max_tokens` で打ち切られた件数（`retryable: false` のエラー）は、`runner.ts` が `truncatedCount` に数え、`report.md` の表に出る。件数を本文にも書く。
- `runner.ts` の取り直し: 一過性の失敗（429・5xx・通信断・JSON の崩れ）は文献ごとに最大 4 回（待ちは 2s から倍々、上限 60s、`retry-after` があればそれに従う）。401/403/404・打ち切り・拒否は取り直さない。

## 費用の見積もり（実行前の概算）

単価は `src/lib/llm-pricing.ts` の `BUILT_IN_PRICING`（2026-10-16 に公式の料金表で確認。Haiku は入力 10 万トークン以下の単価）。入力は、`llm-pricing.ts` の `estimateInputTokens` の式でデータセットから計算した値（depression 約 1.62M トークン）と、同じプロンプトでの `gpt-5.6` の実測 1,900,027 トークン（`experiments/gpt-5.6/report.md`「トークン消費」）の大きい方。出力は 1 件 600 トークン。Anthropic のトークンの数え方は他社と違うので、smoke の実測で置き換える前提の概算である。

| 範囲 | 件数 | 入力（M トークン） | 出力（M トークン） | `claude-haiku-5-5` | `claude-sonnet-5-5` |
| --- | --- | --- | --- | --- | --- |
| 疎通（5件） | 5 | 0.005 | 0.003 | 約 $0.002 | 約 $0.04 |
| smoke（50件） | 50 | 0.048 | 0.030 | 約 $0.02 | 約 $0.40 |
| depression 全件 | 1,993 | 1.90 | 1.20 | 約 $0.79 | 約 $15.8 |
| CQ1〜5 全件 | 16,645 | 17.79 | 9.99 | 約 $6.8 | 約 $135 |

- 計算: `入力 × 入力単価 + 出力 × 出力単価`。例: Sonnet の depression は 1.90 × $2 + 1.20 × $10 = 約 $15.8。
- CQ1〜5 の入力は、`estimateInputTokens` の式でデータセットごとに計算した合計（cq1 5.97M・cq2 3.32M・cq3 1.05M・cq4 4.49M・cq5 2.95M）。
- 両モデルの depression と CQ1〜5 をすべて実行した場合の合計は約 $158。CQ1〜5 は Recall の基準を満たしたモデルだけ、本人が費用を見て実行するので、depression だけなら約 $17。
- 実測は `results/experiment_*.log.json` の `results.cost`（`totalUSD`・`perItemUSD`・`extrapolatedFullUSD`）。生のトークンを `items_*.json` に残すので、単価が変わっても `config.json` の `pricing` を直して再計算できる。

## 実装
- `experiments/anthropic-bench/` に閉じる。`src/` は変えていない（`screenViaAnthropic()` は使用量をすでに返す）。変える必要が出たら、変えた箇所をここに書き、別の PR にする。
- ファイル: `config.json`（条件・単価・データセット）、`common.ts`（型・指標・`results/` の読み込み。3つの script が共有）、`runner.ts`、`run_all.ts`、`summarize.ts`、`threshold_sweep.ts`、`tsconfig.json`（型検査用）。
- `runner.ts` は `screenViaAnthropic()` を自前のループで呼ぶ（Node では `ANTHROPIC_API_KEY` を `.env` から読む）。`checkpointEvery`（50）件ごとに items / log を途中保存する。
- `--resume <experimentId>`: 取得済みで失敗していない件を引き継ぎ、失敗した件と未着手の件だけ回す。429 が続いて止めたときは、`config.json` の `rateLimits` の並列を半分にして `--resume` で続ける（取得済みの分は捨てない）。
- `--dry-run`: global fetch を模型に差し替えて実 API を呼ばず、送る内容（model・max_tokens・effort・送らない項目）を表示し、結果を OS の一時ディレクトリに書く（`results/` には書かない）。模型は一部の件で 429 と `max_tokens` の打ち切りを返すので、取り直しと集計の確認に使える。`summarize.ts` と `threshold_sweep.ts` は `--include-dry-run --results-dir <dir> --out-dir <dir>` で一時ディレクトリの結果を読める。
- smoke（`--sample` 指定）は `anthropic_smoke`（並列 3・間隔 300ms）、全件は `anthropic_default`（並列 8・間隔 200ms）。
- 型検査（`experiments/` は `npm run typecheck` の対象外）:
  ```bash
  npx tsc --noEmit --project experiments/anthropic-bench/tsconfig.json
  ```
  `src/lib/ml/worker-client.ts` の `import.meta` エラーが 1 件出るのは既存の事象（`AGENTS.md`「実験ディレクトリを追加するときの落とし穴」）。

## 実行手順（本人の作業。実 API を呼ぶ）
```bash
# 0) リポジトリ直下の .env に ANTHROPIC_API_KEY=... を書く（.env は git 管理外。管理画面で費用の上限を設定しておく）

# 1) 疎通（各条件 5件）
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/runner.ts --condition A-H1 --sample 5
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/runner.ts --condition A-S1 --sample 5

# 2) smoke（各条件 50件）→ 出力の「全 1993 件への外挿」を見て、全件を回すか決める
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/runner.ts --condition A-H1 --sample 50
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/runner.ts --condition A-S1 --sample 50

# 3) depression 全件（両条件を順に）
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/run_all.ts --dataset depression

# 4) 閾値のスイープ（追加費用なし）と report.md
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/threshold_sweep.ts
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/summarize.ts

# 5) 基準を満たした条件だけ CQ1〜5 の smoke → 費用を見て全件（例: A-H1 が満たした場合）
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/run_all.ts --dataset cq1,cq2,cq3,cq4,cq5 --only A-H1 --sample 50
npx ts-node --project experiments/tsconfig.json experiments/anthropic-bench/run_all.ts --dataset cq1,cq2,cq3,cq4,cq5 --only A-H1
```
- `run_all.ts` は `--only` を省略すると両条件を回す。CQ1〜5 では必ず `--only` で基準を満たした条件に絞る。
- 疎通の確認項目: `items_*.json` の各行に `include_probability` とトークン（`usage.prompt`・`cached`・`completion`・`reasoning`）があること、失敗が 0 であること、モデル ID が実在すること。

## 結果が出た後（README と同梱設定）
- 基準を満たした: README.md の同梱モデルの一覧の「未実施・未確認」を depression の Recall・Specificity と約 $/1K件に書き換える。「depression データセットでの代表的結果」の表に行を足し、CQ1〜5 を実行したら「全データセット Recall」の表に列を足す。詳細レポートの一覧に `experiments/anthropic-bench/report.md` を足す。同梱設定は変えない。
- 満たさなかった: 本人に、同梱から外すか、注記を付けて残すかを確かめ、その答えに従う。外す場合は別の PR（`AVAILABLE_MODELS` から外す。`CHANGELOG.md` の「AI 判定に影響する変更」）。残す場合は README に「depression Recall NN.N%（同梱の採用基準 Recall ≥ 0.90 を満たさない）」と書き、`docs/help.html` のモデルの説明にも同じ注記を足す。

## リスク管理
- **費用**: Sonnet の CQ1〜5 は約 $135。smoke の外挿を本人に示してから実行する。`runner.ts` は途中保存するので、途中で止めても取得済みの分は残る。
- **429**: 続いたら並列を半分にして `--resume` で再開する。
- **max_tokens の打ち切り**: アプリと同じ 20000 を送る。打ち切りが多いと失敗の率が 1% を超えて無効になる。その場合も条件は調整せず、件数と原因を `report.md` に書く。
- **費用の過小**: 打ち切られた件は使用量が返らず、費用に入らない（`src/` を変えないため）。

## データ・ソース
- データセット: `scripts/asreview-baseline/datasets/depression_slim_labeled.json`（N=1,993 / 陽性 280）、`cq1_labeled.json`〜`cq5_labeled.json`（計 16,645 / 陽性 259）
- config: `experiments/anthropic-bench/config.json`
- runner: `experiments/anthropic-bench/runner.ts`
