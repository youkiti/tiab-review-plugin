# 元データの出典とライセンス（Issue #307）

評価に使った元データの出典と、公開物（Zenodo のデータセット）に入れてよいかの判断。**題名・抄録・全文は、どのデータセットについても公開物に入れない。** 入れてよいのは、再配布が認められたデータセットの `id` と正解ラベルの表（`labels/<データセット>.csv`、列 `id,label_included`）だけ。

## 確認の状況

下の表の「ライセンス」「確認日」「再配布の可否」は **未確認**。実装した環境からは zenodo.org などの出典のページに接続できず（プロキシが拒否）、ライセンスを読めなかったため、推測では埋めていない。オーナーが各ページを開いて表を埋め、再配布が認められたものだけ `scripts/zenodo-eval/pack.mjs` の `REDISTRIBUTABLE_LABEL_DATASETS` にデータセット名を足す（名前は下の表の「pack.mjs の名前」）。足すまで `labels/` は空で、README に「ラベルの表は入れていない」と書かれる。

## 表

| データセット | pack.mjs の名前 | 出典 DOI | ライセンス | 確認日 | 確認したページの URL | 再配布の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| depression（SLIM の訓練セット。前臨床のうつ病の SR） | `depression` | 10.5281/zenodo.151190 | 未確認 | 未確認 | https://doi.org/10.5281/zenodo.151190（未確認） | 未確認（確認できるまで入れない） |
| wilson（Wilson 病の SR） | `wilson` | 10.5281/zenodo.3625931（元論文 10.1111/liv.14179） | 未確認 | 未確認 | https://doi.org/10.5281/zenodo.3625931（未確認） | 未確認（確認できるまで入れない） |
| CQ1〜5（日本の診療ガイドライン作成のための SR） | `cq1-5` | なし（リポジトリ内の記述は `generate_datasets.py` の docstring「`vendor/llm-citation-screening/Data/` から」のみ） | 未確認（xlsx はパスワードで暗号化されている） | 未確認 | なし | 未確認。出典の研究者に公開の可否を確かめるまで入れない |
| Cochrane（Mendeley。TITAN-SR の外部検証） | `cochrane-mendeley` | 10.17632/7sgmg89zb6（Chan et al. 2025、10.1017/rsm.2025.1） | 未確認 | 未確認 | https://doi.org/10.17632/7sgmg89zb6（未確認） | 未確認（確認できるまで入れない） |
| ASReview の例（Cohen 2006・Kwok 2020・Wolters 2018） | （対象外） | リポジトリ内に記載なし | 未確認 | 未確認 | なし | 公開物の結果ファイルが参照していないので入れない |

## 入れないものの扱い

- ラベルの表を入れないデータセットは、公開物の README に取得方法（出典の DOI・連絡先と、`scripts/asreview-baseline/generate_datasets.py` と同じ `id` の作り方）を書く。
- `evidence[].quote`（抄録の原文の抜粋）は、全データセットの結果から除く。文字位置（`start_char`・`end_char`）と、どちらの欄かを示す `field` は残す。
- CQ の xlsx の復号パスワードは公開物に入れない。リポジトリ内にあることへの対応は #307 の範囲外で、オーナーの作業として記録してある。
