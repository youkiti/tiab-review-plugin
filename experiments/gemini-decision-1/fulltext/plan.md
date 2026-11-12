<!-- Gemini Decisions API の全文評価について承認済みの計画と実行手順を記録する。 -->
# Gemini Decisions API の全文評価計画

## 目的と決定事項

フルテキスト AI 判定で `gemini-decision-1` を選べるようにするかを決める。TypeSafe `jev-1.14.0` に劣らないときだけ組み込む。

入力は PDF を主とし、テキストも評価する。組入の確率で採点し、除外理由の選択と確率は参考情報とする。現行のフルテキスト判定（Gemini に PDF を渡す処理）は回さない。比較相手は同じ記録に対する `jev-1.14.0` の既存の確率である。

## データと出所

`CB = C:/Users/youki/codes/Cochrane-bench` とする。元データの [Cochrane-bench](<C:/Users/youki/codes/Cochrane-bench>) は読み取り専用で扱う。

| 層 | レビュー | 記録 | 陽性 | 陰性 | PDF の事前参考件数 |
|---|---:|---:|---:|---:|---:|
| cc-by | 32 | 1,274 | 723 | 551 | 1,217 |
| cc-by-nc | 132 | 5,186 | 2,557 | 2,629 | 5,047 |

PDF の事前参考件数は PMID のキャッシュ行に `.pdf` があるかを数えた値であり、`report_pmcid` の一致を用いた確定値ではない。`prepare.py` の実測値を manifest に保存し、差があれば報告する。記録・陽性・陰性の期待件数は変更せず、不一致なら停止する。

- 凍結入力: `CB/data/baseline/cc-by/jev-1.14.0-t03/task2_fulltext_oa/inputs/*.json` と `CB/data/baseline/cc-by-nc/haiku-5-5-agent/task2_fulltext_oa/inputs/*.json`。
- ゴールド: `CB/data/processed/<tier>/gold/task2_screening_oa.jsonl`。
- 研究対応: `CB/data/processed/<tier>/gold/task2_search_screen.jsonl`（採点コードの `GOLD_FILES["task2"]`）を `cochrane_bench.corpus.manifest.read_jsonl` と `Task2Gold` で読む。形の違うファイルを読んでも `Task2Gold` は空の対応表を返すので、`prepare.py` は対応表が空なら止める。CC BY の jev 閾値0.3の研究単位 Recall が README の 551 / 621 と一致することで、対応表が効いていることを確かめた。
- 本文: 入力の `xml_path` にある XML を `cochrane_bench.data_io.jats_fulltext.jats_to_screening_text` に渡し、先頭120,000文字を使う。
- PDF 対応: `CB/data/interim/<tier>/screening_fulltext_link_cache.jsonl`。PMID と `report_pmcid` が一致する報告の URL・MD5 を使う。
- 比較確率: [cc-by](<C:/tmp/dec1ft-inputs/jev_cc-by.jsonl>) と [cc-by-nc](<C:/tmp/dec1ft-inputs/jev_cc-by-nc.jsonl>)。キーは `(pmcid, pmid)`。出所は、Cochrane-bench で jev-1.14.0 を流したときの台帳。本人の Google ドライブの `coding-data/Cochrane-bench/fulltext-screening/` にある `round1-2026-11-04.zip` の `scratch/jev_ledger.jsonl`（1,274行）と、`round2-ccbync-2026-11-06.zip` の `jev_ledger.jsonl`（5,186行）から取り出した。同じ2本は `coding-data/tiab-review-plugin/gemini-decision-1-fulltext/round1-2026-11-12.zip` の `jev/` にもある。
- 実装: [prepare.py](prepare.py)、[fetch_pdfs.py](fetch_pdfs.py)、[runner.ts](runner.ts)、[decisions-fulltext.ts](decisions-fulltext.ts)、[common.ts](common.ts)、[metrics.ts](metrics.ts)、[summarize.ts](summarize.ts)、[config.json](config.json)、[selftest.ts](selftest.ts)。

Cochrane-bench の全文課題では PDF を使わない方針である。この実験の中だけで PDF を使い、ゴールドや公開物に入れない。本文・PDF・抄録・除外理由の原文を含む `data/` は git に入れない。レポートには論文の本文・抄録・タイトル・除外理由の文章を書かず、キーと数値だけを載せる。

## API の条件

モデルは `gemini-decision-1`。組入は `noul`、除外理由は既定の7区分の `choice` として同じ要求に二問を送る。両問の instructions は jev に渡した screening_prompt の原文に各質問を連結する。組入の質問は `Should this candidate study be included in the review at the full-text screening stage?` とする。

テキストの input は `Title: <title>\n\nFull text:\n<text>`。PDF の input はタイトルの text と、base64・`application/pdf` の document の配列とする。PDF の形式は項目表から組み立てた形であり、実 API での照合は実行担当者が行う。[decisions-fulltext.ts](decisions-fulltext.ts) の `pdfInput` 一か所にまとめる。

並列数8、最大5試行、要求タイムアウト120秒、PDF の上限50,000,000バイト。入力単価は100万トークンあたり0.10 USD、出力0 USDの仮値とし、実行担当者による料金照合前である。テキスト入力の全件は入力約65.6M トークン（jev の実績の合計）で約7ドル、PDF は試行で実測する。

## 解析と採用条件

1. 各層・各入力の比較は decision-1 の成功行がある集合で行い、jev も同じ集合で計算し直す。全記録の何件が入ったかを表示する。失敗した記録に確率を補わない。
2. cc-by でのみ閾値を凍結する。入力ごとに同じ成功集合での jev 閾値0.3の記録単位 Recall を R_jev とする。decision-1 の観測確率を候補にし、`確率 >= t` を組入として Recall(t) >= R_jev を満たす最大の t を t* とする。未完了があれば凍結しない。PDF では no_pdf・too_large を未完了から除く。閾値・R_jev・件数・日時・設定ハッシュを `results/thresholds.json` に保存し、`--force` なしでは上書きしない。
3. cc-by-nc では凍結済みの t* をそのまま使う。未凍結なら数値を出さず「閾値が未凍結」と書く。
4. 各層・各入力で decision-1 の t*・0.3・0.5 と jev の0.3・0.5について Recall・Specificity・Precision・TP/FP/TN/FN・研究単位 Recall を出す。ROC AUC は同点0.5の Mann–Whitney とする。対の AUC 差（decision-1 − jev）と95% CI は DeLong 法で計算する。構造成分 V10・V01 の標本分散・共分散を陽性数・陰性数で割って足す。陽性または陰性0件なら AUC・CI は「—」、各クラス2件未満なら CI は「—」とする。
5. PDF とテキスト両方の成功集合で、AUC 差（PDF − テキスト）と DeLong の95% CI を出す。
6. t* で除外した記録の理由キーの分布を出す。cc-by-nc の PDF から seed 2026 とキーの SHA-256 の昇順で最大50件を選び、`data/cc-by-nc/reason_sample_pdf.jsonl` にキー・選択理由・確率・ゴールドのラベルと理由を保存する。50件未満なら全件を選ぶ。採用判定には使わない。
7. cc-by-nc の同じ成功集合で、Recall と Specificity のそれぞれについて、decision-1（凍結した閾値 t*）− jev-1.14.0（閾値0.3）の対の差の95%信頼区間をレビュー単位のブートストラップで求める。元のレビュー数と同じ数のレビューを復元抽出し、選んだレビューの全記録で記録単位の micro 指標を計算する。2,000回、seed 2026 とし、分母が0の回は捨てて回数を表示する。有効な差の2.5%・97.5%分位点をパーセンタイル法（R type 7、昇順の添字 (n−1)p の両隣を線形補間）で求める。両方の CI 上限が0以上（有意に劣っていない）なら「満たす」とする。丸める前の値で比較し、算出不能なら判定を保留する。点推定の比較は参考として残す。主の判定は PDF。PDF が満たせば「組み込む」、PDF が満たさずテキストだけ満たす場合も「組み込まない」。

最初の判定は点推定の比較で行い、CC BY-NC の PDF 入力は満たさなかった（Recall 87.3% 対 jev 89.7%、Specificity 68.8% 対 63.5%）。本人の計画書へのコメント（2026-11-12、「そこは信頼区間かな」）を受け、判定を対の差の95%信頼区間（レビュー単位のブートストラップ）に改めた。閾値（CC BY で凍結）と台帳は変えていない。

改めた判定では、CC BY-NC の PDF 入力が「満たす」に変わった。Recall の差は −0.0238 で、95% CI は [−0.0495, +0.0009] である。上限が0をわずかに上回るので、乱数のぶれで判定が入れ替わらないかを、commander が Python（NumPy）で独立に計算して確かめた。seed を20通り、回数を2,000回と20,000回で流すと、CI 上限は 2,000回で +0.0005〜+0.0028、20,000回で +0.0012〜+0.0022 となり、20通りすべてで0以上だった。テキスト入力の Recall の CI 上限は、20通りすべてで0未満（−0.009〜−0.007）だった。

この判定は「有意に劣ってはいない」ことを見るもので、マージンを置いた非劣性の検定ではない。Recall の点推定は jev を2.4ポイント下回っており、CI の下限は −5.0ポイントである。

研究単位の数え方は [Cochrane-bench の metrics.py](<C:/Users/youki/codes/Cochrane-bench/src/cochrane_bench/eval/metrics.py>) の `score_task2_study_level` に合わせる。同じ成功集合のゴールド陽性に含まれる研究キーの集合を分母とし、同じ研究の記録が一件でも組入なら found とする。研究IDがなければ PMID 単独の研究とし、PMIDと研究IDを区別する。レビューの PMCID を研究キーに含め、別レビューの同名研究を混ぜない。全レビューの found / included_studies を micro Recall とする。

成功・失敗・送らなかった記録、入力トークン合計、modality 別合計、推定費用も層・入力ごとに出す。費用は成功した最終試行だけの集計で、失敗した試行の課金は不明である。

## 限界

- 現行の判定と比べないため「いまの既定より良いか」は分からない。
- PDF の結果を jev と並べるときは入力が違う。
- 付随報告にも組入ラベルが付くため記録単位の Recall は低めに出る。
- スキャン PDF は測れない。
- Decisions API は理由の文章を返さない。
- 入力が上限の262,144トークンを超える PDF は、API が HTTP 400 で恒久的に拒否する。runner は1回で打ち切って `too_long` として失敗台帳に残し、再実行では送らない。集計では送れない記録として件数を出し、比較の集合から外す（jev も同じ集合で計算し直す）。拡張機能で同じ PDF を送っても同じく拒否される。CC BY-NC の PDF で2件（45 MB と 2.9 MB）がこれに当たった。

## 実行手順

リポジトリルートで実行する。実 API と S3 に接続する操作はネットワークと認証を管理する実行担当者が行う。API キーは `GEMINI_API_KEY` を環境変数優先で読み、ルートの `.env` も読み込む。本文・応答本文・キー・例外全文はログに出さない。

git worktree には `.env` が無い。`.env` を写さずに本体のチェックアウトの `.env` を読ませるときは、`DOTENV_CONFIG_PATH=<本体>/.env DOTENV_CONFIG_QUIET=true npx.cmd ts-node -r dotenv/config ...` の形で起動する。

```powershell
$env:PYTHONUTF8='1'
python -B experiments/gemini-decision-1/fulltext/prepare.py --tier cc-by
python -B experiments/gemini-decision-1/fulltext/prepare.py --tier cc-by-nc
python -B experiments/gemini-decision-1/fulltext/fetch_pdfs.py --tier cc-by --concurrency 8
python -B experiments/gemini-decision-1/fulltext/fetch_pdfs.py --tier cc-by-nc --concurrency 8
```

試行は準備済み cc-by の次の3レビューで PDF とテキストを両方試す。

```powershell
$review1='PMC10011873'
$review2='PMC10164701'
$review3='PMC10175042'
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by --input pdf --review $review1 --review $review2 --review $review3
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by --input text --review $review1 --review $review2 --review $review3
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by --input pdf
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by --input text
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/summarize.ts --tier cc-by --freeze-threshold
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by-nc --input pdf
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/runner.ts --tier cc-by-nc --input text
npx.cmd ts-node --project experiments/gemini-decision-1/fulltext/tsconfig.json experiments/gemini-decision-1/fulltext/summarize.ts
```

`ts-node` は未導入なら取得が必要なため、ネットワークが使えない環境では上記を起動しない。型検査とローカル自己テストは次の手順で行う。

```powershell
node node_modules/typescript-7/bin/tsc --noEmit --project experiments/gemini-decision-1/fulltext/tsconfig.json
node node_modules/typescript-7/bin/tsc --noEmit --project experiments/gemini-decision-1/tsconfig.json
npx.cmd eslint experiments/gemini-decision-1/fulltext/*.ts
node node_modules/typescript-7/bin/tsc --project experiments/gemini-decision-1/fulltext/tsconfig.json --outDir $env:TEMP\dec1ft-build
$env:NODE_PATH='C:\tmp\wt-tiab-dec1ft\node_modules'
node $env:TEMP\dec1ft-build\experiments\gemini-decision-1\fulltext\selftest.js
```

小さな入力の確認には runner の `--records <records.jsonl>`、summarize の `--records-dir <tier別ディレクトリの親>` を使う。隣に同じ SHA-256 を持つ manifest が必要。`--fake` は実 API モジュールを読み込まず、台帳とレポートを `.tmp/gemini-decision-1-fulltext-fake/` に分離する。PDF の fake はファイル不要だが URL が null なら no_pdf として数える。自己テストは OS の一時ディレクトリで実行・集計を行い、最後にその専用ディレクトリを削除する。

## 中断・再開と終了コード

成功は1件ごとに `results/<tier>_<input>_v1.jsonl`、最終失敗は同じ接頭辞の `.failures.jsonl` へ追記する。再実行すると成功キーを除く未成功分だけ送る。キーごとに最終行を使うが、古い行も設定ハッシュの検査対象とする。壊れた行は件数を警告し、改行のない末尾は次の追記前に改行で切り離す。本文・プロンプト・PDF・タイトルは台帳に残さない。

PDF は MD5 が一致する既存ファイルを再利用する。GET の最大5回の再試行は2秒×2^(n−1)×1〜2のジッタ、上限60秒。404 は再試行せず、MD5 不一致は一回だけ取り直す。API の429・529は全ワーカーに待ち時間を共有する。401・403・404では新規送信を止め、実行中の応答を回収する。

| 処理 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| prepare | 照合・保存完了 | 照合・設定・入出力失敗 | — | — |
| fetch_pdfs | 全件 ok | 入出力失敗 | 取得失敗あり | — |
| runner | 全対象完了。no_pdf・too_large は除く | 設定・入出力・pdf_missing | 再試行上限で未完了 | 再試行不可 |
| summarize / selftest | 正常終了 | 検証・処理失敗 | — | — |

runner が pdf_missing を表示したら PDF 取得をやり直して再実行する。設定ハッシュが違う台帳を混ぜない。凍結前の全件完了と、cc-by-nc に同じ凍結閾値を使う順序を守る。レポートの生成は実装の動作確認であり、公開や組込みの承認を意味しない。
