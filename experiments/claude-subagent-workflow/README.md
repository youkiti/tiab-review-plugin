# Claude Code のサブエージェント（Workflow）による depression の簡易評価

Claude Code の Workflow でサブエージェントを並列に起動し、depression の 1,993 件を 1 体あたり最大 25 件ずつ判定させた（2026-10-10）。
Anthropic API は使っていない。**API 経由の評価でも、1 件 1 呼び出しの評価でもない簡易評価**で、リーダーボードの数値と同列には扱えない。
1 件ずつ CLI を呼ぶ方式は [../claude-code-headless/](../claude-code-headless/README.md) にある（そちらは試走 50 件まで）。

## 入力と実装

- [元データ](../../scripts/asreview-baseline/datasets/depression_slim_labeled.json)（1,993 件、陽性 280）
- 基準文と指示文は [../gemini-3.8-flash/config.json](../gemini-3.8-flash/config.json) の `defaultScreeningPrompt` と depression の `criteria`
- [実行した Workflow スクリプト](workflow_screen_depression.js)（実行時のものをそのまま置いた）
- [バッチの作成と取り込み・集計](wf-batches.mjs)、[設定](config.json)
- 指標の計算は [../claude-code-headless/lib/metrics.mjs](../claude-code-headless/lib/metrics.mjs)

## 手順

1. `node experiments/claude-subagent-workflow/wf-batches.mjs prepare C:/tmp/tiab-wf-bench`
   データの並び順のまま 25 件ずつ 80 バッチに切り、`id`・`title`・`abstract` だけをリポジトリの外に書き出す（ラベルは入れない）。
   割り当てと各バッチの SHA-256 は [results/batch_manifest.json](results/batch_manifest.json)。
2. Workflow スクリプトを実行する。1 体が入力ファイルを 1 つ読み、判定（確率と短い理由）を出力ファイルに書く。
   モデルは Haiku 5.5 と Sonnet 5.5、effort は `low`。疎通としてバッチ 1・2（4 体）を先に流し、続けてバッチ 3〜80（156 体）を流した。
3. `node experiments/claude-subagent-workflow/wf-batches.mjs ingest C:/tmp/tiab-wf-bench`
   各出力の ID が入力と過不足なく一致し、確率が 0〜1 の数値であることを確かめてから台帳にまとめ、指標を出す。
   条件を満たさないバッチは 1 件も採用せず、番号を表示する（流し直しの対象になる）。

## API 経路・1 件 1 呼び出しとの違い

- 1 体が最大 25 件を同じ文脈で続けて読む。「1 件ずつ独立に判定する」ことは指示でしか縛っていない。
- サブエージェントは、起動した Claude Code セッションの CLAUDE.md とプロジェクトのメモリを文脈に持って始まる。
  メモリには過去のベンチ結果の要約がある（個々の文献の正解は無い）。
- 正解ラベルを含む元データはエージェントから読める場所にある。「入力ファイル以外を開かない」ことも指示でしか縛っていない。
- 出力の形式は強制していない。根拠の抜粋（`evidence`）は求めていない。
- 1 件ごとのトークン数・所要時間は取れない。分かるのは実行全体の値だけ。

## 結果（全 1,993 件、陽性 280）

Claude Code 2.1.289。160 体すべてが出力を書き、80 バッチ × 2 条件とも ID が入力と一致した（流し直しなし）。
集計は `ingest` の出力（[results/summary.json](results/summary.json)）で、エージェントの出力ファイルから別に書いた数え直しと一致した。

| 条件 | モデル | 閾値 | TP | FP | TN | FN | 再現率 | 特異度 | 適合率 | Fβ(7) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| WH | claude-haiku-5-5 | 0.5 | 248 | 125 | 1,588 | 32 | 88.57% | 92.70% | 66.49% | 87.99% |
| WH | claude-haiku-5-5 | 0.3 | 260 | 181 | 1,532 | 20 | 92.86% | 89.43% | 58.96% | 91.80% |
| WH | claude-haiku-5-5 | 0.1 | 266 | 317 | 1,396 | 14 | 95.00% | 81.49% | 45.63% | 92.99% |
| WH | claude-haiku-5-5 | 0.05 | 272 | 566 | 1,147 | 8 | 97.14% | 66.96% | 32.46% | 93.42% |
| WS | claude-sonnet-5-5 | 0.5 | 236 | 90 | 1,623 | 44 | 84.29% | 94.75% | 72.39% | 84.01% |
| WS | claude-sonnet-5-5 | 0.3 | 254 | 163 | 1,550 | 26 | 90.71% | 90.48% | 60.91% | 89.84% |
| WS | claude-sonnet-5-5 | 0.1 | 268 | 268 | 1,445 | 12 | 95.71% | 84.35% | 50.00% | 94.00% |
| WS | claude-sonnet-5-5 | 0.05 | 269 | 400 | 1,313 | 11 | 96.07% | 76.65% | 40.21% | 93.47% |

閾値 0.5 で 2 条件の判定が割れたのは 51 件。参考として、現行の精度枠（gemini-3-flash-preview、Think LOW、閾値 0.5）は
再現率 96.1%・特異度 86.3%・適合率 53.4%（[../gpt-5.6/report.md](../gpt-5.6/report.md)）。

実行全体（疎通 4 体＋本走 156 体）: サブエージェントのトークンは 338,594 ＋ 13,158,924、所要時間は 28 秒 ＋ 408 秒。

### 同じ 50 件での 1 件 1 呼び出しとの比較

[試走の標本 50 件](../typesafe-jev/results/smoke_sample_depression_50.json)（陽性 10）について、閾値 0.5 で並べた。

| 方式 | モデル | TP | FP | TN | FN |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 件 1 呼び出し（H1） | claude-haiku-5-5 | 10 | 5 | 35 | 0 |
| 25 件ずつ（WH） | claude-haiku-5-5 | 9 | 1 | 39 | 1 |
| 1 件 1 呼び出し（S1） | claude-sonnet-5-5 | 10 | 2 | 38 | 0 |
| 25 件ずつ（WS） | claude-sonnet-5-5 | 8 | 1 | 39 | 2 |

判定が割れたのは Haiku で 5 件、Sonnet で 3 件で、8 件とも 25 件ずつのほうが低い確率を付けていた。
50 件だけの観察だが、25 件ずつ読ませるこの方式は 1 件 1 呼び出しより除外寄りに出ている可能性があり、
上の表の再現率を API 経由の再現率の見積もりとして使うことはできない。原因は切り分けていない。

## 保存ファイル

- `results/agent_outputs/<条件>/batch_NNN.json`: エージェントが書いた判定そのもの（`ref_id`・`include_probability`・`reasons`）
- `results/depression_<条件>_items.jsonl`: 取り込み後の台帳（1 行 1 件。バッチ番号と出力ファイルの更新時刻つき）
- `results/journals/`: Workflow の実行記録（各エージェントの開始と返り値）。疎通と本走の 2 本
- `results/batch_manifest.json`: バッチの割り当てと入力の SHA-256
- `results/summary.json`: 条件ごとの件数、問題のあったバッチ、閾値別の指標

## 知っておくこと

- エージェントが返り値で申告した件数には誤りがあった（25 件のバッチを「20 件」「15 件」と書いた例がある）。
  出力ファイルは 160 個とも入力と一致していたので、件数の確認は申告ではなく `ingest` の照合で行っている。
- Sonnet の 13 体は、書いたファイルを読み戻して確かめていないと申告した。この 13 バッチも `ingest` の照合は通っている。
- 「プログラムを書かない」という指示に対し、書いた後の件数確認に短いスクリプトを使ったと申告したエージェントがある（判定には使っていないとの申告）。
- 判定のやり直しや多数決はしていない。各文献の判定は 1 モデルにつき 1 回。
