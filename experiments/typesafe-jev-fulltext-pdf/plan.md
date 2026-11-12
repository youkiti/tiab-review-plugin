<!-- 拡張の本文抽出で TypeSafe jev-1.14.0 の全文判定を確かめる評価の計画と実行手順。 -->
# 拡張の本文抽出での jev-1.14.0 の全文評価

## 目的

フルテキスト AI 判定で TypeSafe `jev-1.14.0` を選べるようにした。jev は PDF を受け取れないので、拡張は PDF から本文の文字を取り出し、参考文献の節を落とし、先頭から 85,000 字までを送る。公開の前に、この抽出と同じ要求で Cochrane-bench の全文課題を流し、次を確かめる。

1. 従来の jev の全文の結果（Cochrane-bench の XML から作った本文を送ったもの）から、閾値0.3の記録単位 Recall が下がらないか。従来の値は、全記録で CC BY 86.7%、CC BY-NC 89.7%（README「外部ベンチマーク」）。
2. jev が選んだ除外理由が、Cochrane の除外理由と一致するか。

## 決めたこと（オーナー、2026-11-12。Issue #362）

- 判定は組入の確率に閾値0.3を当てた2値で、保留は出さない。
- 除外理由はプロジェクトの除外理由リストから Choice で選ばせる。評価では拡張の既定の7区分（`DEFAULT_EXCLUDE_REASON_ITEMS`）を使う。
- 抽出での精度が従来から下がった場合の扱いは、結果を見てオーナーが決める。

## データ

- 記録と PDF は [gemini-decision-1 の全文評価](../gemini-decision-1/fulltext/plan.md) の `prepare.py` と `fetch_pdfs.py` で作ったものを使う（`experiments/gemini-decision-1/fulltext/data/<tier>/`。git に入れない）。元データは [Cochrane-bench](<C:/Users/youki/codes/Cochrane-bench>) の凍結入力とゴールドで、出所と件数はその計画書の「データと出所」節にある。
- 比較の確率（XML 由来の本文での jev-1.14.0）は records の `jev_probability`。出所は同じ計画書の「比較確率」。
- 件数: CC BY 1,274 記録（組入 723、除外 551）、CC BY-NC 5,186 記録（組入 2,557、除外 2,629）。PDF があるのは CC BY 1,217、CC BY-NC 5,047 記録。

## 要求の条件

拡張の処理をそのまま使う。抽出は `src/lib/pdf-text-extract.ts`（`extractTextFromPdfDocument`・`prepareFulltextForTypeSafe`）、要求と再試行は `src/lib/typesafe-fulltext.ts`（`judgeFulltextViaTypeSafe`）。評価で書いたのは、Node で pdfjs を開く部分（[extract.ts](extract.ts)）と台帳・集計だけである。

- スクリーニングの基準は records の `screening_prompt`（従来の jev の評価と同じ文）。
- 従来の評価とは、本文の作り方のほかに、送る項目（従来は本文を `abstract` に入れた。今回は `full_text`）と組入の質問の文も違う。差が出たときに、どれが効いたかはこの評価では分けられない。
- 並列64、1記録最大3試行。入力の上限を超えたもの（`max_tokens_exceeded`）は再試行せず `too_long` として数える。

## 解析

- 比較の集合は、今回の要求が成功した記録。XML 側もこの集合で計算し直す。
- 閾値0.3と0.5で、記録単位の Recall・Specificity・Precision、ROC AUC、研究単位 Recall を出す。研究単位の数え方は gemini-decision-1 の全文評価と同じ。
- 判定: 比較の集合で、PDF 抽出の閾値0.3の記録単位 Recall が XML の閾値0.3の記録単位 Recall 以上なら「下がっていない」。
- 除外理由: ゴールドが除外で、jev も除外と判定した記録で、Cochrane の除外理由の文を正規表現で区分に寄せ（[reasons.ts](reasons.ts)）、jev の選んだ区分と比べる。寄せ方は評価のための近似で、Cochrane-bench の正解ではない。当てはまる区分が無い文（`unmapped`）は一致の計算から外し、件数を出す。

## 実行手順

リポジトリのルートで実行する。worktree には `.env` が無いので、本体のチェックアウトの `.env` を読ませる。

```powershell
$env:PYTHONUTF8='1'
python -B experiments/gemini-decision-1/fulltext/prepare.py --tier cc-by
python -B experiments/gemini-decision-1/fulltext/prepare.py --tier cc-by-nc
python -B experiments/gemini-decision-1/fulltext/fetch_pdfs.py --tier cc-by --concurrency 8
python -B experiments/gemini-decision-1/fulltext/fetch_pdfs.py --tier cc-by-nc --concurrency 8
node node_modules/typescript-7/bin/tsc --project experiments/typesafe-jev-fulltext-pdf/tsconfig.json --outDir $env:TEMP\ftjev-eval-build
$env:DOTENV_CONFIG_PATH='C:/Users/youki/codes/tiab-review-plugin/.env'; $env:DOTENV_CONFIG_QUIET='true'
node -r dotenv/config $env:TEMP\ftjev-eval-build\experiments\typesafe-jev-fulltext-pdf\runner.js --tier cc-by --review PMC10011873
node -r dotenv/config $env:TEMP\ftjev-eval-build\experiments\typesafe-jev-fulltext-pdf\runner.js --tier cc-by
node -r dotenv/config $env:TEMP\ftjev-eval-build\experiments\typesafe-jev-fulltext-pdf\runner.js --tier cc-by-nc
node $env:TEMP\ftjev-eval-build\experiments\typesafe-jev-fulltext-pdf\summarize.js
```

成功は1件ごとに `results/<tier>_v1.jsonl`、送らなかった・失敗した記録は `results/<tier>_v1.failures.jsonl` に追記する。同じコマンドを流し直すと、未成功の分だけ送る。台帳にはキーと数値だけを残し、本文・タイトル・応答の全文は残さない。
