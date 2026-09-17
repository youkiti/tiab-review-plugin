# TypeSafe jev-1.13.0 評価計画

## 目的と条件

TiAb スクリーニング性能を既存モデルと同じデータ・プロンプト・指標で測る。
実 API での50件試行、全件実行、結果の考察は別途実施する。

- データ: 下表の6件。起動時に件数・陽性数・抄録なし件数とIDの一意性を照合し、不一致なら停止する。depression は配列、CQ はオブジェクトの `records` 配列を読み、ラベルを内部で `label_included` に正規化する。
- モデル: `jev-1.13.0`、質問設計: `overall-noul`、出力言語: `en`。
- [TypeSafeプロバイダ](../../src/lib/providers/typesafe.ts) の `screenViaTypeSafe` を `criteria` 引数なしで呼び、総合 Noul 1問の `include_probability` を評価する。
- 既存の `defaultScreeningPrompt` と depression の criteria は維持する。CQ の criteria は [experiments.json](../experiments.json) の `datasetConfigs.cq1`〜`cq5.criteria` をそのまま複製し、`{{CRITERIA}}` を置換する。共通プロンプトは同ファイルの `defaultScreeningPrompt` と同一。
- `確率 >= 閾値` を include とする。拡張機能の既定閾値で評価するため主の閾値を0.3とし、過去の全モデル比較に使われた0.5を参考として併記する。Recall・Specificity・Precision・Fβ(7)・TP/FP/TN/FN の計算式は変更しない。
- 並列数4、最大5試行（初回を含む）。バックオフは2秒×2^(試行番号−1)に1以上2未満のジッタ係数を掛け、60秒で上限を設ける。
- 単価は未設定。`pricing` に `{ "inputPerMillion": 数値, "outputPerMillion": 数値 }`（USD）を設定すれば成功試行の推定コストを算出する。

| キー・元データ | ラベル列 | N | 陽性 | 抄録なし（`!abstract`） |
|---|---|---:|---:|---:|
| [depression](../../scripts/asreview-baseline/datasets/depression_slim_labeled.json) | label_included | 1993 | 280 | 394 |
| [cq1](../../scripts/asreview-baseline/datasets/cq1_labeled.json) | label | 5628 | 113 | 119 |
| [cq2](../../scripts/asreview-baseline/datasets/cq2_labeled.json) | label | 3400 | 17 | 129 |
| [cq3](../../scripts/asreview-baseline/datasets/cq3_labeled.json) | label | 1038 | 16 | 97 |
| [cq4](../../scripts/asreview-baseline/datasets/cq4_labeled.json) | label | 4326 | 72 | 77 |
| [cq5](../../scripts/asreview-baseline/datasets/cq5_labeled.json) | label | 2253 | 41 | 27 |

## 中断耐性

[runner.ts](runner.ts) が成功1件ごとに [ledger.ts](ledger.ts) の `fs.appendFileSync` で追記する。
保存先は `results/<dataset>_<model>_overall_<ledgerVersion>.jsonl`。
depression は既存の `results/depression_jev-1.13.0_overall_v1.jsonl` をそのまま使う。
データセットは1つずつ順番に実行し、ランナーを同時に起動しない。

- 読み込みはキーごとに最終行勝ち。壊れた行は件数を警告し、末尾が改行なしなら次の追記前に改行を補う。
- 起動ごとに既存の完了記録を除外し、「既存 N 件をスキップ、未処理 M 件」を出す。50件処理ごとと最後に記録数による進捗を出す。
- リトライを使い切った失敗は保存しない。次回起動で未処理分として再試行する。JSONパース失敗・タイムアウト・その他4xxも再試行する。
- `retryable === false`（401・403・Unknown model の400）では新規リクエストを停止し、実行中の応答を回収・保存してから終了する。理由は分類だけを表示し、エラー本文は出さない。
- 429/529 は全ワーカー共有の期限を延長し、その間は新しいリクエストも再試行も送らない。
- 全行の `config_hash` を重複圧縮前に検証する。モデルID・質問設計・置換済みプロンプト全文・出力言語を SHA-256 に含める。変更した設定の結果は混ぜず、異なる版タグを使う。
- ハッシュ計算式は `{ model, questionDesign, screeningPrompt, outputLanguage }` の JSON の SHA-256 のまま。閾値は集計だけの設定であり含めない。depression の既存ハッシュ `4225c6efdffebb1fd037f4d6e596785745835487c5ddb3b4b1dca638a95c1ecc` を維持する。
- `--smoke` の50件は seed `2026` の疑似乱数で初回に選び、`results/smoke_sample_<dataset>_<smokeSampleSize>.json` にID配列を凍結する。depression は既存の `results/smoke_sample_depression_50.json` をそのまま使う。既存ファイルが不正なら選び直さず停止する。試行と全件は同じレジャを使う。
- APIキー・リクエスト本文はログやレジャに保存しない。
- 終了コード: 全対象完了0、再試行上限到達2、再試行不可3。設定・入出力エラーは1。
- 逐次追記はプロセス中断からの再開を目的とする。OSや媒体の電源断に対する fsync の保証は含まない。

## 実行

リポジトリ直下で実行する。`TYPE_SAFE_API_KEY` は環境変数を優先し、直下の `.env` からも読む。

```sh
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/runner.ts --dataset cq1 --smoke
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/runner.ts --dataset cq1
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/summarize.ts
```

Windows PowerShell では `npx` を `npx.cmd` に置き換える。並列数は `--concurrency N` で上書きできる。
`cq2`〜`cq5` も同様にキーを指定する。データセットは1つずつ順番に実行し、同時に起動しない。
`--dataset` 省略時は `depression`。未定義のキーは理由を1行表示して終了する。
オフライン確認は各コマンドに `--fake` を追加する。偽応答はキー不要で、プロバイダも読み込まない。
レジャ・標本・レポートは全て `.tmp/typesafe-jev-fake/` に分離する。
IDのSHA-256先頭32bitを確率へ変換し、剰余10が0なら初回だけ失敗、剰余97が0なら毎回失敗する。
fake の待機は1ms。永久失敗がある実行の終了コード2は想定どおりである。

## 集計と採用判断

[summarize.ts](summarize.ts) はデータセットのラベルを正として突き合わせ、不一致を警告する。
全データセットを調べ、レジャがないものは「未実行」、完了件数がNに満たないものは「暫定」とする。未完了を陰性として補完しない。
出力は共通条件・各 config_hash、概要表、レジャがあるデータセットの詳細節を含む単一の `report.md`。
`pooledGroup`（cq1〜cq5）の合算は、レジャがあるデータセットの混同行列を加算するマイクロ平均。
1つでも未完了・未実行なら合算も暫定とし、完了件数 / 合計16645件と未実行キーを併記する。
陽性が少ない cq2（17件）・cq3（16件）は、見落とし1件で Recall がそれぞれ約5.88・6.25ポイント動く。概要表に陽性数から計算した脚注を付ける。
両閾値・既存比較・閾値スイープ・確率分布・応答モデル内訳・成功試行のトークンとレイテンシを出す。
Recall ≥95%の最大閾値は固定スイープ点ではなく全実測確率から探索する。
WSS@95 = (TN+FN)/完了件数 − 0.05、ROC AUC は同順位を0.5とする順位法。

以下の既存規則を主の閾値0.3の Recall に適用して機械的に判定する。

- Recall ≥95%: 採用候補。Precision・コスト・レイテンシで B4 との比較が必要。
- 93% ≤ Recall <95%: フォールバック枠。
- Recall <93%: 不採用。

比較値は設定に出典と閾値0.5を保存する。不明な Specificity・Precision・Fβ(7) は `null` のまま保持する。
CQ の比較は [flash-lite GA レポートの Phase 2 結果](../gemini-3.1-flash-lite-ga/report.md) に基づく。
合算の B4 Recall は各CQの Recall と陽性数から TP を逆算した257/259、flash-lite は混同行列の合計236/4631/11755/23による。
レポートには考察を自動生成しない。暫定値や偽応答による判定は最終採用判断に使用しない。
