# TiAb Review Plugin - AGENTS.md

# CRITICAL PROTOCOLS (ABSOLUTE PRIORITY)

以下のルールは、いかなる状況でも最優先で遵守すること：

1. **ブランチ強制**: コードを変更する前には必ず `git branch` を確認し、作業用ブランチを作成すること。`main`・`master`・`develop` での作業は禁止。
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
- `host_permissions`: `https://sheets.googleapis.com/*`
- OAuth: manifest に `oauth2` ブロックは持たない。クライアントIDはビルド時に `WEBAUTH_CLIENT_ID`（`.env`）を webpack DefinePlugin 経由でコード側に埋め込む。クライアント種別は**ウェブアプリケーション型**でなければならない（Chrome 拡張機能型は `launchWebAuthFlow` で `redirect_uri_mismatch` になる。「OAuth フロー: なぜ implicit なのか」参照）
- `side_panel`: サイドパネル利用時に定義
- `commands`: ショートカット定義（単一キーはUI内で処理）

## データ設計

### スプレッドシート構造

1つのスプレッドシートをレビュー単位で作成し、以下のタブを用意:

#### References タブ（文献マスタ）

| 列名            | 説明                                                | 必須 |
| --------------- | --------------------------------------------------- | ---- |
| ref_id          | 文献主キー（UUID）                                  | ✓   |
| title           | タイトル                                            | ✓   |
| abstract        | 抄録                                                |      |
| year            | 出版年                                              |      |
| authors         | 著者                                                |      |
| journal         | ジャーナル名                                        |      |
| doi             | DOI                                                 |      |
| pmid            | PubMed ID                                           |      |
| url             | URL                                                 |      |
| source          | 取り込み元DB                                        |      |
| imported_at     | 取り込み日時                                        |      |
| imported_by     | 取り込み者                                          |      |
| dedupe_key      | 重複検出キー（後述）                                |      |
| fulltext_url    | フルテキストURL（OA / ブラウザアタッチ）            |      |
| fulltext_status | `not_retrieved` / `retrieved` / `unavailable` |      |

#### Decisions タブ（追記専用の判定ログ。最新行が有効）

| 列名            | 説明                                   | 必須 |
| --------------- | -------------------------------------- | ---- |
| decision_id     | 判定ID（UUID、判定イベントごとに新規発番） | ✓   |
| ref_id          | 文献ID（Referencesと結合）             | ✓   |
| reviewer_id     | 判定者（email）                        | ✓   |
| decision        | include / exclude / maybe              | ✓   |
| reason          | 除外理由（excludeの場合必須）          |      |
| labels          | (廃止)                                 |      |
| note            | メモ                                   |      |
| decided_at      | 判定日時（ISO 8601）                   | ✓   |
| client_version  | 拡張機能バージョン                     |      |
| source_url      | 判定時に見ていたURL                    |      |
| screening_phase | `tiab`（省略時も同義）/ `fulltext` |      |

**重要**（2026-08 追記専用化。詳細は「κ（Cohen's kappa）の算出」参照）:

- **Decisions は追記専用**: human 判定（`client_version` に `-human` を含む）と ML 手動確認判定（`-ml` を含み `-auto` を含まない）は、既存行を更新せず**常に新しい行として追記**する
- 同一 `ref_id` + `reviewer_id` + `screening_phase` の行は複数存在しうる。**`decided_at` が最新の行（同値の場合はシート上で後の行）を有効な判定とする**。読み取り側（UI・進捗集計・不一致検出など）はこの最新行だけを見るため、下流の挙動は追記専用化前と同じ
- 過去の行は判定変更の履歴として保持する（合議前後の κ 算出などに利用できる）
- **ML自動判定・LLM判定は従来どおり既存行を更新する**（pending→confirm の行更新と `deleteFulltextAiRound` のラウンド管理を壊さないため）
- **他者の判定**: 他の `reviewer_id` の判定行は上書き禁止（変更なし）
- スプレッドシートの列定義は変更していないため、既存プロジェクトはそのまま動作する

#### Config タブ（プロジェクト設定）

- **include_keywords**: 組み入れハイライト用キーワード（緑）
- **exclude_keywords**: 除外ハイライト用キーワード（赤）
- **fulltext_pool_rule**: フルテキスト候補ルール（JSON: `{version, voters, threshold}`）。採用する判定者（voter: `human:{email}` / `ml:{email}` / `llm:{...}`）の TiAb Include 票が `threshold` 以上の文献を候補とする。キー開封後にフルテキストページから設定。未設定時は、管理ユーザーは読み込まれている全レビュアーの TiAb Include が1件でもある文献を候補とし、非管理ユーザーは既存の割り振りで見える文献のうち自分が TiAb Include した文献だけを候補とする。
- **import_stats**: インポート統計（JSON: `{"ファイル名": {identified, duplicates, imported_at}}`）。ファイルごとの解析件数（重複除去前）と重複スキップ数をインポート時に記録し、論文用テキスト（PRISMAフロー図の識別件数・重複除去数）の自動記入に使う。ソースファイル削除時は該当キーも削除する。

#### Annotations タブ（PDFアノテーション）

フルテキストスクリーニングおよびデータ抽出で使用するPDFハイライトを1行1件で保存する。
`phase` と `category` の組み合わせで用途を区別し、将来のWebアプリ（データ抽出・RoB）からも参照できる。

| 列名             | 説明                                                         | 必須 |
| ---------------- | ------------------------------------------------------------ | ---- |
| annotation_id    | UUID                                                         | ✓   |
| ref_id           | References への FK                                           | ✓   |
| reviewer_id      | email                                                        | ✓   |
| phase            | `fulltext_screening` / `data_extraction`                 | ✓   |
| category         | `include_evidence` / `exclude_evidence` / `data_point` | ✓   |
| label            | データ抽出時のフィールド名（例:`sample_size`）             |      |
| highlighted_text | ハイライトしたテキスト本体                                   | ✓   |
| page_number      | PDFページ番号（1始まり）                                     | ✓   |
| position_json    | `AnnotationPosition` を JSON 文字列化したもの（再描画用）  |      |
| pdf_url          | アノテーション作成時のPDF URL                                | ✓   |
| created_at       | ISO 8601                                                     | ✓   |

`position_json` の構造（`AnnotationPosition` 型）:

- `page` / `offset_start` / `offset_end`: PDF.js TextContent ベースの文字オフセット（主キー）
- `context_before` / `context_after`: 前後50文字（オフセット失敗時のフォールバック）

## 機能要件

### MVP（必須機能）

1. **初期設定**

   - スプレッドシートID入力
   - References/Decisionsシート名設定
   - プロジェクト指定（Google Drive上のスプレッドシートを選択、Drive Picker 使用）
   - スプレッドシートが存在しない場合は新規作成（References/Decisions/Configシート自動生成）
   - RISアップロード機能
2. **文献読み込み**

   - Referencesから文献一覧を取得
   - Decisionsから判定状態を算出
3. **スクリーニング画面**

   - 文献情報表示（title, abstract, year, authors, journal, doi/pmid, url）
   - **キーワードハイライト機能**（include=緑, exclude=赤）
   - 判定ボタン（include / exclude / maybe）
   - 除外理由入力（exclude時必須）
   - メモ入力
   - **キーワード編集**（サイドパネルで追加・削除→Configシートへ自動保存）
   - 次の文献へ遷移
4. **判定の記録**

   - Decisionsタブへ判定を保存
   - **human判定・ML手動確認判定**: 既存行を検索せず常に `spreadsheets.values.append` で追記（追記専用）
   - **ML自動判定・LLM判定**: 従来どおり既存行を検索し、あれば `spreadsheets.values.update` で上書き、なければ `append`
   - 読み取り側は同一 `ref_id` + `reviewer_id` + `screening_phase` の行のうち `decided_at` が最新の1行だけを有効な判定として扱う
5. **フィルタ・検索**

   - 未判定（自分が未判定）フィルタ
   - decision別フィルタ
   - maybeは未判定とは別カテゴリとして集計
   - title/abstract検索
6. **進捗表示**

   - 自分の判定件数
   - 全体の対象件数（レビュー対象総数）
   - **チーム進捗パネル**（`src/lib/team-progress.ts` + `src/sidepanel/features/team-progress.ts`）:
     管理者・非管理者を問わず全レビュアーがお互いの進捗を閲覧できる折りたたみパネル。
     TiAbタブ（ツールバー⚙️の右のチップ、クリックでドロップダウン展開・外側クリックで閉じる）と
     フルテキストタブ（候補ルール行の下、インライン展開）の両方に表示。
     - 表示内容は**件数と最終判定日時のみ**（ブラインディング維持のため include/exclude の内訳は表示しない）
     - TiAb の分母: 担当割り振り設定済みならその人の担当セット内文献数、未設定なら全文献数
     - フルテキストの分母: `fulltext_pool_rule` 設定済みの場合のみ共通候補プール数（未設定時は「—」）
     - 進捗にカウントする判定: 人間判定＋確定ML判定（LLM判定・ML自動判定・メモのみの pending 行は除外）
     - 3日以上判定がなく残作業があるメンバーに ⚠ を表示
     - データは Decisions タブから読み込み時に非同期取得し、🔄ボタンで再取得。自分の判定保存は即時反映
       （フルテキストページ＝別タブでの保存も `chrome.runtime.sendMessage`（`team-progress:decision-saved`）で
       サイドパネルへ通知され即時反映。他メンバーの判定の反映は🔄再取得）
     - メンバーが1人だけのプロジェクトでは表示しない
7. **LLMスクリーニング支援**

   - **APIキー設定**: Gemini / OpenRouter APIキーの保存・管理 (provider 別に独立保管)
   - **モデル選択**: Gemini 2 種 + OpenRouter 2 種 (Qwen3 235B Instruct, DeepSeek V4 Flash) から選択
   - **OpenRouter カスタムモデル**: ユーザーが任意のモデル ID（例: `anthropic/claude-3.7-sonnet`）を手入力 → 実 API テスト成功時のみ `chrome.storage.local` (`openrouter_custom_models`) に永続化し、モデル選択肢に追加。最大 20 件。ベンチマーク未検証であることをUIで明示する。
   - **判定基準設定**: プロンプト・判定基準のカスタマイズ
   - **一括判定**: LLMによる自動判定（バッチ処理）。対象の決定ロジックは `src/lib/llm-batch-target.ts`（純粋関数）に集約
     - **人間の判定状況では絞らない**。AIは独立した判定者なので、人間（自分を含む）が判定済みの文献も対象に含める。
       `status`（＝自分の判定）で絞ると「自分が手動判定した分だけAIの対象件数が減る」（例: 全50件中2件を自分が判定 → AI対象が48件）
       という、ログインユーザーによって判定範囲が変わる非対称な挙動になる
     - **対象の絞り込みは Run 単位**。「これから実行する Run（config_hash で解決）で既に判定済みの文献」だけを除外する
       （`ReferenceWithStatus.llmBatchIds` と Run 配下の Batch ID 集合を突き合わせる）。
       グローバルに「AI判定済みか」で絞ると、最初のRunが全件を判定した時点で2つ目以降のRunが常に0件になり、
       Runの採用選択（`is_active`）が機能しなくなる
     - **中断からの再開**: 設定が同じなら `findRunByConfigHash` が既存Runを再利用し、残りだけを新しいBatchとして処理する。
       再開できる件数がある場合は一括実行カードに「$1件が判定済み」と表示する
     - **新規にやり直す**: 「🔄 新規にやり直す」ボタン（`state.forceNewLlmRun`）をONにすると、既存Runを再利用せず
       新しいRunとして全文献を判定する。**既存の判定・履歴は一切削除しない**（Decisions/LLM_Executions/LLM_Runs はそのまま残り、
       どちらのRunを採用するかは実行履歴のラジオボタンで選ぶ）。新Run作成時にフラグは自動でOFFに戻る
     - これにより同一 config_hash のRunが複数存在しうる。`pickRunByConfigHash` は再開先として
       **最新 created_at** のRunを返す（同時刻のみ active confirmed > confirmed > pending）。
       legacy移行（run_id空のBatch集約）は逆に最古のRunへ寄せる（`pickLegacyRunByConfigHash`）
     - **件数表示（`updateBatchTargetCount`）は Sheets を再読み込みせず** `state.llmRuns` / `state.llmExecutions` のキャッシュで計算する
       （`loadExecutionHistory` が更新）。モデル・プロンプト変更のたびにAPIを叩くと読み取りクォータを超過するため
     - **実行時（`handleStartBatch`）は Run/Batch に加えて、その Run で判定済みの ref_id も Sheets から取り直す**
       （`getJudgedRefIdsForBatches`）。件数表示のキャッシュ（`llmBatchIds`）は画面ロード時のスナップショットなので、
       他レビュアーが直前に判定した分を取りこぼす。取りこぼすと同一Runに同じ文献のLLM票が二重に入り、
       AI同士の偽の不一致（conflict）が画面に出てしまうため、実行直前だけはサーバーの真値で対象を確定する
       （`selectBatchTargetsByJudgedRefIds`）
     - **基準最適化（`handleOptimizeCriteria`）後は `updateBatchTargetCount()` を明示的に呼ぶ**。
       最適化結果はプロンプト・判定基準をプログラムから代入するため `input` イベントが発火せず、
       config_hash が変わって別Runになったのに対象件数・実行モード表示が古いRunのまま残ってしまう
   - **結果表示**: LLMの判定結果・理由の表示
8. **フルテキストAI判定（PDF全文）**

   - **プロバイダ**: Gemini のみ（スキャン画像PDFもネイティブにOCR/読解。`gemini-fulltext.ts`）
   - **UI**: フルテキストタブを3分割（候補リスト / **AI判定** / 判定後レビュー）。AI判定タブは**一括処理専用**
   - **対象**: `fulltext_status='cached'`（Drive保存済み）かつ未AI判定の候補。PDFを inline_data で丸ごと送信
   - **保存**: AIは独立した判定者として確定保存（`reviewer_id='llm:{model}@{timestamp}'`, `screening_phase='fulltext'`）。
     `note` に `FulltextLlmDecisionNote`(JSON: decision根拠 evidence[quote/page/bbox] 等) を格納
   - **PDFハイライト**（`fulltext.html` + `pdf-renderer.ts`）: cached PDF を PDF.js でテキストレイヤー付き描画し、
     evidence を **経路A: quote文字列マッチ → 経路B: 正規化bbox → ページ送り** の順で段階的にハイライト。
     スキャン画像PDFはテキストレイヤーが無いため bbox（AIの領域推定）を使う旨をUIに明示
   - **依存**: `pdfjs-dist`（worker/cmaps/standard_fonts を dist 直下へ同梱）。
     manifest に `content_security_policy.extension_pages`（`wasm-unsafe-eval`）を追加
9. **論文用テキスト生成**（`manuscript.ts`）

   - TiAb エクスポートメニューとフルテキスト結果ビューから、Methods / Results / PRISMA 2020 フロー数値の英語下書きをモーダル表示し、セクションごとにコピー可能
   - 数値は `import_stats`・判定データ・判定者選択から自動挿入。ツールが持たない情報（不一致の解消方法など）は `[ ]` で残す
   - 未判定・保留・不一致が残る場合や、インポート統計のないファイル（重複除去後の件数に `*` 付与）は警告を表示
   - PRISMA の数値・論文用テキスト・CSV/RIS エクスポートはログインユーザーに依存させず `getProjectFulltextCandidateList()`（`state.allReferences` 基準）でプロジェクト全体を集計する。候補一覧・入手状況・一括OA検索・AI一括判定は「自分が作業する対象」なので担当割り振り込みの `getVisibleFulltextCandidateList()` / 割り振りのみの `getFulltextCandidateList()` を使い分けてよいが、非管理者の `state.references` はTiAb担当セットで絞られているため論文用集計には使わない

### キーボードショートカット

- `i` : Include
- `e` : Exclude
- `m` : Maybe
- `n` / `→` : 次へ
- `p` / `←` : 前へ

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

## インポート規約

- **必須列**: `title`
- **欠損値**: 空白として取り込み
- **abstract制限**: 15,000文字を超える場合は超過分を切り取り（通常の抄録は500-2000文字程度）

### dedupe_key 生成ロジック

重複検出キーは以下のルールで生成:

```
dedupe_key = normalize(title).substring(0, 100) + "|" + year + "|" + normalize(firstAuthorLastName)
```

- `normalize()`: 小文字化、記号除去、空白正規化
- `year` または `firstAuthorLastName` が欠損の場合は空文字として扱う
- DOI が存在する場合は DOI を優先使用（完全一致）

### RIS インポートフィールドマッピング

| RIS タグ     | References 列 | 備考                   |
| ------------ | ------------- | ---------------------- |
| TI / T1      | title         | 必須                   |
| AB / N2      | abstract      |                        |
| PY / Y1      | year          | 年部分のみ抽出         |
| AU / A1      | authors       | セミコロン区切りで結合 |
| JO / JF / T2 | journal       | 優先順位: JO > JF > T2 |
| DO           | doi           |                        |
| AN（PubMed） | pmid          | ソースがPubMedの場合   |
| UR / L1      | url           |                        |
| DB           | source        |                        |

### ClinicalTrials.gov CSV インポートフィールドマッピング

| CSV カラム     | References 列 | 備考                                     |
| -------------- | ------------- | ---------------------------------------- |
| Study Title    | title         | 必須                                     |
| NCT Number     | pmid          | dedupe_key 生成に使用                    |
| Study URL      | url           |                                          |
| Start Date     | year          | 年部分のみ抽出                           |
| ―             | journal       | 固定値 "ClinicalTrials.gov"              |
| ―             | source        | 固定値 "ClinicalTrials.gov"              |
| その他全カラム | abstract      | `カラム名: 値` 形式で `\|` 区切り合成 |

### ICTRP XML インポートフィールドマッピング

| XML 要素           | References 列 | 備考                                   |
| ------------------ | ------------- | -------------------------------------- |
| Scientific_title   | title         | 必須                                   |
| TrialID            | pmid          | dedupe_key 生成に使用                  |
| web_address        | url           |                                        |
| Date_registration  | year          | 年部分のみ抽出                         |
| Source_Register    | source        | レジストリ名（REBEC, JPRN 等）         |
| ―                 | journal       | 固定値 "ICTRP"                         |
| その他臨床情報要素 | abstract      | `要素名: 値` 形式で `\|` 区切り合成 |

### EndNote XML インポートフィールドマッピング

EndNote 公式 DTD に準拠（`<source-app name="EndNote">` を含む XML）。各テキスト値は `<style face="..." font="..." size="...">value</style>` でラップされているが `Element.textContent` で取得する。

| XML 要素                            | References 列 | 備考                                                                                                          |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `titles > title`                  | title         | 必須                                                                                                          |
| `contributors > authors > author` | authors       | セミコロン区切りで結合（10名超は `et al.` を付与）                                                          |
| `dates > year`                    | year          | 年部分のみ抽出                                                                                                |
| `periodical > full-title`         | journal       | 第1優先                                                                                                       |
| `titles > secondary-title`        | journal       | `full-title` が無い場合のフォールバック                                                                     |
| `volume`                          | volume        | "6(2)" 形式の場合は volume="6", issue="2" に分離（Embase 経由のエクスポート対応）                             |
| `number`                          | issue         | 標準の EndNote エクスポートではこちらに号が入る。第1優先                                                      |
| `pages`                           | pages         |                                                                                                               |
| `isbn`                            | issn          | EndNote DTD は ISSN 専用フィールドを持たないため `<isbn>` に格納される。ISSN形式（XXXX-XXXX）の場合のみ採用 |
| `electronic-resource-num`         | doi           | 末尾の `[doi]` 等のサフィックスは除去                                                                       |
| `accession-num`                   | pmid          | `remote-database-name` が PubMed の場合のみ。Embase 等の場合は誤マッチ防止のため未設定                      |
| `urls > related-urls > url`       | url           | 最初の1件                                                                                                     |
| `abstract`                        | abstract      | 15,000 文字に制限                                                                                             |
| `remote-database-name`            | source        | 例: "Embase", "PubMed"。空なら "EndNote"                                                                      |

### オフライン同期の方針

- **キュー永続化**:
  - **小規模（100件未満）**: `chrome.storage.local` を使用（5MB制限）
  - **大規模**: IndexedDB を使用（容量制限なし）
- **キュー内の重複排除**: 送信前に同一 `ref_id` + `reviewer_id` + `screening_phase`（省略時 `tiab`）の未送信項目はキュー内で最新の1件へ置き換える（`decision_id` はDecisionsタブ追記専用化に伴い判定イベントごとに新規発番されるため、このキーで同一性を判定する。詳細は `src/sidepanel/utils/offline-queue.ts` の `upsertDecision`）
- **同期順序**: `decided_at` の昇順で送信し、失敗時は次回再試行
- **冪等性**: ML自動判定・LLM判定は既存行への upsert のため再送しても重複しない。human判定・ML手動確認判定は追記専用のため、内容が直前の保存と完全一致する場合のみ保存側のスナップショットキャッシュ（60秒TTL、詳細は `decisionContentCache`）で重複追記を防げる。それを超える間隔での再送（長時間オフライン後のflushなど、サーバ側の書き込み成功をクライアントが確認できずに再試行するケース）は重複行を生みうる既知のトレードオフ

### エラーハンドリング

- **OAuth失効**: `chrome.storage.session` のトークンキャッシュを破棄し revoke した上で、サイレント `launchWebAuthFlow`（`prompt=none`）による再取得を促す。再ログイン促進、作業続行不可の明示、オフラインキューへ退避
- **権限不足**: 権限不足メッセージ＋シート共有設定への導線、読み取り専用モードへフォールバック
- **クォータ超過**: 指数バックオフ（初回1秒、最大32秒）でリトライ、手動再試行ボタン

### セキュリティガイドライン

- **トークンのサニタイズ**: ログ出力前に `token.substring(0, 8) + '...'` で省略
- **本番ビルド**: `console.log` を除去（webpack/esbuild の drop 設定）
- **ストレージ方針**: センシティブデータは可能な限りメモリ/セッションに置き、永続化が必要な場合は保存前にアプリ側で暗号化

### ローカルデータ管理

- **キャッシュクリア**: シート切り替え時に自動削除
- **ログイン切替**: emailごとに別ストレージキーで分離

## ディレクトリ構造（推奨）

```
tiab-review-plugin/
├── .agent/
│   └── AGENTS.md
├── scripts/                   # データ分析・ユーティリティスクリプト (Python)
│   ├── analyze_llm_datasets.py
│   ├── fetch_openalex_testdata.py
│   └── ...
├── src/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── background/
│   ├── popup/
│   ├── sidepanel/             # TiAb スクリーニング（サイドパネル）
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
│   │   └── fulltext.ts        # エントリポイント（URL param: ref_id）
│   ├── lib/
│   │   ├── gemini-api.ts      # Gemini API クライアント
│   │   ├── sheets-api.ts      # Sheets API (Annotations タブも扱う)
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

## 型定義

```typescript
// types.ts

export interface Reference {
  ref_id: string;           // UUID
  title: string;
  abstract?: string;
  year?: number;
  authors?: string;
  journal?: string;
  doi?: string;
  pmid?: string;
  url?: string;
  source?: string;
  imported_at?: string;     // ISO 8601
  imported_by?: string;     // email
  dedupe_key?: string;
}

export interface Decision {
  decision_id: string;      // UUID
  ref_id: string;
  reviewer_id: string;      // email
  decision: 'include' | 'exclude' | 'maybe';
  reason?: string;          // exclude時必須
  // labels?: string[];     // 廃止 (互換性のため残存するが使用しない)
  note?: string;
  decided_at: string;       // ISO 8601
  client_version?: string;
  source_url?: string;
}

export interface ReviewerState {
  email: string;
  spreadsheetId: string;
  lastSyncedAt?: string;
  offlineQueue: Decision[];
}

export type DecisionStatus = 'pending' | 'include' | 'exclude' | 'maybe';

export interface ReferenceWithStatus extends Reference {
  myDecision?: Decision;
  status: DecisionStatus;
}
```

## API設計

### Google Sheets API 使用方法

```typescript
// 読み取り
GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}

// 追記（判定記録）
POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append
```

### 判定保存フロー

判定種別によって分岐する（`src/lib/sheets-api.ts` の `saveDecisionInner`）。human判定・ML手動確認判定は
追記専用（既存行の検索・読み取りをしない）、ML自動判定・LLM判定は従来どおりの upsert。

```typescript
async function saveDecision(decision: Decision): Promise<void> {
  if (isHumanDecision(decision.client_version) || isConfirmedMlDecision(decision.client_version)) {
    // human判定・ML手動確認判定は追記専用: 既存行を探さず常にappendする
    await sheetsApi.values.append({
      spreadsheetId,
      range: 'Decisions!A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [decisionToRow(decision)] } // labelsは空文字で保存
    });
    return;
  }

  // ML自動判定・LLM判定（pending→confirmの行更新やdeleteFulltextAiRoundのため）は従来どおりupsert
  const existingRow = await findDecisionRow(decision.ref_id, decision.reviewer_id, decision.screening_phase);
  if (existingRow) {
    await sheetsApi.values.update({
      spreadsheetId,
      range: `Decisions!A${existingRow.rowIndex}:K${existingRow.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [decisionToRow(decision)] }
    });
  } else {
    await sheetsApi.values.append({
      spreadsheetId,
      range: 'Decisions!A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [decisionToRow(decision)] }
    });
  }
}
```

### 運用フロー要約

- **保存**: human判定・ML手動確認判定は既存行を探さず常に `append`。ML自動判定・LLM判定は同一 `ref_id` + `reviewer_id` + `screening_phase` の既存行があれば `update`、なければ `append`
- **参照**: `ref_id` + `reviewer_id` + `screening_phase` ごとに複数行が存在しうる。読み取り側は `decided_at` が最新の行（同値ならシート上で後の行）だけへ畳み込んで有効な判定とする（実装は `collapseToLatestDecisions`）
- **整合性**: 過去の行は判定変更の履歴として保持する（合議前後の κ 算出に利用できる。次項参照）

### κ（Cohen's kappa）の算出手順

Decisionsタブの追記専用化（2026-08）により、human判定の変更履歴がシートに残るようになった。これを使って
「合議前（各レビュアーの独立した初回判定）」と「合議後（最終判定）」の一致度（Cohen's κ）を後日算出できる。

- **Decisionsタブを CSV でダウンロードすると、追記順＝シートの行順で全履歴が得られる**（Google スプレッドシートの
  ファイル > ダウンロード > カンマ区切り値）
- `revision`（同一キー内の連番）と `is_latest`（最終行フラグ）はシートに保存していない。**ダウンロード後に自分で
  導出する**（理由は本項末尾を参照）
- **`revision == 1` の行 = 各レビュアーの独立した初回判定 → 合議前の κ**
- **各キーの最終行（`is_latest`）= 最終判定 → 合議後の κ**
- 特定の合議・会議より前後で区切りたい場合は `decided_at` で絞り込む（例: 会議日時より前の最終行を「合議前」、
  会議日時以降を含む最終行を「合議後」とする、など運用に合わせて調整する）

R での算出例（`client_version` に `-human` を含む行のみを対象にし、`screening_phase` が空または `tiab` の行
＝TiAbスクリーニングの判定に絞り、`(ref_id, reviewer_id)` ごとに `decided_at` 昇順で並べて連番を振る）:

```r
library(dplyr)
library(tidyr)
library(irr) # kappa2()

decisions <- read.csv("Decisions.csv", stringsAsFactors = FALSE) %>%
  # human判定のみ（ML/LLMを除く）。'0.1.0' は追記専用化より前の旧形式で、これも human 判定。
  # 旧プロジェクトでは初回判定が '0.1.0' で記録されているため、除外すると revision == 1 が
  # 「後の変更」を初回判定と誤認し、合議前のκが狂う（実装は isHumanDecision と対応させること）
  filter(grepl("-human", client_version) | client_version == "0.1.0") %>%
  filter(screening_phase == "" | is.na(screening_phase) | screening_phase == "tiab") %>%
  arrange(ref_id, reviewer_id, decided_at) %>%
  group_by(ref_id, reviewer_id) %>%
  mutate(
    revision = row_number(),          # 同一キー内の連番（1 = 初回判定）
    is_latest = row_number() == n()   # 最終行フラグ（= 最終判定）
  ) %>%
  ungroup()

# 合議前のκ: 各レビュアーの初回判定を横持ちにしてkappa2へ渡す（2名レビュアー想定）
pre_consensus <- decisions %>%
  filter(revision == 1) %>%
  select(ref_id, reviewer_id, decision) %>%
  pivot_wider(names_from = reviewer_id, values_from = decision) %>%
  select(-ref_id)
kappa2(pre_consensus)

# 合議後のκ: 各キーの最終判定を横持ちにする
post_consensus <- decisions %>%
  filter(is_latest) %>%
  select(ref_id, reviewer_id, decision) %>%
  pivot_wider(names_from = reviewer_id, values_from = decision) %>%
  select(-ref_id)
kappa2(post_consensus)
```

**アプリ内のエクスポート機能として実装していない理由**: (1) Decisionsタブを直接CSVダウンロードすれば十分で、
アプリ側に追加実装するほどの価値が薄いため。(2) 保存のたびに `revision` / `is_latest` のような連番をシート側へ
書き込もうとすると、そのために既存行の読み取りが必要になり、追記専用化で実現した「保存時は読み取り0回」という
設計（`decisionRowCache` / `decisionContentCache`）が崩れてしまうため。

### OAuth スコープ

```
# ユーザー情報取得（reviewer_id 用）
https://www.googleapis.com/auth/userinfo.email

# Drive/Pickers と、アプリが作成またはユーザーがPickerで選択したスプレッドシートの読み書き（必須）
https://www.googleapis.com/auth/drive.file
```

> **Note**:
>
> - スプレッドシート新規作成と読み書きは、`drive.file` によりアプリ作成・Picker選択済みファイルに限定して行う。
> - Google Drive上のファイル選択UIは Picker/Drive API と `drive.file` が必須。

#### `drive.file` の 403/404 は「無い」ではなく「このユーザーに未付与」（重要）

`drive.file` の付与単位は **「アプリ × ユーザー × ファイル」**。付与経路は次の3つだけで、**Drive の共有（オーナー/編集者/閲覧者）は付与経路に含まれない**。

1. そのユーザーがアプリ経由で作成した
2. そのユーザーが Google Picker で選択した（アプリの appId 付き）
3. Drive UI の「アプリで開く」から開いた

したがって複数人プロジェクトでは、**PDF をアップロードした本人以外が、そのPDFやフォルダを GET すると 403/404 になる**。判定条件は「実行者 ≠ アップロード者」だけで、オーナーかどうかは無関係（オーナーが共同研究者のアップロードしたPDFを読む場合も同じく404）。

**Drive API の 403/404 を「存在しない」と解釈して作り直し・再セットアップに進んではならない。** 過去に `folderExists()` が 404 を `false` に潰していたため、共同研究者の操作でフォルダが二重作成され、`moveFileToFolder()` が**オーナーのスプレッドシート本体を別の人の Drive へ移動**し、Config のフォルダIDが両者の間でピンポンする不具合があった（PR #61 で修正）。

Drive アクセスを扱うコードでは次を守ること:

- ステータスは `drive-api.ts` の `classifyDriveApiStatus()` / `resolveFolderState()` で分類する。**真偽値に潰さない**（`accessible` / `trashed` / `inaccessible` / `auth-error` / `transient-error`）
- 403/404・401・一時エラー（5xx/429/ネットワーク例外/JSONパース失敗）で**リソースを作り直さない**。確定した答えである `trashed` のみ作り直してよい。**この「作り直してよいのはtrashedだけ」という原則自体は不変**
- ただし `inaccessible`（403/404）を fail-fast するかどうかは呼び出し元によって異なる。**`ensureFulltextFolder()` は inaccessible を fail-fast しない**（下記参照）。それ以外（`setupProjectFolder()` の所有者チェック、`ensureProjectFolder()` など）は従来どおり `DriveAccessDeniedError` を投げて fail-fast する
- `auth-error` / `transient-error` はどこでも従来どおり fail-fast する（状態が判定できないため）。`DriveAuthError` / `DriveTransientError` を投げ、UI 文言は `describeDriveAccessError()` 経由で `messages.json` から取る（エラークラスのデフォルトメッセージは内部ログ用の英語。UI文言をハードコードしない）
- `setupProjectFolder()` は `ownedByMe` を確認してからでないとスプレッドシートを移動しない。Config にフォルダIDを持たないレガシープロジェクトでも同じ破壊が起きうるため
- `getProjectDriveFolderId()` / `getFulltextDriveFolderId()` は Config タブが本当に無い場合だけ `null` を返す。アクセス拒否・一時エラーを `null`（＝未設定）に潰さない

**`ensureFulltextFolder()` は inaccessible(403/404) で fail-fast しない（2026-08-08 変更）**。共同研究者にとって他人が作った fulltext フォルダは常に inaccessible であり、これは異常ではなく正常な状態。実測（下記）でアップロードに親フォルダへの `drive.file` 付与は不要と確定したため、Config に保存済みのフォルダIDをそのまま返して使う。`auth-error` / `transient-error` は「状態が判定できない」ため引き続き fail-fast する。既知のトレードオフとして、404 は「このユーザーに未付与」と「本当に削除済み」を区別できない。後者では従来 `DriveAccessDeniedError` で分かりやすく止まっていたが、今後はアップロード実行時に Drive 側のエラーで失敗する形になる。未付与のケースが圧倒的多数であり、かつそれを救えないと共同研究者のアップロード機能自体が成立しないため、このトレードオフを受け入れる。

#### 実測で確定した挙動（2026-08-08。再検証不要）

`scripts/drive-file-probe/` の実測ハーネスで確定した。**Google の公式ドキュメントには一切記載が無いので、調べ直しても出てこない。**

- **Picker でフォルダを選択しても、付与は配下ファイルへ一切カスケードしない。** 選択時点で既にフォルダ内にあったファイルすら 404 のまま（スナップショット型ですらない）。伝播遅延も無い
- **`files.list` は権限が無くても HTTP 200 + `files: []` を返す**（404 にならない）。**付与の有無を list の HTTP ステータスで判定してはならない**。中身の `files[]` を見ること
- **親フォルダ自体が未付与でも、`files.list` はそのフォルダを親に指定すれば付与済みの子ファイルを返す。** これが「このユーザーが実際に読めるファイル」を知る唯一の経路（`listAccessibleFileIdsInFolder()`）
- 付与済みフォルダに対しても `files.list` は 0件を返すため、**「読めないファイル」を Drive 側から列挙する経路は存在しない**。列挙は References シートの `fulltext_url` から行うこと
- **`drive.file` 未付与のフォルダでも、`files.create` の `parents` にそのフォルダIDを指定すればファイルを新規作成できる（HTTP 200）。指定した親も尊重される**（マイドライブ直下へ逃げたりしない）。自己所有フォルダ・他人所有＋共有フォルダの両方で確認済み（`scripts/drive-file-probe/`、PR #66）
- **`files.copy`（`POST /files/{id}/copy`）でも同じで、`drive.file` 未付与のフォルダを `parents` に指定して複製でき、指定した親も尊重される。** コピー元は Picker で付与済みである必要がある（実フローと同じ前提）。**他人所有＋共有フォルダでのみ実測**（自己所有では未実測）（`scripts/drive-file-probe/`、Issue #68 / PR #70）
- **子ファイルを作成しても、親フォルダ自体には `drive.file` は付与されない**（作成後も親フォルダの `files.get` は404のまま。複製でも同じことを確認した）

#### 読めなくなった PDF の復旧（対策 C'）

上記の帰結として、フォルダ単位での一括付与は成立しない。代わりに **Picker の複数選択で1セッションにまとめて再付与する**（`fulltext-regrant.ts`）。Picker の一覧表示は `drive.file` ではなく**ユーザー自身の Drive 権限**を使うため、fulltext フォルダに Drive 共有さえされていれば、共同研究者にも他人がアップロードした PDF が見えて選択できる（＝ Drive 共有は付与経路ではないが、Picker で選ぶための前提にはなる）。

- 検知は `listAccessibleFileIdsInFolder()` と References の `cached` 行の突き合わせ（`fulltext-access.ts`）
- Picker ページ側は `mode=regrant`。選択ファイルの一覧ではなく**件数だけ**を返す（数百件選択時に URL フラグメントが肥大するのを避けるため。付与は「選択」を押した時点でサーバー側に確定しており、一覧を受け取る必要が無い）
- 真値は必ず再度の `files.list` で取り直す。Picker の戻り値を「読めるようになった証拠」として扱わないこと

> 関連: `isUserAdmin()`（`sheets-api.ts`）は role が **owner または writer** で `true` を返す。共同研究者は編集者として招待されるため、**`isAdmin` ではオーナーと共同研究者を区別できない**。オーナー限定の分岐が必要な場合は別の識別子を用意すること。

### OAuth フロー: なぜ implicit なのか（変更禁止・調査済み）

拡張版は `chrome.identity.launchWebAuthFlow` + **implicit フロー（`response_type=token`）** を使う。GCPダッシュボードに「安全なフローの使用」警告が出るが、**これは現状で唯一成立する選択肢であり、認可コード + PKCE への移行は Google 側の制約で不可能**。2026-07-16 に実機検証済み（Issue #26）。同じ検討を蒸し返さないこと。

| クライアント種別 | launchWebAuthFlow + chromiumapp.org | 認可コード + PKCE（secret無し） |
|---|---|---|
| ウェブアプリケーション型（現用） | ✅ 動作 | ❌ 400 `client_secret is missing` |
| Chrome 拡張機能型 | ❌ 400 `redirect_uri_mismatch` | 到達せず |

- **`launchWebAuthFlow` では Google は「implicit（secret 不要）」か「認可コード + client_secret」の二択しか提供しない。**
- Chrome 拡張機能型クライアントは**リダイレクトURIの登録欄が無く `getAuthToken` 専用**。`getAuthToken` には戻れない（プロファイルのアカウントに束縛され、大学・病院の Workspace ユーザーが組織ポリシーでハードブロックされる。これが #23 で launchWebAuthFlow へ移行した理由）。
- 却下した代替案: ①secret 埋め込み（ウェブアプリ型の secret は confidential。配布物から抽出可能で PKCE の意味が消える）②バックエンド追加（過剰。トークンを見せることになる）③デスクトップアプリ型（正規リダイレクトはループバックのみ。拡張は listen 不可）④TV/限定入力デバイスフロー（ポーリングに client_secret が必要 + プラットフォーム誤分類）⑤GitHub Pages + GIS（`initCodeClient` はバックエンド前提で同じ壁。`initTokenClient` は Google 自身が implicit と明記しており、かつトークンがページ側 JS に露出して現状より悪化）。
- 実在の OSS 拡張（[Stylebot](https://github.com/ankit/stylebot/blob/b848edf8955eb6784571553cffd1061ea486acc2/src/sync/google-drive/get-access-token.ts) の Drive 同期）も、Web client + `response_type=token` + `drive.file` と同一構成。
- **セキュリティ上の評価**: `https://<拡張ID>.chromiumapp.org/` は Chrome が横取りし、ページとしてロードされない。したがって implicit の主なリスク（履歴・Referer・サーバログへのトークン漏えい）は成立しない。access_token は `chrome.storage.session`（ディスク非永続）のみに保持する。
- Google は `response_type=token` の停止時期を告知していない（2026-07 時点。廃止告知が出ているのは旧 Google Sign-In JS ライブラリで、Google は OAuth 2.0 の認可自体には影響しないと明記）。**実際に停止された場合は上記①②③の三択を迫られる**ため、その時点で再評価する。
- 実装のみ完成済みで使えない PKCE 版: ブランチ `feat/oauth-pkce-code-flow` / PR #31（マージ不可）。

## 開発ワークフロー

1. `npm install` - 依存関係インストール
2. `.env.example` を `.env` にコピーし、`WEBAUTH_CLIENT_ID`（拡張版 launchWebAuthFlow 用、dev/store共通）を設定
3. `npm run dev` - 開発ビルド（`key` 保持。`WEBAUTH_CLIENT_ID` 未設定だと本番と同様に fail-fast する。認証を触らないローカル作業では `ALLOW_NO_AUTH=1 npm run dev` で警告のみに格下げできる）
4. `chrome://extensions` で「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダ選択
5. 開発中は `npm run watch` でホットリロード
6. リリースは `npm run release`（バージョンバンプ + ストア用ビルド + `dist.zip` 作成）。機能追加時は `npm run release:major`

### リリース（Chrome Web Store）

正式リリース済み（2026-07〜）のため、**リリースビルドは常にストア用**。zip を Google Drive で配布する経路は廃止した（最後の zip 配布は v0.24.0）。

バージョンは `0.<major>.<minor>` 形式（先頭の 0 は固定）。

```bash
npm run release         # = release:minor（デフォルト）
npm run release:minor   # 修正・小変更 0.33.2 → 0.33.3 + ストア用ビルド + dist.zip
npm run release:major   # 機能追加     0.33.2 → 0.34.0 + 同上
```

1.0.0 など先頭の数字を動かす場合のみ `./scripts/bump-version.ps1 -SetVersion "1.0.0"` で明示指定する。

生成された **`dist.zip`** を Chrome Web Store デベロッパーダッシュボードへアップロードする。**ファイル名は `dist.zip` 固定**（バージョン付きの名前ではアップロードできない）。ストア用ビルドは manifest の `key` を削除し（ストアがID `alejln…` を付与）、OAuth クライアントID (`.env` の `WEBAUTH_CLIENT_ID`) は webpack DefinePlugin 経由でコードに埋め込む（manifest には含めない）。

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

**CI ゲート**: `.github/workflows/build-check.yml` が PR ごとに次の5つを実行し、どれかが落ちるとマージ不可になる。ローカルでも同じ5つを通してから PR を出すこと。CI には `.env` が無いため、`npm run dev` / `npm run dev:web` の2ステップだけ `ALLOW_NO_AUTH=1` を指定してビルド疎通確認に限定している（`.env` があるローカルでは不要）。

```bash
npm run typecheck && npm run lint && npm run test
ALLOW_NO_AUTH=1 npm run dev && ALLOW_NO_AUTH=1 npm run dev:web
```

### テスト・作業ツリーの落とし穴

- **`tests/tsconfig.json` の `types` は明示列挙**（`node` / `chrome` / `google.accounts`）。新しい ambient 型に依存するテストを足すと `Cannot find namespace` で `npm run test` が落ちるので、型の追加もセットで行うこと。`include` も明示列挙だが、テストから import したモジュールは推移的に取り込まれるため、通常は `types` 側だけが問題になる。
- **`.gitignore` の `node_modules/` は末尾スラッシュ付きでディレクトリにしかマッチしない。** `git worktree` を作って `node_modules` をシンボリックリンクで共有すると untracked のまま残り、`git add -A` でコミットへ混入する。worktree で作業するときは変更ファイルをパス指定でステージすること。

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
