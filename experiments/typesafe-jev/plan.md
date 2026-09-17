# TypeSafe jev-1.13.0 評価計画

## 目的と条件

TiAb スクリーニング性能を既存モデルと同じデータ・プロンプト・指標で測る。
実 API での50件試行、全件実行、結果の考察は別途実施する。

- データ: [depression_slim_labeled.json](../../scripts/asreview-baseline/datasets/depression_slim_labeled.json)。1,993件、陽性280件、ID重複なし、抄録なし394件。起動時に照合し、不一致なら停止する。
- モデル: `jev-1.13.0`、質問設計: `overall-noul`、出力言語: `en`。
- [TypeSafeプロバイダ](../../src/lib/providers/typesafe.ts) の `screenViaTypeSafe` を `criteria` 引数なしで呼び、総合 Noul 1問の `include_probability` を評価する。
- [gpt-5.6/config.json](../gpt-5.6/config.json) の `defaultScreeningPrompt` と depression の criteria を [config.json](config.json) にそのまま複製。`{{CRITERIA}}` を置換する。
- `確率 >= 閾値` を include とする。主閾値0.5、拡張機能既定0.3。Recall・Specificity・Precision・Fβ(7)・TP/FP/TN/FN は [既存ランナー](../gpt-5.6/runner.ts) と同じ式。
- 並列数4、最大5試行（初回を含む）。バックオフは2秒×2^(試行番号−1)に1以上2未満のジッタ係数を掛け、60秒で上限を設ける。
- 単価は未設定。`pricing` に `{ "inputPerMillion": 数値, "outputPerMillion": 数値 }`（USD）を設定すれば成功試行の推定コストを算出する。

## 中断耐性

[runner.ts](runner.ts) が成功1件ごとに [ledger.ts](ledger.ts) の `fs.appendFileSync` で追記する。
保存先は `results/depression_jev-1.13.0_overall_v1.jsonl`。
同じレジャに対するランナーの同時起動は行わない。

- 読み込みはキーごとに最終行勝ち。壊れた行は件数を警告し、末尾が改行なしなら次の追記前に改行を補う。
- 起動ごとに既存の完了記録を除外し、「既存 N 件をスキップ、未処理 M 件」を出す。50件処理ごとと最後に記録数による進捗を出す。
- リトライを使い切った失敗は保存しない。次回起動で未処理分として再試行する。JSONパース失敗・タイムアウト・その他4xxも再試行する。
- `retryable === false`（401・403・Unknown model の400）では新規リクエストを停止し、実行中の応答を回収・保存してから終了する。理由は分類だけを表示し、エラー本文は出さない。
- 429/529 は全ワーカー共有の期限を延長し、その間は新しいリクエストも再試行も送らない。
- 全行の `config_hash` を重複圧縮前に検証する。モデルID・質問設計・置換済みプロンプト全文・出力言語を SHA-256 に含める。変更した設定の結果は混ぜず、異なる版タグを使う。
- `--smoke` の50件は seed `2026` の疑似乱数で初回に選び、`results/smoke_sample_depression_50.json` にID配列を凍結する。既存ファイルが不正なら選び直さず停止する。試行と全件は同じレジャを使う。
- APIキー・リクエスト本文はログやレジャに保存しない。
- 終了コード: 全対象完了0、再試行上限到達2、再試行不可3。設定・入出力エラーは1。
- 逐次追記はプロセス中断からの再開を目的とする。OSや媒体の電源断に対する fsync の保証は含まない。

## 実行

リポジトリ直下で実行する。`TYPE_SAFE_API_KEY` は環境変数を優先し、直下の `.env` からも読む。

```sh
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/runner.ts --smoke
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/runner.ts
npx ts-node --project experiments/typesafe-jev/tsconfig.json experiments/typesafe-jev/summarize.ts
```

Windows PowerShell では `npx` を `npx.cmd` に置き換える。並列数は `--concurrency N` で上書きできる。
オフライン確認は各コマンドに `--fake` を追加する。偽応答はキー不要で、プロバイダも読み込まない。
レジャ・標本・レポートは全て `.tmp/typesafe-jev-fake/` に分離する。
IDのSHA-256先頭32bitを確率へ変換し、剰余10が0なら初回だけ失敗、剰余97が0なら毎回失敗する。
fake の待機は1ms。永久失敗がある実行の終了コード2は想定どおりである。

## 集計と採用判断

[summarize.ts](summarize.ts) はデータセットのラベルを正として突き合わせ、不一致を警告する。
完了件数が1,993に満たない見出しには「暫定」を付ける。未完了を陰性として補完しない。
両閾値・既存比較・閾値スイープ・確率分布・応答モデル内訳・成功試行のトークンとレイテンシを出す。
Recall ≥95%の最大閾値は固定スイープ点ではなく全実測確率から探索する。
WSS@95 = (TN+FN)/完了件数 − 0.05、ROC AUC は同順位を0.5とする順位法。

[gpt-5.6/report.md](../gpt-5.6/report.md) と [openrouter-bench/plan.md](../openrouter-bench/plan.md) に基づき、主閾値0.5で機械的に判定する。

- Recall ≥95%: 採用候補。Precision・コスト・レイテンシで B4 との比較が必要。
- 93% ≤ Recall <95%: フォールバック枠。
- Recall <93%: 不採用。

比較値は設定に出典とともに保存する。不明な Specificity は `null` のまま保持する。
レポートには考察を自動生成しない。暫定値や偽応答による判定は最終採用判断に使用しない。
