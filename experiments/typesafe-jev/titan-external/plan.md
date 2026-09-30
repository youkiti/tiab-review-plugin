# TITAN-SR 外部検証計画

## 目的・データ

TypeSafe `jev-1.13.0` の総合 Noul 1問を、TITAN-SR と ASReview とレビュー単位で比較する。
元データは [Chan et al. 2025](https://doi.org/10.1017/rsm.2025.1) の manual_search、
[Mendeley](https://doi.org/10.17632/7sgmg89zb6) に由来する Cochrane 22レビュー。
比較論文は [Pitre et al. 2026](https://doi.org/10.1016/j.jclinepi.2026.112514)。
ローカル入力は `C:\Users\youki\codes\Cochrane-bench\data\chen\processed\manual_search.jsonl`。
SHA-256 は `69c1a38e0842be7a8794fdb0676b408d222bf8973b5615639802f40a1b890493`。
原文データ・成功レジャはコミットせず、本文を含まない圧縮スコア要約をコミットする。

全142,504件、採用768件、抄録なし6,048件。レビュー別の期待値と原文から抽出した基準は
[config.json](config.json) に固定する。ID は `cochrane_id:レビュー内の0始まり出現順`。
candidate_id は使用しない。[prepare.ts](prepare.ts) がストリームで読み、全行の基準、
件数・採用数・抄録なし・SHA-256を照合した後、各ファイルを一時名からrenameする。
不一致ではデータを書かない。書き込み中のI/O障害は全ファイル一括の原子的更新ではないため、prepareを再実行する。

## 判定条件・解析

[run.ts](run.ts) は [親runner.ts](../runner.ts) の runRecords を使い、レビューを1件ずつ順番に実行する。
レビュー内の並列数は4。再試行は最大5回、基礎待機2秒、上限60秒。
プロンプトは [親config.json](../config.json) の defaultScreeningPrompt を実行時に読み、
`{{CRITERIA}}` を原文の selection_criteria で置換する。雛形を複製しない。
model・questionDesign・置換済みscreeningPrompt・outputLanguageのJSONからSHA-256を計算する。
dataset は cochrane_id、出力言語はen。プロンプト本文・APIキーをログや成功レジャに記録しない。

主解析は全件。抄録が空なら空文字のままプロバイダへ渡す。
副解析は抄録あり136,456件（採用639件）：抄録なし6,048件、うち採用129件を除く。
論文l.492の「136,456-record external set」と件数が一致するため同じ条件と推定するが、
本文に除外の記載がないため断定しない。

[metrics.ts](metrics.ts) は目標Recallの整数百分率rについて必要陽性数を `ceil(r*N陽性/100)` とし、
陽性確率を降順に並べた必要順位の値を閾値にする。同点はすべてスクリーニングする保守的定義。
S@99R/S@95Rはそれぞれの閾値での特異度（TN/陰性数）。
work_savedは非スクリーニング割合、WSS@95はその割合から0.05を引いた値。
閾値0.3（主）と0.5（参考）のRecall・Specificity・FN、順位法AUCも報告する。
AUCと固定閾値指標は [親ledger.ts](../ledger.ts) を使用する。
中央値・IQRはNumPy既定相当の線形補間。陽性なしの操作点、陰性なしの特異度、
片クラスだけのAUCは算出不能とし、中央値から除外して有効レビュー数を記載する。

[summarize.ts](summarize.ts) は設定と `scores/*.jsonl.gz` だけを読み、本文データ・レジャを必要としない。
正式要約があれば優先し、なければ `.partial` 要約を暫定として集計する。両方を混合しない。
未完了分を分母に含めない暫定結果は欠測の偏りがある。全件結果との性能比較には使わない。
比較値はPitre et al. 図3Bの目視読み取り概数（±0.01程度）。CD013421は凡例で隠れ、nullとして比較から除外する。
Jevとの上下・同値は丸める前の値で判定するが、図の読み取り誤差より小さい差には解釈上の限界がある。
論文表2の中央値は別に提示し、考察は自動生成しない。

## 実行手順

リポジトリ直下で実行する。Windowsでは `npx` を `npx.cmd` とする。
ts-nodeが未導入のオフライン環境では、依存を追加せずtscでOS一時ディレクトリへコンパイルしてnodeで検証する。
実APIによる全件実行と正式report.md生成はコマンダーが行う。

```sh
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/prepare.ts --input "C:/Users/youki/codes/Cochrane-bench/data/chen/processed/manual_search.jsonl"
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/metrics.selftest.ts
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/run.ts --fake --review CD011218 --review CD015306
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/export-scores.ts --fake --allow-partial
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/summarize.ts --fake
```

fakeのレジャ・要約・レポートは `.tmp/typesafe-jev-titan-fake/` に隔離する。
fakeはプロバイダを読み込まない。永久失敗が含まれるため終了2が正常な検証結果となる。
実実行は環境変数 `TYPE_SAFE_API_KEY` または既存runnerが読むリポジトリ直下の `.env` に設定する。

```sh
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/run.ts --concurrency 4
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/export-scores.ts
npx ts-node --project experiments/typesafe-jev/titan-external/tsconfig.json experiments/typesafe-jev/titan-external/summarize.ts
```

## 中断・再開・コスト

成功した1件ごとに追記し、再実行ではキーごと最終成功行を読み、既存件をスキップする。
失敗に偽の確率を付けて保存しない。設定ハッシュが異なるレジャは停止し、設定を戻すか版を変える。
終了コードは全件完了0、設定・入出力1、再試行上限で未完了2、再試行不可3。
3または保存失敗1では後続レビューを実行しない。2なら後続へ進む。
同じコマンドで再開できる。`--review` を複数指定するとそのレビューだけを設定順に実行する。
要約は未完了があれば書かずに停止。`--allow-partial` の場合は `.partial.jsonl.gz` に書く。

最低142,504成功リクエスト。各起動で最大5試行なら上限712,520試行で、再開を繰り返すとこれを超え得る。
単価は未確定のため金額を断定しない。小規模な実行で成功レジャの入力・出力トークンを集計し、
`(推定入力トークン×入力単価 + 推定出力トークン×出力単価)/1,000,000` で全件コストを見積もる。
失敗試行の課金は成功レジャに含まれないため別途加味する。スコア要約には課金情報は保存しない。

自己テストは [metrics.selftest.ts](metrics.selftest.ts)。要約生成は [export-scores.ts](export-scores.ts)、
共通入出力は [common.ts](common.ts)。親の設定・レジャ・結果は変更しない。

## 実行記録（2026-09-30）

- 全142,504件を完了した。成功レジャの入力は計131.8Mトークン（1件平均約925）、出力は2,850,080トークン。
  利用者の実績単価（71.1Mトークンで2.7ドル、約0.038ドル／100万トークン）で約5.0ドル、OpenRouter 単価（0.042ドル）で約5.5ドル。
  失敗試行の課金は含まない。
- 初回実行で再試行を使い切った記録は CD013822 の4件と CD014715 の1件。同じコマンドの再実行で判定した。
- CD013042 の4件は初回に成功したが、`latency_ms` が負（−1,133〜−1,283 ms）だったため `readLedger` の検証で読み飛ばされ、
  再実行で判定し直した。4件とも記録時刻が 2026-09-29T22:58:20Z で、PC の時計がこの時点で約1.5秒戻ったとみられる
  （所要時間を `Date.now()` の差で測っているため）。集計にはキーごとの最終行（再実行分）を使った。

## 抄録欄の長い記録

抄録欄には論文の抄録ではない長い記録が含まれる。長いものは試験登録の詳細説明やプロトコル全文で、
タイトルと抄録の分割の誤りではない（`[TIT]`・`[ABS]` などのタグが残った記録は0件）。切り詰めずに送った。

| 抄録の文字数（抄録なし6,048件・採用129件を除く） | 件数 | うち採用 |
|---|---:|---:|
| 1〜3,000 | 126,945 | 620 |
| 3,000超〜5,000 | 6,830 | 16 |
| 5,000超〜10,000 | 2,170 | 3 |
| 10,000超 | 511 | 0 |

最長は31,829文字。採用論文の抄録は中央値1,624文字、最長7,792文字。
TITAN-SR は入力を512トークン（約380語）で切り、同論文の LLM ベンチマークの公開コードは抄録を1,500文字で切る。
この22件では抄録の64.1%（91,376件）が1,500文字を超える。
