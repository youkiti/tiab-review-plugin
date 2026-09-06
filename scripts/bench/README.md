# 性能計測（Issue #151（#150 工程0）チャンク3a・チャンク3b）

このディレクトリには2本の計測スクリプトがあります。

- `run.mjs` — Playwright でデモビルドを実ブラウザ操作し、UI操作の実測時間を計測する
- `bundle-stats.mjs` — webpack の Node API でバンドル統計（初期JS量・遅延チャンク・
  重い依存の内訳）を取得する

計測結果は既定で `.tmp/bench/`（`.gitignore` 済み）へ出力します。**どちらも計測専用で、
ここから `dist/` `docs/app/`（配布物）を作らないでください。**

## `run.mjs`（Playwright 計測ランナー）

デモビルド（`dist-demo/`）を実ブラウザ（Chromium）で動かし、`src/lib/perf.ts` の
`performance.measure` と `src/demo/fetch-mock.ts` の通信集計（`__tiabDemoNet`）を収集して、
**同一入力で再実行できる形**でベースラインを出力するスクリプトです。

**実データは一切使いません。** 文献・判定はすべて合成データ（`src/demo/bench-fixtures.ts`）で、
PDFもデモ同梱の固定フィクスチャ（`video/fixtures/demo-paper.pdf`）です。認証情報・実アカウント・
実ネットワークも使いません（デモモードは全 fetch をモックで横取りします）。

### 前提

- `npm install` 済みであること
- Playwright の Chromium がインストール済みであること（`npx playwright install chromium`）
- Windows の場合、npm は `npm.cmd` が使われます（スクリプト内で自動判定）

### 実行方法

```
npm run bench -- [オプション]
```

例:

```
# 既定（size=1000, repeat=100）でproduction デモビルドを作ってから計測
npm run bench

# サイズを複数指定（1000件と1万件をそれぞれ計測）
npm run bench -- --size 1000 --size 10000

# 動作確認用の短縮実行（ビルド済みの dist-demo/ を再利用し、反復回数を減らす）
npm run bench -- --skip-build --repeat 20

# キー開封後（非ブラインド）の条件で、通信に200msの人工遅延を入れる
npm run bench -- --key-opened --net-delay 200
```

#### オプション一覧

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `--size <n>` | 1000 | 合成文献数（`?benchSize=`）。複数指定可（`--size 1000 --size 10000`）。サイズごとに1回ずつシナリオ1〜7を計測する |
| `--key-opened` | off | `?benchKeyOpened=1`（キー開封後の条件）。off なら Blind |
| `--net-delay <ms>` | 0 | `?netDelay=`（通信の人工遅延） |
| `--repeat <n>` | 100 | 判定・前後移動の反復回数（親issueが「100回以上」を求めている） |
| `--out <dir>` | `.tmp/bench` | 出力先ディレクトリ（`.gitignore` 済み） |
| `--dev-build` | off | production デモビルドではなく development デモビルド（`npm run build:demo`）を使う |
| `--skip-build` | off | ビルドを行わず既存の `dist-demo/` を使う |
| `--headed` / `--headless` | headed | 既定は headed（拡張機能のロードに `--load-extension` が必要なため） |
| `--help`, `-h` | - | ヘルプを表示 |

**出力先について**: `dist/` と `docs/app/`（配布物）には一切書き込みません。`dist-demo/` は
このスクリプトのビルドステップで上書きされます（Playwright 録画・スクリーンショット撮影と共用の
成果物ディレクトリです）。

### 計測するシナリオ

1. **起動とプロジェクト読み込み** — サイドパネルを開いてデモプロジェクトへ接続するまで
   （`tiab:boot` / `tiab:project.load` / `tiab:project.fetch.meta` / `tiab:project.fetch.refs` /
   `tiab:project.render` と、この間の通信内訳。`tiab:project.fetch.refs` は Issue #153 工程2
   チャンク2 以降、通信を含まず取得済みデータのマージ処理のみを測る）
2. **判定を連続変更** — Include/Maybe/Exclude を `--repeat` 回クリック
3. **メモ付きで前後移動** — メモを入れてから前後移動を `--repeat` 回
4. **検索・フィルター変更** — 検索語を20回入れ替え、ステータスフィルターも数回変更
5. **未判定一覧からの除去** — 未判定フィルタ中に判定し、一覧から消えることを10回確認
6. **設定表示** — 設定画面の表示/非表示を10回
7. **オフライン保存と再送** — 保存失敗モード（`__tiabDemoNet.setFailureMode('save')`）で判定 →
   未送信キューに溜まる → 解除 → 再送されて0件になることを確認
8. **PDF表示と根拠ジャンプ** — ベンチプロファイル（`--size` のうち最小のサイズ）で
   `fulltext.html` を開き、`tiab:pdf.firstPage` / `tiab:pdf.allPages` / `tiab:pdf.highlight` /
   `tiab:pdf.evidenceJump` を5回分収集する。使う ref_id はコード側の定数
   `PDF_SCENARIO_REF_ID`（出典: `BENCH_FULLTEXT_CACHED_REF_ID`, `src/demo/bench-fixtures.ts`）で、
   この文献1件だけ `fulltext_status='cached'` とフルテキストAI判定（根拠3件、
   `video/fixtures/demo-paper.pdf` に実在する文字列をquoteにしたもの）がseedされている
   （既定デモプロファイルの `demo-ref-001` にはAI判定根拠が無いため使わない。
   Issue #151（#150 工程0）チャンク3b）。

**Issue #156（#150 工程5）での意味の変化**: `pdf-renderer.ts` を表示範囲中心の描画に
変えたことで、`tiab:pdf.firstPage` は「先頭ページの canvas + テキストレイヤー描画」完了の
計測のまま変わらないが、`tiab:pdf.allPages` は「全ページのプレースホルダー構築＋テキスト索引
構築＋先頭ページの描画」完了の計測に変わった（以前はページ数分の canvas 描画をすべて含んで
いたが、今は canvas 描画は先頭ページ1枚だけで、残りはテキスト抽出のみ）。索引構築自体は
ページ数に比例して増えるため `tiab:pdf.allPages` は引き続きページ数の影響を受けるが、
canvas 描画（`page.render()`）より軽いテキスト抽出だけなので、同じページ数でも旧実装より
小さい値になるはずである。デモ同梱の `video/fixtures/demo-paper.pdf` は4ページしかないため、
この差は数値上ほとんど見えない。長いPDFで「canvas 数がページ数に比例して増え続けない」ことを
確認するには、次項の `make-multipage-pdf.mjs` で生成したPDFに差し替えて `.ft-page-canvas` の
DOM要素数を数えること（タイミング数値だけでは検証できない）。

シナリオ2・3では、`performance.measure` が拾えない「クリックしてから画面が更新されるまで」の
実時間も別途 `runner:decision.click2frame` / `runner:navigate.click2frame` として計測します。
クリック直前から計測を始め、`requestAnimationFrame` のコールバック内で
`setTimeout(..., 0)` をスケジュールしてから計測を止めます（`requestAnimationFrame` の
コールバックはそのフレームのスタイル計算・レイアウト・描画より前に走るため、rAFのコールバック
時点で止めると実際に画面へ出るまでの時間を1フレーム分過少に見積もってしまう。`setTimeout` で
1つ後のマクロタスクへずらすことで、そのフレームの描画が終わった後の時刻を取る）。
Node↔ブラウザのIPC往復は計測に含めません（page.evaluate() 内で完結させているため）。

**既知の制約**: シナリオ8の `tiab:pdf.evidenceJump` は、`PDF_SCENARIO_REF_ID` の文献が
実際に「先頭付近の通常論文行」として存在する size のときだけ計測できます（`src/demo/bench-fixtures.ts`
のパーティション判定により、極端に大きい `--size`（目安として1万件以上）では対象の ref_id が
登録情報行の範囲に入ってしまい、フルテキストAI判定自体がseedされません）。実行できなかった場合は
出力の `skipped` にその旨が記録され、`tiab:pdf.evidenceJump` の集計は0件のまま出力されます。

### 出力

`--out`（既定 `.tmp/bench/`）配下に以下を書き出します。

- `bench-<ISO日時>.json` — 環境メタ＋全シナリオの集計＋生の measure 一覧
  - `meta`: コミットSHA・ブランチ・作業ツリーの汚れ・Node/Chromeバージョン・OS・CPU・総RAM・
    ビルドモード・実行オプション（size/keyOpened/netDelay/repeat）
  - `sizes[]`: サイズごとの `scenarios`（各シナリオの `aggregated`/`net`/`raw` 等）
  - `fulltextPdf`: シナリオ8の集計
  - `skipped[]`: 実行できなかった（または失敗した）シナリオとその理由
  - `consoleMessages[]`: 実行中に出たコンソールエラー・警告・pageerror
- `summary.md` — 上記を人が読める表にまとめた日本語のサマリ

**p95 の定義**: 値を昇順ソートし、`Math.ceil(n * 0.95) - 1` 番目（0始まり）の値。後から別の実装と
比較するときに定義が違うと数字が食い違うため、この定義はコード（`scripts/bench/run.mjs` の
`percentile95()`）と出力の両方に明記しています。

**データ契約**（親Issue #150）: 認証情報・文献本文・レビュアーのメールは一切収集・出力しません。
デモの固定メール（`demo-reviewer@example.com` 等）も出力に書きません。`performance.measure()` の
`detail` は件数などの数値のみのはずですが、出力前に文字列値を落とすフィルタ
（`sanitizeDetailValue()`）を必ず通しています。

### 堅牢性

- どこかのシナリオが失敗しても、そこまでの結果を必ずファイルへ書き出してから非ゼロ終了します
  （長時間の計測を全部捨てないため）。
- 実行できなかったシナリオは黙って飛ばさず、標準出力と出力JSONの `skipped` に理由付きで残します。
- ブラウザは `finally` で必ず閉じます。
- 実行中に発生したコンソールエラー・警告・pageerror は握りつぶさず、出力とレポートに残します。

## `bundle-stats.mjs`（バンドル統計）

webpack の Node API を直接呼び、拡張版・Web版の production バンドルを隔離した出力先
（`.tmp/bench/bundle/…`）へ一時的にビルドして stats を取得するスクリプトです
（Issue #151（#150 工程0）チャンク3b）。`webpack.config.js` に追加した `--env outDir=<path>`
上書き機構を使うため、通常の `npm run build` / `build:web` / `build:demo` / `build:release` の
出力先（`dist/` `dist-demo/` `docs/app/`）には一切書き込みません。

production ビルドは `.env` が無いと WEBAUTH_CLIENT_ID 等の未設定で fail-fast するため
（AGENTS.md「`.env` が無い環境で production ビルドを検証する」参照）、常にプレースホルダーの
環境変数（`WEBAUTH_CLIENT_ID=placeholder` 等）を使います。バンドル統計は計測専用で配布物を
作らないため、実際の `.env` がある環境でも常にプレースホルダーで上書きします。

### 実行方法

```
npm run bench:bundle
npm run bench:bundle -- --out <dir>   # 既定 .tmp/bench
```

### 出力

`--out`（既定 `.tmp/bench/`）配下に以下を書き出します。

- `bundle-stats-<ISO日時>.json` — 拡張版・Web版それぞれの集計（下記）
- `bundle-summary.md` — 上記を人が読める表にまとめた日本語のサマリ

拡張版・Web版それぞれについて次を出します。

- **エントリポイント別の初期ロード資産** — アセット名とバイト数、JSのみの合計と全体の合計
  （`sidepanel` の初期JS量が親issueの目標指標）
- **遅延（非初期）チャンク** — 一覧とサイズ
- **サイズ上位20モジュール** — モジュール名（パス）とサイズのみ
- **全モジュール一覧（JSONの `modules`）** — 名前・サイズ・初期ロードに含むエントリ。
  永続キャッシュから再利用したモジュールも含め、迂回importの有無を確認できます。
- **重い依存の内訳（pdfjs-dist）** — 合計サイズと、どのエントリポイントの初期ロードに
  含まれているか（工程4 #155 の判断材料）
- `.map` ファイルは初期JS量の集計から除外し、別枠で合計だけ出します

**ソース本文は一切出力に含めません**（`stats.toJson({ source: false })` を必ず通しています。
親Issue #150 の明示要求）。

**出力先について**: `dist/` と `docs/app/`（配布物）には一切書き込みません。実行後に
`git status --porcelain` が汚れていないことを確認してください。

## `make-multipage-pdf.mjs`（検証用の複数ページPDF生成、Issue #156（#150 工程5））

デモ同梱の固定フィクスチャ `video/fixtures/demo-paper.pdf` は4ページしかなく、表示範囲中心の
PDF描画（`src/fulltext/pdf-renderer.ts`）が長いPDFで実際に効いているか（canvas数がページ数に
比例して増え続けないか）を目視・実測できない。このスクリプトは外部パッケージに依存せず、
各ページに Helvetica のテキストだけを置いた有効な PDF 1.4 ファイルを、xref テーブルの
バイトオフセットを自前で計算して直接組み立てる。

```bash
node scripts/bench/make-multipage-pdf.mjs --pages 40 --out .tmp/bench/multipage-40.pdf
```

- `--pages <n>`: 生成するページ数（既定 40）
- `--out <path>`: 出力先（既定 `.tmp/bench/multipage-<n>.pdf`）

**使い方**: `npm run build:demo:prod` 済みの `dist-demo/fixtures/demo-paper.pdf` を、生成した
PDFで**ローカルでのみ**上書きしてから `npm run bench -- --skip-build` 等で `scenarioPdf` を
実行すると、長いPDFでの `.ft-page` / `.ft-page-canvas` の数や `tiab:pdf.firstPage` /
`tiab:pdf.allPages` を実測できる。ただし `tiab:pdf.evidenceJump` は、フルテキストAI判定の
quote が `video/fixtures/demo-paper.pdf` の実テキストに紐づいているため、差し替えたPDFの
テキストとは一致せず `skipped` になる（既知の制約。根拠ジャンプの実測には元のフィクスチャの
ままにする必要がある）。

**PDFバイナリはコミット対象にしない。** 既定の出力先 `.tmp/bench/` は `.gitignore` 済み。
`dist-demo/fixtures/demo-paper.pdf` を上書きした場合も、検証が終わったら
`npm run build:demo:prod` を再実行するか元のファイルへ戻し、`dist-demo/` 自体をコミットしない
（既存の運用と同じ。「出力先について」の各節参照）。

### PDF・MLの遅延読み込み（Issue #155）

サイドパネルは、全文AI判定でPDFを検査するときに `src/lib/pdf-image-only.ts` を読み込みます。
チャンク取得失敗はAI判定の失敗として扱い、PDFの文字抽出失敗は従来どおり検査のみ省略します。
ビューアのPDF.jsは静的読み込みを維持し、スキャン判定の閾値だけを `pdf-constants.ts` で共有します。

MLの入口は `src/sidepanel/features/ml/lazy.ts` です。初回操作で本体を読み込み、リスナー登録と
Worker購読を一度だけ行います。ロード中はML欄に状態を表示し、並行操作は同じPromiseを待ちます。
読み込み失敗時は再度タブを選ぶと再試行できます。ロード中に別タブ・別プロジェクトへ移った操作は
完了してもMLへ戻しません。ML未使用時のキーボード操作や設定の再描画は本体を読み込みません。

拡張・Web・demoとも動的チャンクは `chunks/` に同梱します。`splitChunks: false` とHTMLの
固定script参照は維持し、Service Workerの起動経路には動的importを追加しません。
`publicPath` は既定の `auto` を使用し、各エントリscriptのURLを基準に配置階層を補正します。
PDF worker・cMap・標準フォントの同梱と、リリース時の `.map` 除外は従来どおりです。
