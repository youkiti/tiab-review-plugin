# 評価結果の公開物を作る（Zenodo、Issue #307）

README.md とヘルプに載せている AI 判定の評価について、生の結果とレポートを Zenodo に公開するための zip と目録を手元に作るスクリプト。Zenodo へは通信しない。上げるのはオーナーの手作業。

## 実行

```
npm run zenodo:eval:pack -- --commit <sha>      # 既定は HEAD
npm run zenodo:eval:pack -- --verify [--date YYYY.MM.DD]   # 出力の検査だけ
```

- そのコミットの内容から作る（`git cat-file` で読むので、作業ツリーの未コミットの変更は混ざらない）。公開物は、マージ後の main のコミットで作ること。
- 出力先は `.tmp/zenodo-eval/<YYYY.MM.DD>/`（`.gitignore` 済み）。`--out` で変えられる。
- 出力: `README.md`・`METHODS.md`・`SOURCES.md`・`manifest.csv`・`labels/*.csv`・ディレクトリごとの zip。最後に合計バイト数・ファイル数・ファイルごとのサイズを表示する。ファイル数は Zenodo の1レコード100の上限以下に収める（超えたら失敗する）。
- 作り終えたあとに自動で検査する。`--verify` は同じ検査を既存の出力に対して行う: manifest の sha256・容量が zip の中身（と top の各ファイル）と一致すること、`"quote"` と `\"quote\"` が1件も残っていないこと、`labels/*.csv` が `id,label_included` の2列だけであること。

## 規則

1. 題名・抄録・全文は、どのデータセットについても入れない。入れるのは評価結果（ID、AI の出力、確率、トークン数など）と、ライセンスで再配布が認められたデータセットの `labels/<データセット>.csv`（列 `id,label_included`）だけ。
2. 再配布を確かめられないデータセット（CQ1〜5 を含む）のラベルは入れない。`SOURCES.md` の「再配布の可否」を確かめて、`pack.mjs` の `REDISTRIBUTABLE_LABEL_DATASETS` に名前を足したものだけが `labels/` に出る。
3. JSON・JSONL（`.bak` を含む）の結果は、`evidence[]` の要素から `field`・`start_char`・`end_char` だけを残し、`quote` などほかの項目を落とす。`note` のように JSON を文字列で持つ値は、解釈できれば中を同じ規則で処理して戻す。数値の表記（`1.0` を `1` に書く等）は JSON を書き戻すときに正規化されることがある。ソースコード（`.ts`・`.mjs`・`.py`）は結果ではないので手を入れず、`quote` の検査の対象にもしない。
4. 入れる評価のディレクトリは `pack.mjs` の `INCLUDED_DIRS`。コミットに無いもの（結果がまだ無い `anthropic-bench`、B4 の元の結果を置く `gemini-3-flash-preview` など）は飛ばす。入れないものは `EXCLUDED_DIRS`。`experiments/` 直下の文字化けした単発の試行の出力（`test_model_b_debug.txt`・`test_model_b_output.txt`）も入れない。
5. CQ の xlsx の復号パスワードと `scripts/asreview-baseline/` の元データ（題名・抄録つき）は入れない。

## Zenodo への上げ方（オーナーの作業）

1. 公開するコミット（マージ後の main）で `npm run zenodo:eval:pack -- --commit <sha>` を実行し、`SOURCES.md` を確かめる。
2. <https://zenodo.org> で「New upload」、種類は Dataset。
   - タイトル: `TiAb Review: developer-run evaluation results of AI title/abstract and full-text screening`
   - 著者: ソフトウェアのレコード（`.zenodo.json`）と同じ11名、同じ順。所属と ORCID は本人が記入する。
   - 版: 作成日 `YYYY.MM.DD`。説明の先頭に `Generated from commit <sha> of https://github.com/youkiti/tiab-review-plugin`。
   - ライセンス: 結果とレポートは CC BY 4.0、同梱のコードは MIT。ラベルの表は元データのライセンスに従う（`SOURCES.md`）。
   - 関連識別子: ソフトウェアの concept DOI に `isSupplementTo`、各元データの DOI に `isDerivedFrom`、`https://github.com/youkiti/tiab-review-plugin/tree/<sha>` に `isSupplementTo`。
   - ファイル: `.tmp/zenodo-eval/<日付>/` の全ファイル。
3. 公開したら concept DOI を `src/lib/citation.ts` の `AI_EVALUATION_DATASET_DOI` に入れ、README のベンチマーク節とヘルプの `#ai-limitations` に DOI の1段落を足す（論文用テキストは定数が空でなくなると自動で DOI の1文を出す）。

## 今後モデルを足したとき

1. 新しいモデルの評価を `experiments/<dir>/`（plan・report・results）に置き、README の表と詳細レポートの一覧を更新する PR をマージする。
2. 同じ PR で `pack.mjs` の `INCLUDED_DIRS` に `<dir>` を足す。採用を見送ったモデルも、README の表に載せたなら入れる。
3. マージ後、オーナーが main で上のコマンドを実行し、Zenodo のレコードで「New version」を作って全ファイルを上げ直す。版は作成日、説明のコミットを更新する。
4. concept DOI は変わらないので、README・ヘルプ・論文用テキストの DOI は直さない。

## テスト

`node --test scripts/zenodo-eval/pack.test.mjs`（`npm run test:tools` に含まれる）。
