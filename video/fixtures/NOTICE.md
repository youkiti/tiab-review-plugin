# このディレクトリのPDFフィクスチャについて

このリポジトリ本体は MIT ライセンスですが、`bench-paper-20p.pdf` / `bench-paper-57p.pdf` の
2本だけは別ライセンス（CC BY 4.0）の第三者著作物です。再配布時に原著者・出典・ライセンスの
表示を求める CC BY 4.0 の要件に従い、出所をここに記します。

## demo-paper.pdf

このリポジトリで生成した架空の論文です（生成元 `video/fixtures/demo-paper.html`）。実在の論文
ではなく、このリポジトリのライセンス（MIT）に従います。

## bench-paper-20p.pdf

- 著者: Marra F, Yip M, Cragg JJ, Vadlamudi NK
- タイトル: Systematic review and meta-analysis of recombinant herpes zoster vaccine in
  immunocompromised populations
- 掲載誌・年: PLoS ONE 19(11): e0313889 (2024)
- DOI: [10.1371/journal.pone.0313889](https://doi.org/10.1371/journal.pone.0313889)
- ライセンス: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- 取得日: 2026-09-06
- ページ数: 20

## bench-paper-57p.pdf

- 著者: Siedentop B, Kachalov VN, Witzany C, Egger M, Kouyos RD, Bonhoeffer S
- タイトル: The effect of combining antibiotics on resistance: A systematic review and
  meta-analysis
- 掲載誌・年: eLife 2024;13:RP93740
- DOI: [10.7554/eLife.93740](https://doi.org/10.7554/eLife.93740)
- ライセンス: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)
- 取得日: 2026-09-06
- ページ数: 57

## 用途

上記2本は Issue #156（#150 工程5「PDFを表示範囲中心に描画する」）の着手に必要な「20ページ
以上のPDFフィクスチャ」として追加しました。デモビルド（`npm run build:demo`）限定で
`fixtures/` 配下へ同梱し、`?benchPdf=`（`scripts/bench/run.mjs` の `--pdf`）で選べます。拡張機能の
通常配布物（`dist/`）には含みません。原論文の内容そのものは、このプロジェクトの研究データでは
なく、PDF描画・テキスト抽出の性能計測用フィクスチャとしてのみ利用します。
