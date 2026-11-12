# 元データの出典とライセンス（Issue #307）

評価に使った元データの出典と、公開物（Zenodo のデータセット）に入れてよいかの判断。**題名・抄録・全文は、どのデータセットについても公開物に入れない。** 入れてよいのは、再配布が認められたデータセットの `id` と正解ラベルの表（`labels/<データセット>.csv`、列 `id,label_included`）だけ。

## 確認の状況

depression・wilson・CQ1〜5・Cochrane（Mendeley）の4種は、2026-11-12 に出典の公開 API でライセンスを確認し、オーナーがラベルの表の再配布を可と判断した。Zenodo の2種は `metadata.license.id` が `cc-by-4.0`、Mendeley は `data_licence.short_name` が `CC BY 4.0`。CQ1〜5 は出典リポジトリの `LICENSE.rtf` が MIT License で、README の「Data availability」節で著者がデータファイルのパスコードを公開している。4種は `scripts/zenodo-eval/pack.mjs` の `REDISTRIBUTABLE_LABEL_DATASETS` に登録してある。

ラベルの表は元データから `id` と組み入れの判定だけを取り出したもの（改変あり）で、下の出典表を CC BY 4.0 と MIT License に基づく帰属の表示とし、この文で改変を示す。

## 表

| データセット | pack.mjs の名前 | 出典 DOI | ライセンス | 確認日 | 確認したページの URL | 再配布の可否 |
| --- | --- | --- | --- | --- | --- | --- |
| depression（SLIM の訓練セット。前臨床のうつ病の SR） | `depression` | 10.5281/zenodo.151190「Understanding in vivo Models of Depression: A Systematic Review - Records of Full Search」 | CC BY 4.0 | 2026-11-12 | https://doi.org/10.5281/zenodo.151190 | 可 |
| wilson（Wilson 病の SR） | `wilson` | 10.5281/zenodo.3625931「Data from Comparative effectiveness of common therapies for Wilson disease: A systematic review and meta-analysis of controlled studies」（元論文 10.1111/liv.14179） | CC BY 4.0 | 2026-11-12 | https://doi.org/10.5281/zenodo.3625931 | 可 |
| CQ1〜5（日本の診療ガイドライン作成のための SR） | `cq1-5` | https://github.com/seveneleven711thanks39/llm-assisted_citation_screening （Oami ら、`Data/` の `CQ1_data.xlsx`〜`CQ5_data.xlsx`、`Reference_standard_data.xlsx`） | MIT License（`LICENSE.rtf`） | 2026-11-12 | https://github.com/seveneleven711thanks39/llm-assisted_citation_screening | 可 |
| Cochrane（Mendeley。TITAN-SR の外部検証） | `cochrane-mendeley` | 10.17632/7sgmg89zb6「Title and Abstract Screening Data for Systematic Review」（Chan et al. 2025、10.1017/rsm.2025.1。`20240827_Systematic_Review_Data.zip`・`20240827_Systematic_review_manual_search_data.zip`） | CC BY 4.0 | 2026-11-12 | https://doi.org/10.17632/7sgmg89zb6 | 可 |
| ASReview の例（Cohen 2006・Kwok 2020・Wolters 2018） | （対象外） | リポジトリ内に記載なし | 未確認 | 未確認 | なし | 公開物の結果ファイルが参照していないので入れない |

## 入れないものの扱い

- ラベルの表を入れない対象は ASReview の例（Cohen 2006・Kwok 2020・Wolters 2018）だけで、公開物の README に取得方法（出典の DOI・連絡先と、`scripts/asreview-baseline/generate_datasets.py` と同じ `id` の作り方）を書く。
- `evidence[].quote`（抄録の原文の抜粋）は、全データセットの結果から除く。文字位置（`start_char`・`end_char`）と、どちらの欄かを示す `field` は残す。
- CQ の xlsx の復号パスワードは出典の著者が README で公開している値なので秘密ではない。題名・抄録つきの元データそのものを入れないため、パスワードも公開物には入れない。
