<!-- Gemini Decisions API のベンチマーク条件・実行手順・採用判断を記録する。 -->
# Gemini gemini-decision-1 評価計画

## 目的と条件

Gemini Decisions API の `gemini-decision-1` を、TypeSafe Jev と同じデータ・プロンプト・閾値・指標で評価する。
実 API での50件試行、全件実行、性能の考察は別途実施する。

- ソース: [runner.ts](runner.ts)、[ledger.ts](ledger.ts)、[summarize.ts](summarize.ts)、[config.json](config.json)、[decisions-api.ts](decisions-api.ts)。
- 比較元: [TypeSafe Jev の設定](../typesafe-jev/config.json)と[評価レポート](../typesafe-jev/report.md)。
- モデル: `gemini-decision-1`、質問設計: `overall-noul-decisions`、出力言語の設定: `en`。
- 総合 Noul 1問（Decisions API、instructions に screeningPrompt と問いを連結）。
  `defaultScreeningPrompt` の `{{CRITERIA}}` を各データセットの基準で置換し、空行の後に
  `Should this record be included at the title/abstract screening stage?` を付ける。
- `POST https://generativelanguage.googleapis.com/v1beta/decisions` に `model`、`input`、`questions.include` を送る。
  `input` は `Title: <題>\n\nAbstract: <抄録>`。抄録が空なら `(no abstract)` を使う。
  `questions.include` の `type` は `noul`、`instructions` は文字列。
- `answers.include.noul` を確率として使う。0〜1の有限数以外は再試行する。API の Noul は0.01〜0.99に丸められる仕様。
  応答モデル版は `modelVersion` / `model_version`、無ければ `null`。
- `確率 >= 閾値` を include とする。主閾値0.3、参考0.5。
  Recall・Specificity・Precision・Fβ(7)・TP/FP/TN/FN の計算は比較元を維持する。
- 並列数8、最大5試行（初回を含む）。バックオフは2秒×2^(試行番号−1)×1以上2未満のジッタ、上限60秒。
  1リクエストは本文の読み取りを含め60秒で中止し、タイムアウトも再試行する。
- 入力トークンは `usage.total_input_tokens`、出力は `usage.total_output_tokens`（無ければ0）。生成出力は0トークン。
  単価は入力100万トークンあたり0.10 USD、出力0 USD。
  出典は [Gemini API の料金ページ](https://aistudio.google.com/docs/pricing) の Gemini Decision 有料枠、2026-11-12取得。
  **commander 照合前の仮値**として `pricingSource` に記録する。

| キー・元データ | ラベル列 | N | 陽性 | 抄録なし（`!abstract`） |
|---|---|---:|---:|---:|
| [depression](../../scripts/asreview-baseline/datasets/depression_slim_labeled.json) | label_included | 1993 | 280 | 394 |
| [cq1](../../scripts/asreview-baseline/datasets/cq1_labeled.json) | label | 5628 | 113 | 119 |
| [cq2](../../scripts/asreview-baseline/datasets/cq2_labeled.json) | label | 3400 | 17 | 129 |
| [cq3](../../scripts/asreview-baseline/datasets/cq3_labeled.json) | label | 1038 | 16 | 97 |
| [cq4](../../scripts/asreview-baseline/datasets/cq4_labeled.json) | label | 4326 | 72 | 77 |
| [cq5](../../scripts/asreview-baseline/datasets/cq5_labeled.json) | label | 2253 | 41 | 27 |

起動時に件数・陽性数・抄録なし件数とIDの一意性を照合する。不一致なら停止する。
depression は配列、CQ は `records` 配列を読み、ラベルを内部で `label_included` に正規化する。

## 中断耐性と出力ファイル

データセットは1つずつ順番に実行し、ランナーを同時に起動しない。

- 成功1件ごとに `results/<dataset>_<model>_overall_v1.jsonl` へ追記する。
  再開時は成功レジャに存在するキーだけを除外する。失敗は成功確率で補完しない。
- 最終試行まで失敗した文献は `results/<dataset>_<model>_overall_v1.failures.jsonl` へ追記する。
  `key`、`dataset`、`http_status`、`error_status`、`kind`、`attempts`、`config_hash`、`completed_at` だけを保存する。
  分類は `http` / `timeout` / `invalid_response` / `network`。400の `error.status` は定数形式の文字列だけを保持する。
  失敗レジャは再開の判定に使わない。集計はキーごとの最後の失敗を使い、後で成功したキーを除外する。
- 401・403・404だけは新規リクエストを停止し、実行中の応答を回収・保存して終了する。
  404はモデル指定エラーとして扱う。400は安全性ブロックが文献単位で起きるため、通常どおり再試行する。
- 429/529は全ワーカー共有の期限を延長し、その間は新規リクエストと再試行を待つ。
- 成功レジャのキーは最終行勝ち。壊れた成功行は件数を警告し、追記時に改行の無い末尾を分離する。
  設定の不一致は停止する。モデル・質問設計・置換済みプロンプト・出力言語のJSONを SHA-256 に含める。
  閾値はハッシュに含めない。異なる条件は版タグを変え、結果を混ぜない。
- `--smoke` は seed `2026` で50件を選び、`results/smoke_sample_<dataset>_50.json` にID配列を凍結する。
  不正な標本は選び直さず停止する。試行と全件は同じ成功レジャを使う。
- APIキー・入力・応答本文・例外全文はログとレジャに保存しない。HTTP例外のメッセージは `API error <status>` のみ。
- 終了時は「失敗 N 件（HTTP 400: M 件）」を表示する。この件数はその起動中に最終試行まで失敗した文献数。
  終了コードは全対象完了0、再試行上限到達2、再試行不可3、設定・入出力エラー1。
- 逐次追記はプロセス中断からの再開を目的とする。電源断に対する fsync の保証は含まない。

## 実行

リポジトリ直下で実行する。`GEMINI_API_KEY` は環境変数を優先し、直下の `.env` からも読む。

```sh
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/runner.ts --dataset cq1 --smoke
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/runner.ts --dataset cq1
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/summarize.ts
```

Windows PowerShell では `npx` を `npx.cmd` に置き換える。並列数は `--concurrency N` で上書きできる。
`depression`、`cq2`〜`cq5` も同様に指定する。`--dataset` 省略時は `depression`。
サンドボックス内では ts-node の起動と実 API への通信を行わず、fake の実走も commander が行う。

```sh
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/runner.ts --fake --dataset depression --smoke
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/runner.ts --fake --dataset depression
npx ts-node --project experiments/gemini-decision-1/tsconfig.json experiments/gemini-decision-1/summarize.ts --fake
```

偽応答はキー不要で外部プロバイダを読み込まず、実 API のモジュールも読み込まない。
IDの SHA-256 先頭32bitを確率に変換する。剰余10が0なら初回だけ失敗、剰余97が0なら毎回失敗する。
待機は1ms。永久失敗がある実行の終了コード2は想定どおり。
成功・失敗レジャ、標本、レポートは `.tmp/gemini-decision-1-fake/` に分離する。

型検査:

```sh
npx tsc --noEmit -p experiments/gemini-decision-1/tsconfig.json
```

## 集計と採用判断

[summarize.ts](summarize.ts) は元データのラベルを正とし、不一致を警告する。
本番は `experiments/gemini-decision-1/report.md`、偽応答は `.tmp/gemini-decision-1-fake/report.md` に出力する。
全データセットの概要と、成功または失敗レジャのあるデータセットの詳細を出す。
未実行は「未実行」、完了件数がN未満なら「暫定」。失敗と未完了は指標の分母に含めない。

両閾値・既存比較・閾値スイープ・確率分布・モデル版・成功試行のトークンとレイテンシ・コストと単価出典を出す。
条件とカバレッジには、成功済みキーを除いた最終失敗数とHTTP 400件数を示す。
概要には B4・flash-lite の Recall@0.5 と Jev 1.14 の Recall@0.3 を並べる。
CQ1〜5合算は混同行列のマイクロ平均で、1つでも未完了なら暫定とする。
陽性の少ない cq2・cq3 は見落とし1件の影響を脚注に示す。
Recall ≥95%の最大閾値は全実測確率から探索する。
WSS@95 = (TN+FN)/完了件数 − 0.05。ROC AUC は同順位を0.5とする順位法。

主閾値0.3の Recall に比較元と同じ規則を適用する。

- Recall ≥95%: 採用候補。Precision・コスト・レイテンシで B4 と比較が必要。
- 93% ≤ Recall <95%: フォールバック枠。
- Recall <93%: 不採用。

比較値の出典と閾値は設定に保持する。暫定値と偽応答の判定を最終採用判断に使わない。
この計画とランナーの作成だけでは、拡張機能へのモデル同梱を決定しない。
