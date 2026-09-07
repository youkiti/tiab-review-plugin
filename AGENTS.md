# TiAb Review Plugin - AGENTS.md

# CRITICAL PROTOCOLS (ABSOLUTE PRIORITY)

以下のルールは、いかなる状況でも最優先で遵守すること：

1. **ブランチ強制**: コードを変更する前には必ず `git branch` を確認し、作業用ブランチを作成すること。`main`・`master`・`develop` での作業は禁止。**例外: バージョンバンプ commit（`npm run bump` / `scripts/bump-version.ps1`）は `main` 上で直接行ってよい。** 差分が version と Build 日付のみで、直前の `main` は CI green である前提のため PR / CI 待ちを挟まない（作業ツリーが汚れている場合はスクリプトが停止する）。機能変更をこの経路で `main` に入れてはならない。
2. **日本語化**: ユーザーに提示するアーティファクト（計画書・タスク・確認事項）は、作成時に必ず日本語で記述すること。
3. **不要ファイル・ブランチの削除**: テストなどで作成したファイルやブランチは不要になった時点で削除すること。
4. **言語規定**: 思考プロセスは英語で行う。ユーザーへのレスポンス、アーティファクト、コミットメッセージ、コード内のコメントは必ず日本語で記述すること。（システムエラーやログの引用は原文のままでよい）
5. **自動化の限界と報告**: ツール実行が複数回失敗した場合や、権限不足・環境固有の問題に直面した場合は、執拗に再試行せず、直ちにユーザーに状況を報告し手動対応を依頼すること。
6. **品質保証**: コード修正完了時は、必ずLint（構文チェック）と関連テストを実行し、PASSすることを確認してからユーザーへ報告すること。
7. **再現可能性：**実験のレポートを書くときは、ソースコード、元データへのリンクを必ず入れるこ**と。**
8. **既存テストの保護**: 修正により既存のテストが失敗した場合、テストコードを安易に修正してはならない。まず実装のバグを疑い、テスト修正が必要な場合は、それが「意図した仕様変更」であることをユーザーに確認すること。
9. **機密情報の保護**: パスワード、APIキー、トークンなどの機密情報を、ログ・アーティファクト・チャットの応答などに絶対に出力しないこと。`.env`の取り扱いに注意すること。
10. **ドキュメントの同期**: 機能や仕様を変更した際は、コードの修正だけでなく、関連するドキュメント（README、API仕様書、主要なコメント等）も必ず同期して更新すること。
11. **作業中断時のロールバック**: エラーや中断によりタスクを終了する場合、ユーザーの明示的な指示がない限り、修正途中の不安定な状態を残さず、作業開始前のクリーンな状態に復元すること。

### 参照先索引

詳細仕様は Issue #195 でコードのディレクトリに併置した AGENTS.md へ移動した。リポジトリ全体の規約は本ファイルに保持し、移動先は以下の索引から参照する。

| 重要条件 | 本文の節名・参照先 |
| --- | --- |
| Blind の可視性 | [「フルテキスト判定画面（PDFウィンドウ）の「他レビュアーの判定」」](src/lib/sheets/AGENTS.md)「運用ルール」 |
| 列の末尾追加・ヘッダー導出 | [「スプレッドシート構造」](src/lib/sheets/AGENTS.md)の References / LLM_Executions タブ、「テスト・作業ツリーの落とし穴」のヘッダーミラー・References読み取り範囲 |
| 判定保存・履歴の追記専用契約 | [「スプレッドシート構造」](src/lib/sheets/AGENTS.md)の Decisions タブ、[「判定保存フロー」](src/lib/sheets/AGENTS.md)[「κ（Cohen's kappa）の算出手順」](src/lib/sheets/AGENTS.md) |
| OAuth・認証の変更禁止事項 | [「OAuth スコープ」](src/platform/AGENTS.md)[「OAuth フロー: なぜ implicit なのか（変更禁止・調査済み）」](src/platform/AGENTS.md)「Web版（ブラウザ版）」 |
| オフライン同期 | [「オフライン同期の方針」](src/lib/AGENTS.md) |
| テスト・作業ツリー | 「テスト・作業ツリーの落とし穴」「`.env` が無い環境（git worktree 等）で production ビルドを検証する」 |
| 依存方向・規模・CI・基準値更新 | 「開発規約（依存方向・ファイル規模・CI 回帰条件）」、[READMEの最短手順](README.md#最短手順) |
| 遅延読み込み・チャンク分割 | 「遅延読み込み（動的 import）でチャンクを分けるときの規約」 |
| 詳細仕様ファイル一覧: インポート・型定義 | [src/lib/AGENTS.md](src/lib/AGENTS.md): インポート規約・レジストリ連携・重複レビュー・オフライン同期・型定義 |
| 詳細仕様ファイル一覧: データ・Sheets API | [src/lib/sheets/AGENTS.md](src/lib/sheets/AGENTS.md): データ設計・裁定・TiAbエクスポート・Google Sheets API・判定保存・運用フロー・κ算出 |
| 詳細仕様ファイル一覧: 機能要件 | [src/sidepanel/AGENTS.md](src/sidepanel/AGENTS.md): MVP・表示設定・絞り込み状態・state.ts・表示位置・キーボードショートカット |
| 詳細仕様ファイル一覧: OAuth・共有 | [src/platform/AGENTS.md](src/platform/AGENTS.md): OAuthスコープ・Drive付与・共有フロー・OAuthフロー |

## プロジェクト概要

**TiAb Review Plugin** は、Systematic Review における文献スクリーニングを効率化するChrome拡張機能です。

Google スプレッドシートを共有データベースとして使用し、複数のレビュアーが文献評価を行えるツールです。

### アーキテクチャ方針（2026-06-12 確定）

SR ワークフローを以下の**2アプリ構成**で実現する。共有データ基盤は同一 Google Sheets。

| レイヤー                               | 担当機能                                                                                                  | 形態                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Chrome拡張（本リポジトリ）**         | TiAb スクリーニング（サイドパネル）<br>フルテキストスクリーニング + PDF アノテーション（`fulltext.html`） | Chrome Extension (MV3)         |
| **別Webアプリ（別リポジトリ、将来）**  | データ抽出（構造化フォーム）<br>Risk of Bias 評価（RoB2 / ROBINS-I 等）                                   | Web アプリ（インストール不要） |

**Chrome拡張をフルテキスト以降に拡張しない理由：**

- データ抽出・RoB はブラウザ統合の恩恵が小さく、フォーム UI が主体
- PDF.js 追加後のバンドルサイズ肥大を拡張内で最小限に抑えるため
- RoB ツール選択（ドメイン定義）などの動的スキーマ管理は拡張の設定UIに馴染まない

## 技術スタック

- **フロントエンド**: Chrome Extension (Manifest V3)
  - Popup / Side Panel UI
  - Content Scripts (ページからのメタデータ抽出用、将来拡張)
- **認証**: Google OAuth 2.0（`chrome.identity.launchWebAuthFlow`。ウェブアプリ型クライアント + chromiumapp.org リダイレクト）
- **バックエンド**: Google Sheets API (読み取り・追記)
- **言語**: TypeScript, HTML, CSS, Python (データ分析・実験用)

## Manifest要件（要件抜粋）

- `permissions`: `identity`（`launchWebAuthFlow` に必要）, `storage`
- `host_permissions`: `https://sheets.googleapis.com/*`（他にDrive・LLM各プロバイダ・OA取得ウォーターフォール各API・ClinicalTrials.gov API v2・eutilsなど。全量は `src/manifest.json` を参照。レジストリ連携フェーズ1チャンク2で `https://clinicaltrials.gov/*` と `https://eutils.ncbi.nlm.nih.gov/*` を追加した）
- OAuth: manifest に `oauth2` ブロックは持たない。クライアントIDはビルド時に `WEBAUTH_CLIENT_ID`（`.env`）を webpack DefinePlugin 経由でコード側に埋め込む。クライアント種別は**ウェブアプリケーション型**でなければならない（Chrome 拡張機能型は `launchWebAuthFlow` で `redirect_uri_mismatch` になる。「OAuth フロー: なぜ implicit なのか」参照）
- `side_panel`: サイドパネル利用時に定義
- `commands`: ショートカット定義（単一キーはUI内で処理）

## 非機能要件

- **パフォーマンス**: 3,000件で快適に動作
- **信頼性**: オフライン中の判定をローカルキューに保持し、オンライン復帰後に同期
- **セキュリティ**: トークンをログ出力しない、最小スコープ

## 運用ルール

- **reviewer_id**: OAuth userinfo エンドポイントで取得したemail（認可時に選択したアカウント）固定。表示名/匿名IDは使用しない
  - 取得前提: ユーザーはGoogleアカウントにログイン済みで、拡張機能がOAuth同意済み
  - 取得できない場合は作業をブロックし、再ログインと同意を促す
    - UIメッセージ: 「Googleアカウントにログインしてください」
- **競合時の優先順位**: 同時編集が発生した場合は `decided_at` の新しい判定を優先（Last Write Wins）
- **アクセス制御**: 編集権限が必要。対象スプレッドシートはGoogle Drive上で管理
- **判定理由**: 任意入力。バリデーションは行わない
- **フルテキストの除外理由は並び順そのものが優先順位**。複数当てはまる場合は番号の小さい理由を選ぶ。
  理由が判定者間で割れると裁定（不一致解消）の手間が発生するため、割れにくくする規則として運用する
  - **理由リストはプロジェクトごとに編集できる**（Config タブ `fulltext_exclude_reasons`）。
    SR のフレームワークは PICO だけではない（scoping review の PCC 等）ため、区分を固定しない。
    未設定のプロジェクトは既定の PICO 7区分（`DEFAULT_EXCLUDE_REASON_ITEMS`）で動く
    - 型・既定値・純粋関数は `src/lib/exclude-reasons.ts`、設定のパース／保存／プリセットは
      `src/lib/exclude-reason-config.ts`。表示・集計・裁定・AI判定は**必ず解決済みの理由リストを引数で受け取る**こと
      （`state.excludeReasonItems` / フルテキストページの `excludeReasonItems`）
    - 編集UIはフルテキストタブのインラインエディタ（`src/sidepanel/features/fulltext/reason-editor.ts`、管理者のみ）
    - `fulltext.html` の `<select>` に固定の `<option>` を書かないこと（設定と二重定義になる）。
      選択肢は `fulltext.ts` の `renderReasonOptions()` が実行時に描画する
  - **保存キー（`key`）は過去データの参照キー**。一度発番したら変えない。ラベルはいつ変えてもよい。
    項目を削除しても過去の判定は消えず、`excludeReasonLabel()` のフォールバックで生キーのまま表示・集計される
  - 集計の代表理由は `pickPrimaryExcludeReason()` が最小番号を採る。
    以前は「最初に見つかった非空の理由」で**判定者の列挙順に依存**していた（誰が先に判定したかでPRISMAの内訳が動いていた）
  - フルテキストAI判定のスキーマ（enum）・プロンプトも同じ理由リストから生成する（`gemini-fulltext.ts`）。
    AI票も判定者として合議に入るため、揃えないとAI票が理由不一致を量産する。
    リストに無い区分をAIが返した場合は `normalizeExcludeReasonKey()` でフォールバック理由（**常に末尾の項目**）
    へ寄せる。**`'other'` というキー名を特別扱いしないこと**（カスタム理由には存在しないことがあるうえ、
    存在しても末尾にあるとは限らない。フォールバック先は位置だけで決める）

## ディレクトリ構造（推奨）

```
tiab-review-plugin/
├── .agent/
│   └── AGENTS.md
├── scripts/                   # データ分析・ユーティリティスクリプト (Python)
│   ├── check-structure.mjs     # 依存方向・循環・800行超の回帰検査
│   ├── structure-baseline.json # 既存の構造上の改善対象
│   ├── check-bundle-budget.mjs # 初期JS量の予算検査
│   ├── bundle-budget.json     # 実測値と上限（実測の101%）
│   ├── analyze_llm_datasets.py
│   ├── fetch_openalex_testdata.py
│   └── ...
├── src/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── background/
│   ├── platform/
│   │   └── AGENTS.md          # OAuth・共有フロー
│   ├── popup/
│   ├── sidepanel/             # TiAb スクリーニング（サイドパネル）
│   │   ├── AGENTS.md          # 機能要件
│   │   ├── features/          # 機能別モジュール
│   │   │   ├── llm/           # LLM機能 (API, Batch, Criteria)
│   │   │   ├── screening/     # スクリーニング機能
│   │   │   ├── project.ts     # プロジェクト管理
│   │   │   └── ...
│   │   ├── ui/                # UIコンポーネント
│   │   ├── sidepanel.html
│   │   └── sidepanel.ts
│   ├── fulltext/              # フルテキストスクリーニング（新規タブページ）
│   │   ├── fulltext.html      # 2カラムレイアウト（PDF左 / 決断・アノテーション右）
│   │   ├── fulltext.css
│   │   ├── fulltext.ts        # エントリポイント（初期化と依存の接続、URL param: ref_id）
│   │   ├── session.ts         # ページ状態・世代・先読み・破棄対象リソースの保持
│   │   ├── document-loader.ts # PDF取得・再付与・描画と表示経路の選択
│   │   ├── pdf-prefetch.ts    # 隣接候補PDFの先読み（ファイルID照合・中止・バイト/同時実行数上限）
│   │   ├── document-view.ts   # フレーム・ツールバー・取得状況・記事ページの表示
│   │   ├── registry-snapshot.ts # 登録情報スナップショットの取得・復旧案内
│   │   ├── pdf-upload.ts      # PDFアップロード・置換・削除・ドロップ操作
│   │   ├── decision-controller.ts # 判定・理由・保存・AIサマリ・他者票の表示
│   │   ├── evidence-controller.ts # AI根拠・アノテーション一覧・ジャンプ・表示切替
│   │   ├── navigation.ts      # 候補計算・文献切替・進捗・キーボード操作
│   │   ├── page-panels.ts     # 書誌・判定の文脈・レビュー基準モーダル
│   │   └── page-helpers.ts    # 表示文言・外部リンク・一時通知の共通処理
│   ├── lib/
│   │   ├── AGENTS.md          # インポート規約・型定義
│   │   ├── gemini-api.ts      # Gemini API クライアント
│   │   ├── sheets-api.ts      # Sheets API の互換窓口（実装は sheets/ 配下を再 export）
│   │   ├── sheets/            # transport / schema / codecs / references / decisions / config / config-schema / llm-history / publication-candidates / duplicate-candidates
│   │   │   └── AGENTS.md      # データ設計・Sheets API
│   │   ├── types.ts           # 共有型定義（Reference / Decision / Annotation 等）
│   │   └── ...
│   └── utils/
├── experiments/               # LLM実験・検証用 (TypeScript)
│   ├── data/
│   ├── results/
│   ├── logs/
│   ├── runner.ts              # 実験ランナー
│   ├── evaluate.ts            # 評価スクリプト
│   └── ...
├── dist/                      # ビルド出力
├── package.json
├── tsconfig.json
└── README.md
```

## 開発ワークフロー

1. `npm install` - 依存関係インストール
2. `.env.example` を `.env` にコピーし、`WEBAUTH_CLIENT_ID`（拡張版 launchWebAuthFlow 用、dev/store共通）を設定
3. `npm run dev` - 開発ビルド（`key` 保持。`WEBAUTH_CLIENT_ID` 未設定だと本番と同様に fail-fast する。認証を触らないローカル作業では `ALLOW_NO_AUTH=1 npm run dev` で警告のみに格下げできる）
4. `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダ選択
5. 開発中は `npm run watch` でホットリロード
6. リリースは `npm run release`（バージョンバンプしてローカル commit + ストア用ビルド + `dist.zip` 作成）。機能追加時は `npm run release:major`

### 開発規約（依存方向・ファイル規模・CI 回帰条件）

- 依存方向は「画面 → 処理の調整 → ドメイン純関数 / 保存API → platform」。画面と調整は `src/sidepanel/`（`store/` を含む）、`src/fulltext/`、`src/popup/`、`src/webapp/`、`src/background/`、`src/demo/`。ドメイン・保存APIは `src/lib/`（`sheets/`・`ml/`・`providers/` を含む）、環境差分は `src/platform/` に置く。小さい処理まで機械的にファイル化せず、変更理由とテスト境界が共通のものをまとめる。
- lib / platform からUIをimportしない。platform → lib は導入時の実測0件なので禁止する。platform → demo の既存1辺のみ `scripts/structure-baseline.json` に記録し、新しい参照は許容しない。現状0件の方向はESLintでも検出する。
- 型・既定値モジュールからUI・通信をimportしない。`scripts/check-structure.mjs` の `FOUNDATION_MODULES` は `lib/types.ts`、`lib/assignment-set.ts`、`lib/sheets/schema.ts`、`lib/sheets/config-schema.ts`、`lib/ml/types.ts`、`lib/ml/cmh-defaults.ts`、`platform/types.ts` を検査する。型・既定値の配置や通信APIを増やしたら、この一覧と通信先の判定も追従させる。
- 新規ファイルは200〜500行が目安。TS / CSS / HTML の800行超は設計レビューの通知対象で、基準値にない超過をCIで失敗させる。既存の大規模ファイルは改善対象として行数と増減を表示し、増加だけでは失敗させない。行数制限のためにコメントを削らない。
- 800行超のモジュールを機能単位へ分割するときは、**同名ディレクトリ＋`index.ts`（公開APIの再exportだけを持つ薄い入口）**にする。TypeScript も `scripts/check-structure.mjs` も `./batch` を `./batch/index.ts` へ解決するため、呼び出し側の `from './batch'` を書き換えずに済み、差分が分割そのものだけになる（Issue #191 で `features/llm/batch/`・`features/fulltext/drive-import/` に適用）。分割で相互参照が生まれたら、まず**呼び出し側から関数を引数で渡す**形にできないか試すこと。setter による注入（`setXxxDeps`）は未配線のとき静かに失敗する経路を作るので最後の手段にし、使う場合も未配線を握りつぶさず throw させる。
- `npm run check:structure` は相対import・再export・型import・文字列リテラルの動的importを正規表現で抽出し、Tarjanの強連結成分で循環を検出する。外部パッケージ、宣言ファイル、バックアップは対象外。既存循環は辺まで基準値に記録し、同じ循環グループ内の新しい辺も回帰とする。TypeScriptの完全な構文解析ではないため、計算式の動的import等は別途レビューする。
- `npm run check:bundle` は同条件のproductionビルドでサイドパネルとWeb版appの初期JS量（.map除外）を検査する。`scripts/bundle-budget.json` の上限は実測値の101%を整数切り上げ。上限超過は失敗、上限より3%以上小さければ更新可能と表示する。時間の閾値はばらつきが大きいためCIに入れない。通信回数は `tests/project-load-request-counts.test.ts` で固定する。
- 基準値更新は `node scripts/check-structure.mjs --update-baseline`。予算更新は `npm run bench:bundle` 後の `node scripts/check-bundle-budget.mjs --update-budget`（`--stats <JSONパス>` で既存統計も利用可能）。基準値・予算の更新は意図的な設計変更として、コミットに理由を書く。単に検査を通すために更新しない。改善の検出は通知のみで失敗にしない。

### 遅延読み込み（動的 import）でチャンクを分けるときの規約

`webpack.config.js` は拡張版・Web版のどちらも `optimization: { splitChunks: false }` で、**共有チャンクを一切作らない**。この前提が、遅延読み込みの分け方に制約を課す。

- **静的 import で繋がっているモジュール同士を、別々の `webpackChunkName` で動的 import しないこと。** 共有チャンクが無いので、依存先のコードは各チャンクへ**丸ごと複製される**。片方は完全な無駄になり、フェッチ回数も増える。実例（PR #178 レビュー指摘）: `features/ml/lazy.ts` が `./actions` と `./render` を別名で動的 import していたが、`actions.ts` は `./render` を静的 import しているため `chunks/ml-render.js`（58,655 バイト）の中身は `chunks/ml-actions.js`（87,523 バイト）に丸ごと含まれていた。両方を同じ `webpackChunkName: "ml-feature"` に揃えて 86,983 バイトの1チャンクにしたところ、**59,195 バイトとフェッチ1回が消えた**。
- **一緒に読み込むものは同じチャンク名にする。** 分けてよいのは、片方だけを読む経路が実在するときだけ。判断に迷ったら1本にまとめる。
- **重複は `npm run bench:bundle` の出力（`.tmp/bench/bundle-stats-*.json` の `modules`）で検出できる。** 同じモジュールが複数チャンクに現れていたら統合の候補。生成物側で DOM の id 文字列（例 `ml-include-keywords-list`）を複数チャンクから grep するのも早い。関数名は minify で消えるので目印に使わないこと。
- **遅延読み込みの入口には、本体を読む前に判定できるガードを置くこと。** 件数や設定で「そもそも機能を使えない」と分かる条件は、`import()` の前に判定する。判定に必要な定数が重い依存を持つモジュールにあるなら、定数だけを依存の無いモジュールへ切り出す（`lib/ml/cmh-defaults.ts`・`lib/pdf-constants.ts` がその形）。切り出し元からの再エクスポートは、既存の import 経路が実在するときだけ残す（`lib/ml/cmh.ts` の `CMH_DEFAULTS`、`lib/ml/stopping-rules.ts` の `canUseCmhStopping`）。ガードを本体側に残したままだと、使えないと分かっている機能のチャンクと Web Worker を読み込んでから戻ることになる（PR #178 レビュー指摘）。
- **重い依存を持つモジュールから、軽い定数を再エクスポートしないこと。** 消費者が消えた再エクスポートは、後からその経路で import した瞬間に重い依存（例: pdfjs の 376KB）を初期バンドルへ引き戻す罠になる。使われなくなった再エクスポートは消す。
- LLM機能の入口は `src/sidepanel/features/llm/lazy.ts`。入口以外の `features/llm/**` を外部から静的 import すると本体が初期バンドルへ戻るため禁止する。専用DOM参照も本体側の `features/llm/dom.ts` に置く。
- フルテキストタブの入口は `src/sidepanel/features/fulltext/lazy.ts`。入口以外の `features/fulltext/**` を外部から静的 import すると本体が初期バンドルへ戻るため禁止する。専用DOM参照も本体側の `features/fulltext/dom.ts` に置く（プロジェクト読み込み時に必ず実行される担当セット選択の初期化は遅延化の対象外のため `features/fulltext-assignment-selection.ts` に分離した）。
- 初期バンドル量の回帰は `npm run check:bundle` が検出する（上の「開発規約」節）。ただし**チャンク間の重複は初期バンドル量に現れない**ので、この検査では捕まらない。分割を足したら生成チャンクの一覧とサイズを目視すること。

### 性能計測

実行方法は `scripts/bench/README.md` を見ること（Playwright での実測時間計測 `npm run bench` と、
バンドル統計 `npm run bench:bundle` の2本）。計測結果は既定で `.tmp/bench/`（`.gitignore` 済み）へ
出る。計測用ビルド（プレースホルダー環境変数・隔離した出力先）は配布しないこと。

PDFフィクスチャはデモビルド限定で3本同梱している（`demo`/`20p`/`57p`、`?benchPdf=` または
`npm run bench -- --pdf` で選択）。追加2本（20ページ・57ページ）は外部のCC BY 4.0論文で、出所表示は
`video/fixtures/NOTICE.md` にある。

### `.env` が無い環境（git worktree 等）で production ビルドを検証する

`git worktree` で切ったツリーには `.env` が無いため、production ビルドは fail-fast で落ちる。**`ALLOW_NO_AUTH=1` は dev ビルドしか救わない**（`webpack.config.js` の production 側の throw は、コード中の注記どおりこの変数の影響を受けない）。そのため「`npm run dev` は通ったが `npm run build` / `npm run build:web` は未検証」のまま PR を出すことになりやすい。

これらの値は **webpack DefinePlugin の文字列置換にしか使われない**ので、コンパイルが通ることの確認には本物である必要がない。プレースホルダをインラインで渡せば production 経路（minify ＋ 環境変数チェック）をそのまま通せる。

```bash
WEBAUTH_CLIENT_ID=placeholder npm run build
WEB_OAUTH_CLIENT_ID=placeholder PICKER_API_KEY=placeholder GCP_PROJECT_NUMBER=000000000000 npm run build:web
```

- 出力先の `dist/` と `docs/app/` はどちらも `.gitignore` 済みなので、差分は汚れない。
- **プレースホルダで作った成果物を配布・アップロードしないこと。**認証が通らないビルドになる。用途はコンパイル検証のみで、実際に配布する `dist.zip` は必ず `.env` のある環境で `npm run release` から作る。
- **`src/sidepanel/` 配下を変更したら両方のビルドを通すこと。**そのコードは Web版バンドルにも入る（`src/webapp/index.ts` が `src/sidepanel/bootstrap.ts` の `bootstrapCommon()` を呼ぶ）。拡張版だけ確認して Web版の回帰を見落とす事故を防ぐ。
- メインチェックアウトの `.env` を worktree へコピーする回避策は取らないこと。秘密情報を余計な場所へ広げる。

### リリース（Chrome Web Store）

正式リリース済み（2026-07〜）のため、**リリースビルドは常にストア用**。zip を Google Drive で配布する経路は廃止した（最後の zip 配布は v0.24.0）。

バージョンは `0.<major>.<minor>` 形式（先頭の 0 は固定）。

**リリース前に作業ツリーがクリーンである必要がある。** `npm run bump`（`scripts/bump-version.ps1`）は冒頭で `git status --porcelain --ignore-submodules=dirty` を確認し、未コミットの変更が残っていれば何も書き換えずに停止する。`scripts/bump-version.ps1` は UTF-8 BOM 付きで保存すること（Windows PowerShell 5.1 が BOM 無しを CP932 として読むため）。

```bash
npm run release         # = release:minor（デフォルト）
npm run release:minor   # 修正・小変更 0.33.2 → 0.33.3 + ストア用ビルド + dist.zip
npm run release:major   # 機能追加     0.33.2 → 0.34.0 + 同上
```

バンプは `package.json` / `src/manifest.json` / `src/sidepanel/sidepanel.html` / `package-lock.json` の4ファイルを更新し、スクリプト自身がその4ファイルだけをステージしてローカル commit まで行う（**push は手動**）。後続の `npm run build:release` が失敗した場合は `git reset --hard HEAD~1` で戻せる（差分は version と Build 日付のみ）。

1.0.0 など先頭の数字を動かす場合のみ `./scripts/bump-version.ps1 -SetVersion "1.0.0"` で明示指定する。

生成された **`dist.zip`** を Chrome Web Store デベロッパーダッシュボードへアップロードする。**ファイル名は `dist.zip` 固定**（バージョン付きの名前ではアップロードできない）。ストア用ビルドは manifest の `key` を削除し（ストアがID `alejln…` を付与）、OAuth クライアントID (`.env` の `WEBAUTH_CLIENT_ID`) は webpack DefinePlugin 経由でコードに埋め込む（manifest には含めない）。

**`dist.zip` から source map を除外している（Issue #126）。** 拡張ビルドの `devtool` は本番のみ `hidden-source-map`（`webpack.config.js`）。変わらないのは development ビルド（`npm run dev` / `npm run watch`）の方で、こちらは `devtool: 'source-map'` のままで `//# sourceMappingURL=` も出るため、従来どおり TypeScript のソースにマップされる（デバッグは通常こちらで行う）。一方、本番ビルドの `dist/` は変わる：`.map` ファイル自体は出力され続けるが `sourceMappingURL` コメントを出さないため、DevTools は `dist/` に置かれた `.map` を自動では読み込まない（必要なら手動で "Add source map…" する）。これにより `.map` を含まない `dist.zip` を配布しても DevTools が参照先を探して 404 警告を出すことはない。本番でも `.map` を生成し続けているのは、`scripts/pack-release.ps1` が「0件なら devtool 設定が壊れている」と検知するカナリアに使うのと、手動 attach 用に残すためでもある。`build:release` は `scripts/pack-release.ps1` を呼び、`dist/` を `.tmp/release/` へコピーしてから `.map` を削除して zip 化するステージング方式を取る（`Compress-Archive -Path` にファイルの配列を渡すとディレクトリ構造が失われフラットな zip になり、`sidepanel/sidepanel.js` のような相対パス前提の拡張機能が壊れるため）。`.map` の削除は拡張子の厳密一致で行うこと。`Get-ChildItem -Filter "*.map"` は Windows の8.3短縮名によるワイルドカードマッチの影響を受け、拡張子が `.map` でなくても短縮名の拡張子部分が「MAP」になるファイル（例: `routes.mapping`, `data.mapx`）を誤って巻き込みうる（PR #127 レビュー指摘：Windows PowerShell 5.1・8.3短縮名有効の環境で実測して確認）。`dist/cmaps/` には pdf.js の `.bcmap` が168本入っており、これは一部PDFの描画に必要なので消してはいけない。拡張子の厳密一致（`-eq '.map'`）で絞り込むこと。`scripts/pack-release.ps1` も `scripts/bump-version.ps1` と同じく UTF-8 BOM 付きで保存すること（理由は上記バンプスクリプトの節と同じ）。

launchWebAuthFlow のリダイレクトURIは拡張機能IDから実行時に導出されるため、`WEBAUTH_CLIENT_ID` は dev/ストアの両ビルドで単一クライアントを共用する。ただし Google Cloud Console 側の「承認済みリダイレクトURI」には拡張機能IDごとに1件ずつ（`https://alejlnlfflogpnabpbplmnojgoeeabij.chromiumapp.org/` と `https://ifnejjicfekmighagknaacliiiliodgf.chromiumapp.org/`）登録しておく必要がある。

> 廃止済み（履歴）: かつてテスター向けに `build:zip:tester`（`--env keepKey` + `ZIP_OAUTH_CLIENT_ID`、固定ID `ifnejji…`）で zip を Drive 配布していた。`key` を削除した zip を直接配布すると拡張機能IDがランダム化し `bad client id` になるため、zip 配布を再開する場合は key 保持ビルドが必須（git 履歴の `build:zip:tester` を参照）。

### Web版（ブラウザ版）

Chrome拡張をインストールせずブラウザだけで判定に参加できる Web 版を GitHub Pages で配信している（<https://youkiti.github.io/tiab-review-plugin/app/>）。**位置づけはレビュー専用**。プロジェクト作成・文献取り込み・LLM/ML・フルテキストは拡張版のみの機能で、Web版は「拡張版で作られたプロジェクトを開いて判定する」用途に限定する（タブレット・スマホ・Chrome以外のブラウザからの共同レビュー参加を想定）。

| 項目           | 内容                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| エントリ       | `src/webapp/index.ts`（Picker ページは `src/webapp/picker.ts`）                                                                                 |
| ビルド         | `npm run dev:web`（開発） / `npm run build:web`（本番）                                                                                          |
| 出力先         | `docs/app/`。**`.gitignore` 済み。実装 PR にビルド成果物を含めないこと**                                                                         |
| デプロイ       | `main` への push で `.github/workflows/deploy-web.yml` が本番ビルドして Pages へ自動デプロイ。手動コミット不要                                   |
| 認証           | GIS（`src/platform/web/auth.ts`）。`.env` の `WEB_OAUTH_CLIENT_ID` / `PICKER_API_KEY` / `GCP_PROJECT_NUMBER` を使う（本番・dev いずれも未設定だと throw。`ALLOW_NO_AUTH=1` 指定時のみ dev ビルドは警告に格下げ） |
| ストレージ     | `localStorage`（`tiab:` プレフィックス。`src/platform/web/storage.ts`）                                                                          |

**トークンは1時間固定で、無音更新はできない。** GIS の `TokenClient` はサイレントリフレッシュの仕組みを持たないため、`chrome.identity` 版のようなバックグラウンド更新はできない。トークンはメモリ保持のみ（`src/platform/web/auth.ts`）で、1時間経過後は次回の保存操作が失敗して初めて失効に気づく。この前提のため、失効の検知と再ログイン導線はユーザー操作（判定クリック・未送信バッジクリック）起点で設計している（`classifySaveFailure` で `'auth'` と判定された場合のみ、その場で対話的な再ログインを試す。詳細は「オフライン同期の方針」節）。対話的な再ログインでは `PlatformAdapter.setAuthHint`（`showProjectSection` でログイン中のメールを渡す）経由で GIS の `login_hint` を設定し、複数 Google アカウントログイン中でもアカウント選択を省略できるようにしている。

**HTML は複製ではなく機械変換で生成する。** `webpack.config.js` の `transformSidepanelHtml()` が拡張版の `src/sidepanel/sidepanel.html` を変換して `docs/app/index.html` を出力する。これにより表示系の新機能が自動で Web 版へ載る。変換対象の文字列が見つからない場合は `replaceOrThrow` が例外を投げてビルドを止めるので、`sidepanel.html` の該当行（`<title>` / `<h1>` / `<body>` / stylesheet link / entry script / viewport meta）を書き換えたら変換ルールも必ず更新すること。

**機能差は `capabilities` フラグで表現する。** `src/platform/types.ts` の `PlatformAdapter.capabilities` を各アダプタ（`platform/chrome` / `platform/web` / `platform/demo`）が実装し、共有ブートストラップ `src/sidepanel/bootstrap.ts` がそれを見て拡張専用 UI を隠す。

- Web版だけの分岐を `bootstrap.ts` に書かないこと。**Web版限定のロジックは `src/webapp/` 配下に置き、Web版エントリからのみ呼ぶ**。拡張版エントリ（`src/sidepanel/sidepanel.ts`）から到達不能になり、拡張版への回帰を構造的に防げる。
- 共有 HTML に Web版専用の要素を足す場合は、初期状態を `hidden` クラス（`styles/base.css` で `display: none !important`）にし、表示側だけが外す設計にする。拡張版では誰も外さないため出ない。
- 機能をひとつ落とすときは、それに付随する説明文や導線も一緒に落とすこと（ボタンだけ隠して help-text が残る、といった矛盾が起きやすい）。

**ローカル確認手順**（`file://` では GIS が動かないので必ず localhost で開く）:

```bash
npm run dev:web
npx http-server docs/app -p 8080   # または python -m http.server 8080 -d docs/app
```

`http://localhost:8080` を開く。**`127.0.0.1` は不可**（OAuth クライアントの承認済み JavaScript 生成元に `https://youkiti.github.io` と `http://localhost:8080` を登録しているため）。

**CI ゲート**: `.github/workflows/build-check.yml` は PR ごとに独立した4ジョブを実行し、すべての成功をマージ条件とする。`quality`（typecheck / lint / test / check:structure）、`build-extension`（拡張production）、`build-web`（Web production）、`bundle-budget`（check:bundle）。各ジョブで `.nvmrc` のNodeとnpmキャッシュを使い、依存を `npm ci` でインストールする。PR更新時は同じrefの古い検査をキャンセルする。devビルド疎通確認をproduction検証へ置き換え、minifyと環境変数チェックも通す。ローカルでも以下を通してから PR を出すこと。認証値は検証用プレースホルダーを使い、成果物は配布・アップロードしない。並列化の効果はNode準備・依存インストールを含むCIの実測で確認する。Web自動デプロイ（`deploy-web.yml`）と拡張リリースのsource map除外は維持する。

```bash
npm run typecheck && npm run lint && npm test && npm run check:structure
WEBAUTH_CLIENT_ID=placeholder npm run build
WEB_OAUTH_CLIENT_ID=placeholder PICKER_API_KEY=placeholder GCP_PROJECT_NUMBER=000000000000 npm run build:web
npm run check:bundle
```

### 過去のレビュー指摘をコメントで参照するときの書き方

**「なぜこうなっているか」をコメントに残すときは、必ず PR 番号か Issue 番号でアンカーすること**（`PR #122 レビュー指摘2`、`Issue #118 チャンク2`）。既存コードもこの形になっている（`src/sidepanel/features/fulltext/ai.ts` の `PR #102 レビュー指摘`、`tests/ensure-headers-drive-columns.test.ts` の `PR #121 レビュー指摘対応`）。

- **裸の通し番号（`修正2`・`指摘2b` など）を書かないこと。** レビュー依頼やタスク分解の中だけで通じる番号は、マージされた後のコードでは何も指さない。読み手は元のやり取りを持っていないので復元もできない
- **この漏れは「指示の側が項目に番号を振ったとき」に起きる。** 実例: PR #122 のレビュー対応で、指示文の `修正1`〜`修正3` という通し番号がそのままコメントとテスト見出しへ写り、7ファイル分を差し戻して書き直した。番号付きの指示を受けて実装するときは、コメントに落とす前に PR/Issue 番号へ言い換えること
- **枝番（`2b` など）も使わない。** 指摘の内容を短く言い添える（`PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点）`）。元のレビューに `2b` という項目が存在しないことすらある
- Issue 番号だけで足りるように見えても **PR 番号を併記しておく**と、後から `gh pr view <n>` で当時の議論と差分の両方に辿り着ける

### テスト・作業ツリーの落とし穴

- **CSS を分割・改名するときは、CSSの実ファイルを `readFileSync` で読むテストを探すこと。** `tests/decision-item-note-layout.test.ts` は `src/sidepanel/styles/decisions.css` と `fulltext-tab-conflict.css` をリポジトリルート基準で直接読み、`.decision-item .note` や `.fulltext-conflict-vote-note` の宣言を正規表現で検査している（レイアウト崩れはCSSでしか担保できないため）。Issue #191 の CSS 分割で `fulltext-tab.css` を改名した際、**typecheck も lint も構造検査も素通りし、`npm test` の `ENOENT` で初めて気づいた**。CSSのファイル名を変えたら `grep -rn "\.css" tests/` を必ず通すこと。
- **`tests/tsconfig.json` の `types` は明示列挙**（`node` / `chrome` / `google.accounts`）。新しい ambient 型に依存するテストを足すと `Cannot find namespace` で `npm run test` が落ちるので、型の追加もセットで行うこと。`include` も明示列挙だが、テストから import したモジュールは推移的に取り込まれるため、通常は `types` 側だけが問題になる。
- **`.gitignore` の `node_modules/` は末尾スラッシュ付きでディレクトリにしかマッチしない。** `git worktree` を作って `node_modules` をシンボリックリンクで共有すると untracked のまま残り、`git add -A` でコミットへ混入する。worktree で作業するときは変更ファイルをパス指定でステージすること。
- **`npm run test` は `scripts/run-tests.mjs` 経由で、毎回 `.tmp/tests` を全消去してから現在 `tests/` に存在する `*.test.ts` だけを `node --test` に渡す**（Issue #162）。以前は `.tmp/tests/tests/*.test.js` を glob で拾っていたため、削除済みブランチのテストがコンパイル済みのまま残っていると件数が水増しされた（実例: `auth-pkce.test.js` が残って 392 件と表示されたが、真値は 379 件だった）。ラッパーは実行したテストファイル数を `N / N テストファイルを実行` と出すので、`tests/*.test.ts` の数と一致することを確認できる。対象を絞るときは `npm test -- doi fulltext-pool` のようにファイル名の部分一致で指定する（コンパイルは全件行う）。
- **`node:assert/strict` の `deepEqual` は「値が `undefined` のプロパティ」と「プロパティ自体が無い」を区別する。** 戻り値の型（例: `FulltextFetchOutcome`）に**任意**フィールドを1本足しただけで、その戻り値を `deepEqual` で丸ごと比較している既存テストが「actual に余分なキーがある」と落ちる。実装のバグではないので、期待値側にそのキーを明示して追従させること（Issue #118 チャンク2で `registryPmids` を足した際に3件が落ちた）。
- **`src/demo/seed.ts` はテストから直接 import できない。** `sample/*.nbib` を raw-text import（`declare module '*.nbib'`、webpack ローダー前提）しているため、`tsc` + `node --test` の経路では `.nbib` を JS として読もうとして落ちる。そのためヘッダーミラーのドリフト検出テストは、seed.ts 側の期待値をテストファイルへ直書きして `sheets-api.ts` の実エクスポートと突き合わせる流儀になっている（`tests/references-headers-record-type.test.ts` / `tests/publication-candidates-headers.test.ts`）。**seed.ts だけを変えるとドリフトを検出できない**ので、列を足すときは seed.ts・sheets/schema.ts・テストの3箇所を必ず同時に直すこと。
- **lint は型の緩さを検出しない。** `.eslintrc.cjs` は `@typescript-eslint/no-explicit-any` も `no-unused-vars` も有効にしていないため、`any` や未使用変数は CI を素通りする。`src/lib/` の既存コードが `any` を使っていないのは規約であって強制ではないので、レビュー側で見ること。
- **References の読み取り範囲は `A:X` のような終端列直書きにしない。** Issue #118 チャンク1で `References!A:X` を4箇所（`getReferences` / `updateReferenceColumnByRefId` / `getFulltextPageData` の2箇所）直書きしていたのを、`REFERENCES_LAST_COLUMN`（`columnLetter(REFERENCES_HEADERS.length)`、Decisionsの`DECISIONS_LAST_COLUMN`と同じ流儀）から導出する形に直した。直書きのままだと末尾に列を足しても新列が読み取り範囲外になり、書き込んでも永久に空として読まれる。`ensureHeaders()` 内のヘッダー行範囲（`A1:${REFERENCES_LAST_COLUMN}1` での読み取り・書き込み）も同じ理由で `A1:Z1` 直書きから導出に揃えた（26列がちょうどZ列なのは偶然で、次に列を1本足すと読み取り打ち切り＋書き込み時の列数不一致エラーの両方が起きるところだった）。ただし `References!T:X`（fulltext系5列専用の部分範囲）や `References!A1:X1`（W/X列単体の検証用、`ensureFulltextDriveColumnsOnce()` 内）のように、意味的に「References全体」ではない固定範囲は対象外＝変更不要。
- **`Pick<Reference, ...>` のように `Reference` を絞り込んだ型は、絞り込んだフィールドが全て optional だと構造的部分型のせいで typecheck をすり抜ける。** 絞り込み型Aが「実際に必要なフィールドの一部だけ持つ、より狭い絞り込み型B」を要求する関数に、Bより広いはずのAの値を渡しても、Aに欠けているフィールドがBの型定義上 optional なら、コンパイラは「無い」ことを検出できずコンパイルが通る。レジストリ連携フェーズ1チャンク3で実際に踏んだ（`src/lib/team-progress.ts` の `TeamProgressRef` が `related_ref_id` を持たないまま `fulltext-candidates.ts` の関数へ渡され、`isSharedFulltextPoolMember()` の分岐が本番で一度も発火しなかった。詳細は「論文候補の取り込み」節参照）。**`Reference` を絞り込んだ型を新設・変更するときは、型チェックだけで安心せず、配線の全経路（絞り込み型を組み立てている全箇所）が本当に必要なフィールドを運んでいるか目視確認すること。** 純関数のユニットテストも、引数へ絞り込んだオブジェクトリテラルを直接手書きして渡す形だと、配線側の欠落を再現できず検出できない（配線の境界＝実際に絞り込み型を組み立てている関数の入出力でテストすること）。PR #124 レビュー指摘7でこの教訓を実際に適用した: `ReferenceWithStatus` → `TeamProgressRef` の変換を `src/lib/team-progress.ts` の `toTeamProgressRef()` という小さな純関数へ切り出し（呼び出し元だった `initTeamProgress()` / `buildFooter()` の2箇所の重複実装を統一）、`tests/team-progress.test.ts` にこの関数自体の入出力を検証するテストを追加して、配線の境界へ実際に移した。
- **真偽値フラグ（`if (loading) return;`）による非同期処理の二重起動防止は、その処理の完了を `await` して待つ呼び出し元がいると成り立たない。** 進行中の呼び出しを「捨てる」だけで、待っている側には何も返せないため、`await` 側は実際には何も起きていないのに「完了した」と思い込んで先へ進んでしまう。レジストリ連携フェーズ1チャンク3で実際に踏んだ（`features/fulltext/tab.ts` の `loadPublicationCandidates()` を、一括検索/再探索の完了時は fire-and-forget（`void`）で呼ぶ一方、候補の取り込み完了後は `await` して待っていたため、前者が進行中に後者が呼ばれると空振りしていた）。fire-and-forget と `await` の呼び出しが混在する非同期処理には、進行中の Promise をそのまま返して合流させるヘルパー（`src/lib/async-coalesce.ts` の `createAsyncCoalescer()`）を使うこと。**ただし `createAsyncCoalescer()` は `inFlight` を1本しか持たないため、プロジェクト（`spreadsheetId`）単位の処理へ素で使うとプロジェクトをまたいで合流してしまう。** 合流の単位が「現在のプロジェクト1つ」なら単一スロットの memo（`src/lib/sheets/llm-history.ts`）、複数キーを同時に扱うなら `Map` でキーごとにコールセーサーを分ける（`src/sidepanel/utils/offline-queue.ts`）。さらに、合流を分けるだけでも足りない: 取得完了時に現在のプロジェクトと突き合わせて破棄する処理が別途要る（`src/sidepanel/features/team-progress.ts` の `fetchDecisions()`、`src/sidepanel/features/fulltext/candidates-loader.ts`）。片方だけ直すと症状が別の形に移るだけになる（Issue #188）。
- **ブリーフが名指しした1箇所だけを直すと、同じルーティング判断を行う別の呼び出し元が直り漏れることがある。** レジストリ連携フェーズ1チャンク3で、`showPdfForRef()` の分岐だけを直す指示だったが、`showCachedPdf()` の全呼び出し元を grep すると `handleResolve()`（初回自動検索）にも同じ分岐判断のコピーがあり、そこを直さないと「registration行の初回表示だけ直っていない」状態になっていた。**ある関数の呼び出し条件を変更・追加するときは、対象関数の全呼び出し元を一度 grep し、同じ判断ロジックが他の場所に重複していないか確認すること。**

### ローカル実験環境

LLMのパラメーター調整などの実験をローカル環境（Chrome拡張外）で実行可能。

1. **セットアップ**:
   - `.env` に `GEMINI_API_KEY` を設定
   - `npm install`
2. **実行**:
   ```bash
   npx ts-node --project experiments/tsconfig.json experiments/runner.ts
   ```
3. **構成**:
   - データ: `experiments/data/sample.json`
   - ロジック: `experiments/runner.ts`
   - 結果: `experiments/results/`にJSONとして保存

#### 実験ディレクトリを追加するときの落とし穴

モデル評価は `experiments/<モデル名>/`（`plan.md` / `config.json` / `runner.ts` / `summarize.ts`）を1モデル1ディレクトリで作る慣行になっている。既存ディレクトリを複製して始めるときに踏むものを挙げる。

- **`experiments/` は CI の型検査・lint の対象外。** ルートの `tsconfig.json` は `include` が `src/**/*` のみ、`npm run lint` も `eslint src/**/*.ts` のみを見る。つまり実験コードが壊れていても CI ゲートは緑のまま通る。追加・変更したら各ディレクトリの tsconfig で個別に検査すること:

  ```bash
  npx tsc --noEmit --project experiments/<ディレクトリ>/tsconfig.json
  ```

- **その検査では `worker-client.ts` の `import.meta` エラーが必ず1件出る。これは既存の事象で、自分の変更が壊したわけではない。** 各実験の tsconfig が `rootDir: "../.."` を指定して `src/` 全体を巻き込むために起きる。切り分けたいときは未変更の既存ディレクトリ（例: `experiments/gemini-3.6-flash/tsconfig.json`）に対して同じコマンドを流し、同一のエラーが再現することを確認する。**新規ファイル起因のエラーが0件であること**を判断基準にすること。
- **`ts-node` は devDependencies に入っていない。** 各 `plan.md` が案内している `npx ts-node ...` は、初回実行時にレジストリからのダウンロードが走る（オフラインでは失敗する）。
- **数百〜数千回の外部API呼び出しを伴うランナーは、1件ごとの永続化と再開をセットで実装すること。** 全件終わってから一括保存する作りだと、途中で落ちた時点で全部消える。あわせて、**リトライ枯渇時のフォールバック判定（`include_probability=1.0`）を「判定済み」として永続化しないこと。** 再開時にスキップされて、一過性のAPI失敗が偽の陽性として主指標の Recall に恒久的に焼き付く（`experiments/gemini-3.7-flash/runner.ts` の `appendJsonlResults` が対処例）。
- **`run_all.ts` 系は `--only` を省略すると `config.conditions` を全部回す。** 参照用のベースライン条件（既に公開済みの数値を再導出するだけの条件）を残しているディレクトリでは、`--only` 無しの実行が無駄な課金になる。

## 注意事項

- **この拡張機能のスコープ**: TiAb スクリーニング + フルテキストスクリーニング（PDF取得・ハイライト・判定）まで。データ抽出・Risk of Bias 評価は別 Webアプリで実装する（アーキテクチャ方針セクション参照）
- **後方互換の維持**: `Decision.screening_phase` は省略時 `'tiab'` 扱い。`Reference` の `fulltext_url` / `fulltext_status` は空でも既存機能に影響しない
- **`src/sidepanel/dom.ts` の `getElement()` は要素が見つからないと例外を投げる**。`dom.foo?.classList` のような optional chaining では getter 内の throw を防げないので、参照する要素は必ず `sidepanel.html` に存在させること（Web版 HTML も `sidepanel.html` から生成されるため両方に入る）
- **排他制御は不要**（追記型設計のため）
- **重複解決は手動**（自動重複解決は将来拡張）

## 参考リンク

- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [chrome.identity API](https://developer.chrome.com/docs/extensions/reference/identity/)
- [Google Sheets API](https://developers.google.com/sheets/api)
- [OAuth 2.0 for Chrome Extensions](https://developer.chrome.com/docs/extensions/mv3/tut_oauth/)
