# Claude Code CLI による文献スクリーニング参照評価

Claude Code のサブスクリプションを使い、depression のタイトル・抄録を一文献につき一回の CLI 呼び出しで評価する。
Anthropic API は呼ばず、API キーも読み取らない。正解ラベルは対象検証と集計だけに用い、プロンプトには渡さない。

## 入力と実装

- [元データ](../../scripts/asreview-baseline/datasets/depression_slim_labeled.json)
- [50件の標本 ID](../typesafe-jev/results/smoke_sample_depression_50.json)
- [設定](config.json)、[実行](runner.mjs)、[集計](summarize.mjs)、[処理本体](lib/run-core.mjs)
- [製品プロンプト・スキーマ](../../src/lib/gemini-api.ts)
- [基準・基本プロンプトの出典](../gemini-3.8-flash/config.json)、[比較値の出典](../typesafe-jev/config.json)

## CLI と API 経路の違い

指揮担当の 2026-10-10 の二回の簡単なプロンプトによる調査（Claude Code CLI 2.1.289、Windows、Node v22.21.0）を前提とする。
その調査では CLI 自体のコンテキストが約1,100トークン加わり、`cache_creation_input_tokens` は 1,112 と 1,114 だった。
構造化出力は CLI の `--json-schema` を通す。`total_cost_usd` は CLI が出す見積もりであり、課金された金額ではない。
実データ3件の疎通（同日）では、CLI は `claude-haiku-5-5` を未知のモデルとして警告し（標準エラーの `unrecognized_model`）、
`modelUsage` の `costBasis` は `"unknown"` だった。この値を定価換算の費用として他モデルの $/1K件 と比べないこと。費用の比較にはトークン数を使う。
待ち時間にはプロセス起動が含まれる。`modelUsage` には要求モデルに加えて補助モデルの呼び出しが現れる場合がある。
標準エラーの警告だけでは失敗としない。要求モデルが報告されなければ実験全体を停止する。

呼び出し形式は次のとおり。プロンプト全文は標準入力に渡す。

```text
claude -p --model <model> --effort <effort> --system-prompt "" --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format json --json-schema <schema as one JSON string>
```

実装はシェルを使わず引数配列を渡す。空文字の引数を保持し、作業ディレクトリには毎回 OS の一時領域に作る空ディレクトリを使う。
スクリーニングは副作用がないためタイムアウトも再試行するが、モデル不一致・連続失敗の停止規則を優先する。
停止後は新しい呼び出しを開始せず、実行中の結果は保存する。最大試行回数を超えた文献に代替判定を保存しない。

## 実行

リポジトリルートから Node で直接実行する。依存パッケージの追加は不要。

```text
node --test "experiments/claude-code-headless/tests/*.test.mjs"
node experiments/claude-code-headless/runner.mjs --condition H1 --smoke --dry-run
node experiments/claude-code-headless/runner.mjs --condition H1 --smoke
node experiments/claude-code-headless/runner.mjs --condition S1 --smoke
node experiments/claude-code-headless/runner.mjs --condition H1 --all
node experiments/claude-code-headless/runner.mjs --condition S1 --all
```

再開は同じコマンドを再実行する。条件ごとの台帳に存在する文献は飛ばすので、試走後の全件実行でも未処理分だけを呼ぶ。
同じ条件を複数プロセスで同時実行しない。設定を変えた評価を同じ台帳へ混在させない。
`--sample-file <path>` で任意の ID 配列、`--limit <n>` で先頭件数、`--concurrency <n>` で並列数、
`--claude-bin <path>` で実行ファイルを指定できる。相対パスはリポジトリルート基準。
dry-run は CLI バージョンを `dry-run` とし、CLI 呼び出し・台帳・実行ログの書き込みを行わない。
終了コードは完了が0、未処理または停止が1、引数・入力エラーが2。

## 集計

```text
node experiments/claude-code-headless/summarize.mjs --condition H1 --condition S1 --smoke
node experiments/claude-code-headless/summarize.mjs --condition H1 --all
node experiments/claude-code-headless/summarize.mjs --condition H1 --all --allow-partial
```

未処理があれば既定では指標を表示せず終了コード1。`--allow-partial` では条件の各出力行を途中集計と明記する。
`--out <path>` で JSON の保存先を指定できる。未指定では `results/summary_<scope>.json`。
scope は `smoke`、`all`、または標本ファイルの拡張子を除く名前。
陽性は確率が閾値以上の場合とし、指標の分母が0なら `null`。Fβ(7) は `50TP / (50TP + 49FN + FP)`。
複数条件の不一致は全条件に判定が存在する共通文献だけで数える。
比較表の既存ベースラインは参照値であり、今回の標本と同じ母集団の結果とは限らない。
失敗回数は対象文献に関する失敗台帳の全行（過去の再開分を含む）。トークン・費用・時間は成功した items の合計・分布。
失敗を含む全呼び出しの費用を意味しない。

## 保存ファイル

- `results/depression_<conditionId>_items.jsonl`: 成功した文献の判定、モデル、トークン、費用、時間、試行番号、プロンプトハッシュ。
- `results/depression_<conditionId>_failures.jsonl`: 失敗した各試行の分類と時刻、標準出力・標準エラーそれぞれ先頭2,000文字。
- `results/depression_<conditionId>_raw.jsonl`: 全試行の標準出力・標準エラー全文、分類、文献 ID と試行番号。
- `results/run_<conditionId>_<timestamp>.log.json`: 引数、設定ハッシュ、CLI・Node バージョン、開始・終了、実時間と処理件数。
- `results/summary_<scope>.json`: 指標、閾値別集計、使用量、所要時間、再試行、不一致、参考値と表示した Markdown。

台帳は同期追記し、同じ文献の重複は最後の行を採用する。クラッシュで途切れた部分行は数えて読み飛ばす。
追記時に既存の末尾が改行で終わっていなければ改行を補い、次の文献と連結しないようにする。
実行ログの失敗文献数は試行したが成功しなかった件数で、停止時に未着手だった文献は含まない。

## 結果

### 試走 50 件（2026-10-10）

対象は [50件の標本 ID](../typesafe-jev/results/smoke_sample_depression_50.json)（陽性 10・陰性 40）。閾値 0.5、effort `low`、同時実行 4。
Claude Code CLI 2.1.289。50 件とも 1 回目の試行で成功し、失敗台帳は作られなかった。
集計は `summarize.mjs --condition H1 --condition S1 --smoke`（出力は [results/summary_smoke.json](results/summary_smoke.json)）。
混同行列は別に書いた数え直しと一致した。

| 条件 | モデル | TP | FP | TN | FN | 再現率 | 特異度 | 適合率 | Fβ(7) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| H1 | claude-haiku-5-5 | 10 | 5 | 35 | 0 | 100.0% | 87.5% | 66.7% | 99.0% |
| S1 | claude-sonnet-5-5 | 10 | 2 | 38 | 0 | 100.0% | 95.0% | 83.3% | 99.6% |

2 条件の判定が割れたのは 50 件中 3 件。**陽性が 10 件しかないので、再現率 100% は 10/10 という意味でしかない。**
全 1,993 件（陽性 280）の結果ではなく、既存ベースライン（全件での値）と並べて優劣を言える数字ではない。

| 条件 | 入力（キャッシュ書き込み＋読み出し） | 出力 | うち思考 | 1件の所要時間（中央値） | 実行全体 |
| --- | ---: | ---: | ---: | ---: | ---: |
| H1 | 76,211 + 36,284 | 86,549 | 69,409 | 6.7 秒 | 113 秒（47 件） |
| S1 | 80,897 + 41,696 | 13,268 | 547 | 2.4 秒 | 62 秒（50 件） |

- トークン数は 50 件の合計で、CLI が足す文脈（1 件あたり約 1,100 トークン）を含む。キャッシュ外の入力は H1 が 100、S1 が 106。
- H1 の 50 件のうち 3 件は直前の疎通確認（`--smoke --limit 3`）で保存済みで、実行全体の時間は残り 47 件のもの。
- 同じ effort `low` でも、Haiku 5.5 は思考に出力の約 8 割を使い、Sonnet 5.5 はほとんど使わなかった。
- `modelUsage` には、H1 の 49 件・S1 の 44 件で補助モデル `claude-haiku-4-5-20251001` の呼び出しも記録された。
  疎通確認の 1 件（Depression-SLIM-167）では、台帳の `usage` は要求したモデルの分と一致し、補助モデルの分を含まなかった。

### 全 1,993 件

（本走の後に追記する）
