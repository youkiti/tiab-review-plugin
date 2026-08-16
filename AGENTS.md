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
| reviewer_id     | 判定者（email）。ただしフルテキストの裁定票は `adjudication:{email}` という特別な形式を使う（下記「フルテキストの不一致解消（裁定）」参照） | ✓   |
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

### フルテキストの不一致解消（裁定）

判定者間の不一致（判定不一致・理由不一致）を、判定後レビュー画面の「不一致の解消」セクションから
その場で確定できる（`src/sidepanel/features/fulltext-results.ts` の `renderConflicts` /
`buildConflictItem` / `handleAdjudicate`）。**`state.isKeyOpened === true`（キー開封後）のときだけ表示**する。
ブラインド中は他レビュアーの人間票がそもそもクライアントに配られない（`filterDecisionsForBlind`）ため、
不一致の検出自体が成立しないため。

**合議計算は純関数に集約**: OR合議・不一致検出・裁定の反映は `src/lib/fulltext-consensus.ts` の
`computeFulltextConsensus()` に切り出している。`fulltext-results.ts` は DOM/state に依存する層のため
テストできない。純関数側のテストは `tests/fulltext-consensus.test.ts`。

- `conflict`: 非pendingの判定値（include/exclude/maybe）が2種類以上（従来どおりの「判定不一致」）
- `reasonConflict`: 全員 exclude で有効な除外理由が2種類以上（`hasExcludeReasonConflict` を使う）。
  判定自体は一致していても理由が割れているケースを判定不一致とは別枠で検出する
- `unresolved`: `(conflict || reasonConflict) && !adjudicated`。裁定票があれば、生の不一致（`conflict`/
  `reasonConflict`）自体は残っていても「解消済み」として扱う

**裁定票の仕様**（Decisions タブへ1行追記する）:

- `reviewer_id = 'adjudication:{email}'`（`adjudicationReviewerId()`）。裁定は誰でも可能なため
  複数人が裁定でき、誰がいつ裁定したかは行として記録に残る
- `screening_phase = 'fulltext'`
- `decision` / `reason` は裁定で確定した最終判定・除外理由
- `note` に JSON（`FulltextAdjudicationNote` 型、`src/lib/types.ts`）でスナップショットを保存する:
  `type: 'fulltext_adjudication'`、`adjudicated_by`（裁定者email）、`adjudicated_at`（ISO 8601）、
  `votes`（裁定時点の各判定者の判定・理由・メモの配列）
- **`client_version` は `getClientVersion('-human-adjudication')` を使うこと。**
  `isHumanDecision()`（`client-version.ts`）は `clientVersion.includes('-human')` で判定するため、
  このサフィックスなら `saveDecision` の追記専用（append-only）経路に乗り、裁定のやり直し（再確定）が
  別行として履歴に残る。`-human` を含まないサフィックス（例えば `-adjudication` 単体）にすると
  upsert 経路に落ち、過去の裁定が上書きされて履歴が消えるため使わないこと
- 裁定票が複数（同一裁定者の再確定、または別の裁定者による裁定）存在する場合、
  `computeFulltextConsensus()` は `decided_at` が最新のものを最終として採用する

**裁定票は判定者選択（judge selector）のチェックボックス一覧に出さない。**
`collectJudges()`（`fulltext-results.ts`）が `isAdjudicationKey()` で除外している。
判定者選択に出てしまうと、チェックを外した瞬間に裁定票が合議計算から消えて裁定そのものが
無効化されてしまうため。

`getReviewerLabel()`（`src/sidepanel/features/screening/reviewer-utils.ts`、TiAb画面とも共有される関数）は
`adjudication:` キーを「⚖ 裁定（email）」と表示する分岐を持つ。既存の `llm:` / `ml:` 分岐の挙動は変えていない。

**「完了が見える」導線**: PRISMA集計・エクスポート前確認は生の `conflict` ではなく
**未解消の不一致件数**（`unresolved`）を基準にする。全て裁定済みなら警告を出さない。
CSVエクスポートには `conflict` / `reason_conflict` / `adjudicated` / `adjudicated_by` 列を追加している。

#### Config タブ（プロジェクト設定）

- **include_keywords**: 組み入れハイライト用キーワード（緑）
- **exclude_keywords**: 除外ハイライト用キーワード（赤）
- **fulltext_pool_rule**: フルテキスト候補ルール（JSON: `{version, voters, threshold}`）。採用する判定者（voter: `human:{email}` / `ml:{email}` / `llm:{...}`）の TiAb Include 票が `threshold` 以上の文献を候補とする。キー開封後にフルテキストページから設定。未設定時は、管理ユーザーは読み込まれている全レビュアーの TiAb Include が1件でもある文献を候補とし、非管理ユーザーは既存の割り振りで見える文献のうち自分が TiAb Include した文献だけを候補とする。
  - **候補計算を判定票に依存させるとBlindで壊れる（2026-08 実事故）**: Blind中（key_opened=FALSE）は他人の human 票がクライアントへ配られないため、human voter を含むルールは自分以外のメンバーには常に0票＝候補0件と評価される。このため候補判定は `src/lib/fulltext-candidates.ts` に集約し、**担当割り振り設定済みの場合は References の `fulltext_set` 列（判定票非依存）を候補の一次ソース**にしている。候補系のロジックを触るときは必ずこのモジュールを経由し、`isInFulltextPool` を直接呼ぶ実装を新設しないこと。なお `mountRuleEditor` はキー未開封ではフォームを描画しないため、「キー未開封で保存」経路のガードは実質通らない。実際の事故経路は「開封してルール保存 → Blindへ戻す」で、警告は `handleKeyToggle` の CLOSE 側にある。
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
     - フルテキストの分母: `fulltext_pool_rule` または担当割り振り（`fulltext_assignment_*`）が設定済みの場合に共通候補プール数
       （割り振り済みは `fulltext_set` 非空 ∪ ルール成立の和。ユーザー非依存の `isSharedFulltextPoolMember` で算出）。
       どちらも未設定時は「—」
     - 進捗にカウントする判定: 人間判定＋確定ML判定（LLM判定・ML自動判定・メモのみの pending 行は除外）
     - 3日以上判定がなく残作業があるメンバーに ⚠ を表示
     - データは Decisions タブから読み込み時に非同期取得し、🔄ボタンで再取得。自分の判定保存は即時反映
       （フルテキストページ＝別タブでの保存も `chrome.runtime.sendMessage`（`team-progress:decision-saved`）で
       サイドパネルへ通知され即時反映。他メンバーの判定の反映は🔄再取得）
     - メンバーが1人だけのプロジェクトでは表示しない
7. **LLMスクリーニング支援**

   - **APIキー設定**: Gemini / OpenRouter APIキーの保存・管理 (provider 別に独立保管)
   - **Gemini APIキーの無料/有料判定**（`detectTierByBatchProbe()` / `classifyTierProbeResponse()`, `src/lib/gemini-api.ts`）:
     `batchGenerateContent` に requests が空の batch を送るプローブで判定する（1リクエスト・課金ゼロ、バッチジョブは作られない）。
     `400 FAILED_PRECONDITION` → free（課金チェックが body 検証より先に走る）、
     `400 INVALID_ARGUMENT` + message に "inlined requests"/"input file" → paid（body 検証まで進む）。
     一過性の失敗（タイムアウト・想定外レスポンス等）は必ず `unknown`（安全側の free 扱い）に倒し、`paid` と誤断定しない。
     **`models.list` のモデル件数では判定できない**（無料キーでも50件前後返るため実測で無効。旧実装の「5件以下=無料」分岐は
     事実上「常に有料」と誤判定していた）。集合差分・レスポンスヘッダ・`cachedContents.create` 等も実測で否定済み
     （詳細: `experiments/gemini-tier-detection/report.md`）。蒸し返さないこと。
   - **Tier 1/2/3 の自動判定は原理的に不可能**（APIキーだけで Tier を返す公式エンドポイントが無く、
     Cloud Billing 等は OAuth + IAM が必須）。手動選択（`ManualTier` セレクタ）に頼るしかない。
     自動判定（free/paid）は保存済みの手動設定が無い場合の**初期値の提案**にすぎない
   - **429 の `quotaId` に含まれる `FreeTier` を tier のロックに使ってはいけない**。有料 Tier 2/3 の
     プロジェクトが FreeTier バケットへルーティングされて 429 になる報告があり、これで tier を固定すると
     有料ユーザーを無料に縛ってしまう。`isFreeTierQuota`（PR #87 の 429 適応スロットリング）は**減速の根拠にのみ**使う
   - この判定器は公式APIの仕様ではなく entitlement チェックの実行順序という副作用を観測しているため、
     Google が将来 Batch API を無料枠に開放すると「全キーを paid と誤判定する」方向に壊れるリスクがある。
     そのため PR #87 の 429 適応スロットリングを安全網として併設している
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
     - **対象の限定**: 既定は従来どおり全件（`state.references`）。人間がお試しスクリーニングした集合と
       同じものをAIに判定させたいという要望（2026-08）に応えるため、担当セット単位＋個別チェックボックスで
       対象 ref_id を限定できる。対象決定の純粋ロジックは `src/lib/llm-target-selection.ts`、
       UIは `src/sidepanel/features/llm/target-picker.ts`
     - **選択は config_hash に含めない**。含めると対象を変えるたびに別Runが生まれ、「中断からの再開」
       「新規にやり直す」が壊れるため。同じ設定なら対象を絞っても同じRunの続きとして扱われる
     - **選択モードでは実行上限（10/50/100/500/すべて）を無視**して選んだ分を全部投げる。
       「100件選んだのに上限50で切られた」という事故を防ぐため。UI側では上限セレクトをdisabledにする
     - **選択は Config シートに保存**（`llm_target_mode` / `llm_target_ref_ids`）。チームで同じ対象集合を
       再現できるようにするため。ref_id は UUID なので1セル5万字上限から約1,350件が物理上限で、
       余裕を見て**1,000件で頭打ち**（`LLM_TARGET_REF_ID_LIMIT`）
     - **`updateLlmConfig` は複数キーを渡しても「1回の書き込み」にはならない**。`tryUpdateLlmConfig`
       （`sheets-api.ts`）は updates を `Object.entries()` で回し、**キー1個につき1回 `updateRange` を
       逐次実行する**。途中で失敗すると中途半端な状態がシートに残るため、`llm_target_mode` と
       `llm_target_ref_ids` のように意味が結びついた2キーは、**失敗しても安全側（＝従来どおり全件対象）へ
       倒れる順序**で1件ずつ書くこと。順序は方向で変わる（絞り込む `selection` 方向は ref_ids → mode、
       全件へ戻す `all` 方向は mode → ref_ids）。順序決定は `buildTargetConfigUpdates`
       （`llm-target-selection.ts`）に集約してテストしている。オブジェクトリテラルのキー順に暗黙で
       依存する書き方はしないこと
     - **保存に失敗したら state を保存前の値へ巻き戻す**。`switchToTab('llm')` は毎回
       `initializeLlmSection()` を呼んでシートから設定を読み直すため、state だけ新しい値のまま残すと
       タブを往復しただけで表示が黙って戻る（トーストは既に消えている）
     - **実行履歴に対象を記録**: `LLM_Executions` の `target_mode` / `target_sets` / `target_selected_count`。
       後から「この Run は calibration の50件を対象にした」と論文に書けるようにするため
     - **非管理者の `state.references` は担当セットで絞られている**ため、他人の担当分の ref_id が選択に
       含まれていても対象から落ちる。件数の内訳（見つからない件数・この Run で判定済みの件数）をUIに出して
       0件表示の理由を追えるようにしている
     - Blind 中は他レビュアーの判定がクライアントに配られないため、モーダルの判定状態表示は自分の判定のみ。
       **判定状態は表示専用で、選択の絞り込み条件には使っていない**
   - **結果表示**: LLMの判定結果・理由の表示
8. **フルテキストAI判定（PDF全文）**

   - **プロバイダ**: Gemini のみ（スキャン画像PDFもネイティブにOCR/読解。`gemini-fulltext.ts`）
   - **UI**: フルテキストタブを3分割（候補リスト / **AI判定** / 判定後レビュー）。AI判定タブは**一括処理専用**
   - **対象**: `fulltext_status='cached'`（Drive保存済み）かつ採用ラウンドで未AI判定の候補。PDFを inline_data で丸ごと送信。
     対象決定ロジックは `src/lib/fulltext-ai-target.ts`（純粋関数）に集約する
     - **対象範囲の既定はプロジェクト全体**（`scope='project'` = `getProjectFulltextCandidateList()`）。
       AIは人間とは独立した判定者なので、人間側の分業（フルテキスト担当割り振り・担当セット絞り込み）では対象を狭めない。
       管理者が自分では読まない文献も含めて一括AI判定できる必要がある（2026-08 の要望）。
       「自分の担当分のみ」（従来の `getVisibleFulltextCandidateList()` 基準）はラジオで選べる
     - **「AI判定済みか」は Decisions タブを読んで判定する**（`collectAiJudgedRefIds`）。
       Blind 中（key_opened=FALSE）は `ReferenceWithStatus.allFulltextDecisions` が空になるため、
       参照側の票から導くと常に「未判定」に見え、同じPDFを何度も課金して判定してしまう
     - 除外に使うのは**採用ラウンド**（Config `fulltext_ai_active_round`）のみ。採用ラウンドが無ければ除外しない
       （別モデルでラウンドをもう1本作れる）。件数表示には「判定済みのため除外: N件」を併記し、0件表示の理由を追えるようにする
     - **実行直前（`handleStartAiBatch`）は Decisions を読み直してサーバーの真値で対象を確定する**。
       TiAb バッチ（`getJudgedRefIdsForBatches`）と同じ理由で、他レビュアーが直前に実行した分を取りこぼさないため
   - **保存**: AIは独立した判定者として確定保存（`reviewer_id='llm:{model}@{timestamp}'`, `screening_phase='fulltext'`）。
     `note` に `FulltextLlmDecisionNote`(JSON: decision根拠 evidence[quote/page/bbox] 等) を格納
   - **PDFハイライト**（`fulltext.html` + `pdf-renderer.ts`）: cached PDF を PDF.js でテキストレイヤー付き描画し、
     evidence を **経路A: quote文字列マッチ → 経路B: 正規化bbox → ページ送り** の順で段階的にハイライト。
     スキャン画像PDFはテキストレイヤーが無いため bbox（AIの領域推定）を使う旨をUIに明示
   - **依存**: `pdfjs-dist`（worker/cmaps/standard_fonts を dist 直下へ同梱）。
     manifest に `content_security_policy.extension_pages`（`wasm-unsafe-eval`）を追加
   - **TiAbのAIラウンドとは別枠**: 全文閲覧ウィンドウのハイライトは `screening_phase='fulltext'` の
     `llm:` 判定のうち**採用ラウンド**（Config `fulltext_ai_active_round`）のものだけを使う。
     TiAb のAIラウンドは evidence が抄録の文字オフセットでPDF座標に落とせないため、
     `note.type === 'llm_fulltext'` でも弾かれる。「AI判定なら2つある」と混同されやすいので、
     UI文言では必ず「フルテキストAI判定」と書き分けること
   - **evidence が0件のときの文言**（`src/lib/ai-evidence-empty-reason.ts`）: 未実行 / 未採用 /
     採用ラウンド消失 / この文献に根拠なし を切り分け、UIから辿れる導線を案内する。
     Config の生キー名をユーザー向け文言に出さないこと（UIから編集できないため誤誘導になる。2026-08 実事故）。
     ただし表示レベル `none`（AI evidence 非表示の実験条件）では、理由で文言を変えると
     「この文献にAI判定があるか」が漏れるため、必ず既定文言に固定する
9. **論文用テキスト生成**（`manuscript.ts`）

   - TiAb エクスポートメニューとフルテキスト結果ビューから、Methods / Results / PRISMA 2020 フロー数値の英語下書きをモーダル表示し、セクションごとにコピー可能
   - 数値は `import_stats`・判定データ・判定者選択から自動挿入。ツールが持たない情報（不一致の解消方法など）は `[ ]` で残す
   - 未判定・保留・不一致が残る場合や、インポート統計のないファイル（重複除去後の件数に `*` 付与）は警告を表示
   - PRISMA の数値・論文用テキスト・CSV/RIS エクスポートはログインユーザーに依存させず `getProjectFulltextCandidateList()`（`state.allReferences` 基準）でプロジェクト全体を集計する。候補一覧・入手状況・一括OA検索は「自分が読む対象」なので担当割り振り込みの `getVisibleFulltextCandidateList()` / 割り振りのみの `getFulltextCandidateList()` を使い分けてよいが、非管理者の `state.references` はTiAb担当セットで絞られているため論文用集計には使わない。**フルテキストAI一括判定は「人間が読む対象」ではないので既定でプロジェクト全体**（機能要件8参照）
   - `state.allReferences` を見る画面を足したら、判定後に references を再読込する処理（`fulltext-ai.ts` の `reloadReferences` など）でも `state.setAllReferences()` を呼ぶこと。`syncSetReferences()` だけだと絞り込み前の全文献が古いままになる

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
- **フルテキストの除外理由（PRISMA区分）は並び順そのものが優先順位**。複数当てはまる場合は番号の小さい理由を選ぶ。
  理由が判定者間で割れると裁定（不一致解消）の手間が発生するため、割れにくくする規則として運用する
  - 並び・ラベル（UI用の日本語／論文用の英語）の唯一の定義は `src/lib/exclude-reasons.ts`。
    `fulltext.html` の `<select>` だけは DOM 側の定義なので、順序と value を手で一致させること
  - 集計の代表理由は `pickPrimaryExcludeReason()` が最小番号を採る。
    以前は「最初に見つかった非空の理由」で**判定者の列挙順に依存**していた（誰が先に判定したかでPRISMAの内訳が動いていた）
  - フルテキストAI判定のプロンプトにも同じ規則を入れている（`gemini-fulltext.ts`）。
    AI票も判定者として合議に入るため、揃えないとAI票が理由不一致を量産する

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

#### 共有ドライブ（Shared drives）で実測して確定した挙動（2026-08-15）

Issue #80 のフェーズ0として `scripts/drive-file-probe/` の `shared-drive-*` シナリオで実測した。測定は Google Workspace の共有ドライブ上に Drive UI で手作業に作ったフィクスチャに対し、そのドライブのメンバーとして実施した。

**「再検証不要」なのは下記「Drive API v3 のパラメータ要否」だけ**。これは Drive API の仕様なので確定扱いでよい。**Picker の節は UI の挙動であり、Google 側の変更を受けるうえ本番と同じ構成では測っていない**（後述）ので、前提として使うときは実機で確かめること。

生の測定レポートは実行した端末の `scripts/drive-file-probe/output/2026-08-15T06-*` にあり、`output/` は `.gitignore` 済みのためリポジトリには入っていない。**再現したい場合はレポートを探すのではなく、`scripts/drive-file-probe/README.md` の手順でシナリオを実行し直すこと**（フィクスチャの作り方も README にある）。

**Drive API v3 のパラメータ要否（付与済みのファイル・フォルダに対して）**

| API | `supportsAllDrives`（list は `includeItemsFromAllDrives` も） | 付けなかったときの失敗の仕方 |
| --- | --- | --- |
| `files.get`（メタデータ） | **必須** | 404 `notFound` |
| `files.list` | **必須** | **HTTP 200 + 0件**（silent） |
| `files.create` | **必須** | 404 `File not found: <folderId>` |
| `files.copy` | **必須** | 404 同上 |
| `alt=media`（実体取得） | **不要** | — |

- **`alt=media` だけが例外。** 付与さえあればパラメータ無しで本物の PDF が返る（`application/pdf`、先頭 `%PDF-`）。**「メタデータは読めないのに実体は読める」という非対称が実在する**ので、`files.get` の成否で `alt=media` の可否を推定してはならない。**ただし「不要」であって「付けてはいけない」ではない**（同じ測定で `alt=media` + `supportsAllDrives` も成功を確認済み）。実装は例外を作らず一律で付ける方針にしている（後述）
- **`files.list` の失敗が最も危険。** パラメータが無いと 200 + 0件を返し、「フォルダが空」と区別がつかない。`listAccessibleFileIdsInFolder()` がこれに乗っているため、パラメータを付けないと共有ドライブでは**常に「読めるファイルは1つも無い」と誤答**する
- **`files.list` は過大報告しない。** パラメータを付けた場合、返るのは付与済みのファイルだけ。3本入りフォルダで 0本付与→0件、1本付与→1件、と混合状態でも確認済み。マイドライブと同じ意味論で信頼してよい
- **書き込みは既存の性質がそのまま成立する。** パラメータさえ付ければ、`drive.file` 未付与の共有ドライブフォルダを `parents` に指定して `files.create` / `files.copy` できる。`files.get` で取り直した `parents` も指定どおりで、マイドライブ直下へ逃げることはない。書き込みの副作用で親フォルダが付与されることも無い（4回の書き込み後も親は404のまま）
- **`corpora=drive&driveId=` の追加指定は不要。** `supportsAllDrives` + `includeItemsFromAllDrives` だけで共有ドライブ配下に到達する

**Picker の挙動（`setEnableDrives(true)` 無しの状態で測定。フェーズ4の前提となったベースライン）**

**この節だけは本番と同じ構成で測っていない。** 測定ハーネス（`scripts/drive-file-probe/probe.js` の `openPicker`）は `DocsView` 1枚だが、本体（`src/webapp/picker.ts` の `buildDocsViews`）は自分所有ビュー + `setOwnedByMe(false)` の共有アイテムビューの2枚構成で、PDFモードではさらに `setParent(fulltextフォルダ)` を掛けている。`setParent` を掛けた状態で共有ドライブ上のファイルがどう見えるかは**未測定**。

- **共有ドライブへナビゲーションから辿る導線は無い**（左メニューに共有ドライブの項目が出ない）
- **しかし共有ドライブ上のファイルは既定の一覧に直接現れ、選択でき、`drive.file` の付与も成立する。** 選択した ID と対象 ID の機械照合で確認済み。**付与が成立すること自体は Google 側の挙動なので、ビュー構成が違っても変わらない**
- したがって **Issue #80 が前提としていた「Picker に一切出てこないため詰む・迂回策が無い」は誤り**。`setEnableDrives(true)` は必須の修正ではなく、ナビゲーション性の改善である

**実装（フェーズ1で対応済み）**

- **Drive API は `driveFetch()`（`src/lib/drive-shared-drive.ts`）以外から叩かないこと。`fetch()` で直接叩いてはならない。** 共有ドライブ用パラメータと `Authorization` ヘッダをここで必ず付ける。呼び出しごとに要否を判断せず**全経路へ機械的に付ける**方針にしている。`item`（単一リソース）は `supportsAllDrives`、`kind: 'list'`（`files.list`）は `includeItemsFromAllDrives` も付く。マイドライブのファイルには無害なので出し分けはしない。`corpora=drive&driveId=` を足す実装を新設しないこと
  - パラメータ組み立て自体は純粋関数 `withSharedDriveParams()` に分離してある（テスト対象）
  - 認証トークンは呼び出し側から渡す。`drive-shared-drive.ts` が `sheets-api.ts` の `getAuthToken` を import すると循環参照になるため
- 適用先は `src/lib/drive-api.ts` の13箇所と **`src/lib/sheets-api.ts` の5箇所**（`getRecentSpreadsheets` の `files.list`、permissions の list/create/delete、`isUserAdmin` の capabilities）。特に `getRecentSpreadsheets` は `files.list` なので、欠けると**共有ドライブ上のスプレッドシートが一覧から黙って消える**
- **パラメータが落ちても `files.list` 系のテストは緑のまま通る**（200 + 0件のため）。回帰は `tests/drive-shared-drive.test.ts` で検出する。実際に飛ぶ URL を見張るテストに加え、**`drive-api.ts` のソースに `fetch(` の直呼びが残っていないことを機械的に検査**している（新しい経路が `driveFetch` を通さずに増えた瞬間に落ちる）
- **`classifyBlockedReason()`（`src/sidepanel/features/fulltext-drive-import.ts`）の共有ドライブブロックは撤去した。** `getDriveFileMetadata()` の `files.get` に `supportsAllDrives` が無かった間、`meta.driveId` を読む前に 404 で throw していたため到達不能な死んだコードだった（`fulltext_importErrorSharedDrive` は一度も表示されていない）。パラメータを付けた時点でこれが**生きたコードに変わり、実測では読めるはずの共有ドライブ上のPDFを新たに弾き始める**ため、パラメータ付与とセットで消す必要があった
- **共有ドライブ上のPDF → マイドライブの fulltext フォルダへの `files.copy` は未測定**（測ったのは逆向き）。事前にブロックせず、失敗したら copy 本体のエラーをそのまま見せる形にしている
- **共有ドライブ環境では「404 = 未付与」と断定してはならない**（パラメータ欠落でも同じ 404 になる）。全経路にパラメータが付いて初めて 404 が未付与を意味する。ユーザーへの復旧案内（再付与導線）はこの前提の上に設計すること

**実装（フェーズ4: Picker の `setEnableDrives`）**

- `buildDocsViews()`（`src/webapp/picker.ts`）は **`drives=1` がURLフラグメントで渡されたときだけ** `setEnableDrives(true)` を適用する。pdf / regrant / スプレッドシートの3モードすべてが同じ経路を通る
- **ページ側で無条件に有効化してはならない。** Pickerページは GitHub Pages（`docs/app/`）から配信されており、拡張機能とはロールアウトが独立している。配信物を差し替えた瞬間、**旧バージョンの拡張機能を使っている全ユーザーにも反映される**。フラグメントでゲートしておけば配信順序に依存せず、ロールバックも拡張機能のビルド側で完結する
- フラグ名とゲート判定は `src/lib/picker-url.ts`（`PICKER_DRIVES_PARAM` / `isSharedDrivesRequested()`）に集約し、`tests/picker-url.test.ts` で固定している。**`'1'` 以外は全て無効に倒す**（`null` = フラグを渡さない旧拡張機能を有効側に倒さないため）
- `setEnableDrives(true)` は**2枚のビュー（自分所有・`setOwnedByMe(false)`）の両方**に適用する。共有ドライブ上のファイルは組織（ドライブ自身）が所有し個人オーナーが存在しないため、`ownedByMe` のどちら側に落ちるかが自明でない。片方だけに適用すると環境によって出たり出なかったりする
- **この変更で新たに選べるようになるファイルは無い。** 上の測定のとおり、共有ドライブ上のファイルは `setEnableDrives` 無しでも一覧に現れて選択・付与ができる。効果はナビゲーション（左メニューから共有ドライブを辿れる）に限られる
- **`setEnableDrives(true)` で共有ドライブがナビゲーションに現れることは実機で確認済み**（2026-08-15、PR #98 のマージ前に確認）。フェーズ0の測定ではフィクスチャが先に消費され2回目の Picker に到達できず未測定のままだったが、ここで解消した。**再確認は不要**

#### 読めなくなった PDF の復旧（対策 C'）

上記の帰結として、フォルダ単位での一括付与は成立しない。代わりに **Picker の複数選択で1セッションにまとめて再付与する**（`fulltext-regrant.ts`）。Picker の一覧表示は `drive.file` ではなく**ユーザー自身の Drive 権限**を使うため、fulltext フォルダに Drive 共有さえされていれば、共同研究者にも他人がアップロードした PDF が見えて選択できる（＝ Drive 共有は付与経路ではないが、Picker で選ぶための前提にはなる）。

- 検知は `listAccessibleFileIdsInFolder()` と References の `cached` 行の突き合わせ（`fulltext-access.ts`）
- Picker ページ側は `mode=regrant`。選択ファイルの一覧ではなく**件数だけ**を返す（数百件選択時に URL フラグメントが肥大するのを避けるため。付与は「選択」を押した時点でサーバー側に確定しており、一覧を受け取る必要が無い）
- 真値は必ず再度の `files.list` で取り直す。Picker の戻り値を「読めるようになった証拠」として扱わないこと
- Picker の起動とリダイレクト解析は `src/lib/drive-regrant-picker.ts`（UI非依存）に置き、モーダル・トーストは呼び出し側（サイドパネル / フルテキストページ）に残す。`chrome.identity.launchWebAuthFlow` は拡張機能ページであれば動くため、サイドパネル以外からも起動できる

#### 読めない PDF を「空のペイン」にしない（Issue #69）

**Drive のプレビュー埋め込み（`https://drive.google.com/file/d/{id}/preview`）へフォールバックしてはならない。** Drive は `/preview` に対して `frame-ancestors https://drive.google.com` を返すため、`chrome-extension://` のページからは**構造的に埋め込めない**。`frame-ancestors` はリモート側が返すヘッダなので拡張機能側の CSP 設定では上書きできず、直しようがない。以前の `showCachedPdf()` はここへフォールバックしており、実際には無言で空のペインになるだけだった（エラー表示すら出ない）。

代わりに失敗の種別で案内を出し分ける（`src/lib/fulltext-pdf-access.ts` の `describePdfLoadFailure()`。テストは `tests/fulltext-pdf-access.test.ts`）。

- **判定器を二重に作らないこと。** 分岐の元になる型付きエラーは `downloadDriveFile()` が `classifyDriveApiStatus()` の分類から生成する。UI側でステータスコードを見て分岐し直さない
- `inaccessible`（403/404）→「未付与」案内＋再付与ボタン（主導線）。**この案内が正しいのは全 Drive 呼び出しに `supportsAllDrives` が付いている前提の上**（Issue #95。付いていないと共有ドライブ利用者に「再付与しても直らない」誤案内になる）
- `auth-error` / `transient-error` / 分類不能 → 再試行を案内し、**未付与と断定しない**
- 副次導線として「Drive で開く」（`platform().openExternal`）を併置する。ブラウザの Google セッションで読めるため即座の回避になるが、別タブの Drive ビュワーになるためハイライト・AI判定の根拠表示は使えない旨を明記する
- **「未付与」と「Drive から完全に削除済み」は API から区別できない**（どちらも 403/404 で、`files.get` も同じ理由で失敗するため追加の問い合わせでも割れない）。文言で両方の可能性に触れ、切り分けは再付与の結果に委ねる（選び直しても読めないならもう存在しない）
- `alt=media` は HTTP 200 でも本文が HTML のことがある（サインインページ等）。`downloadDriveFile()` は content-type で弾き、**`DriveAuthError`（認証切れ）として扱う**。サインインページを掴んでいるのはトークンが効いていない状態であり、「未付与」と断定して再試行を塞ぐ方が害が大きい。返してしまうと PDF.js が「壊れた PDF」として失敗し、原因が画面から辿れなくなる
- **403 は「未付与」だけではない。レート制限でも 403 が返る**（`userRateLimitExceeded` / `rateLimitExceeded` / `quotaExceeded` など。ダウンロード経路の `quotaExceeded` は「このファイルのダウンロード枠を使い切った」＝時間で解ける状態であって未付与ではない）。本拡張はフルテキスト PDF を最大3並列でプリフェッチするため現実に踏む。`downloadDriveFile()` は 403 のときだけ本文を `isDriveRateLimitBody()` に通し、該当すれば `DriveTransientError` へ倒す（404 では本文を読まない。レート制限は 403 でしか来ない）。本文の読み取り・パースに失敗した場合は安全側で `DriveAccessDeniedError` のまま
- Drive のエラー本文は**フィールドごとに語彙が違う**ので混ぜて照合しないこと。`errors[].reason` は Drive 独自の camelCase（`userRateLimitExceeded`）、`error.status` は gRPC 由来の SCREAMING_SNAKE_CASE（`RESOURCE_EXHAUSTED` / `PERMISSION_DENIED`）。同じ集合で両方を照合すると常に不一致になり、`errors[]` を含まない形の 403 でレート制限を取りこぼす。`errors[].domain === 'usageLimits'` は reason 名より安定した signal なので併用する

> 関連: `isUserAdmin()`（`sheets-api.ts`）は role が **owner または writer** で `true` を返す。共同研究者は編集者として招待されるため、**`isAdmin` ではオーナーと共同研究者を区別できない**。オーナー限定の分岐が必要な場合は別の識別子を用意すること。

### 共有フロー: なぜ「スプレッドシート先行＋フォルダはベストエフォート」なのか（2026-08 事故対応）

**背景（実プロジェクトで起きた事故）**: `drive.file` 下では、フォルダへの `permissions.create` は「配下の全子ファイルへのアプリ付与」を要求する。他メンバーがアップロードしたPDF等が1つでもフォルダにあると、招待は**誰が実行しても（オーナーでも）**403になる（`The user has not granted the app ... write access to the child file ...`）。これは上記「実測で確定した挙動」の裏返しで、フォルダへの `files.create`/`files.copy` は未付与でも成功する一方、**フォルダへの `permissions.create`（共有招待）は逆に全子ファイルへの付与を要求する**、という非対称な制約になっている。

**事前検知は原理的に不可能**: `files.list` は権限の無い子を黙って省く（上記「実測で確定した挙動」参照）ため、「付与の無い子がいるか」はアプリからは分からない。試して403をもらうしかない。

このため共有フロー（`handleShare`、`src/sidepanel/features/sharing.ts`）は次のように設計している:

1. **スプレッドシートを先に個別共有する**（招待文つき通知メールもこちらに載せる）。招待者はPickerでスプレッドシートを開いておりアプリ付与を必ず持つため、ほぼ確実に成功する
2. フォルダがあれば**フォルダ共有はベストエフォート**で追加実行する（通知メールは`addPermission`の`sendNotificationEmail: false`オプションで抑制し、スプレッドシート側の招待文つき通知と二重に届かないようにする）
3. フォルダ側が失敗しても**招待全体を失敗にしない**。スプレッドシート共有は既に成功しているため、`showModal`（`src/sidepanel/ui/modal.ts`）で「フォルダは手動共有が必要」という日本語ガイドとオーナーのメール（フォルダ→スプレッドシートの順に `role==='owner'` を解決。どちらも取れなければ省略）、「フォルダをDriveで開く」ボタンを出す。リンクは `platform().openExternal()` 経由で開く（`sharing.ts`はWeb版ビルドにも入るため chrome API を直接呼ばず、拡張=`chrome.tabs.create`・Web=`window.open` を使い分ける既存のプラットフォーム抽象に乗せる）
4. **失敗時のAPIエラーメッセージはパースしない**（英語文言依存は脆く、Driveのエラー文言はいつ変わってもおかしくないため）。403の理由が「子ファイル未付与」か別の理由かを判別せず、一律「フォルダは手動共有が必要」という案内にフォールバックする
5. 成功パスでの二重権限（スプレッドシート直付与＋フォルダ継承）は許容する。解除フロー（`handleRemoveShare` / `resolveRemovalTargets`）は元々フォルダ・スプレッドシート両方のターゲットを処理する設計のため、この変更による影響はない

**共有リストの実態表示**: `loadSharedUsers` は以前フォルダ権限のみを表示していたため、「リストに居ないメンバーがレビューできている（＝フォルダには居ないがスプレッドシートには個別付与されている）」という誤診断の温床になっていた。現在はフォルダ・スプレッドシート双方の権限を取得し、`mergePermissionsForDisplay`（`src/lib/share-permissions.ts`、純関数）でメールアドレス単位にマージして表示する。同一メールが両方にいる場合は強い方のrole（owner > writer > reader）を採用し、どちらか一方の取得に失敗しても他方だけで表示を続ける（縮退思想は既存のフォルダ優先フォールバックと同じ）。

**リンク共有（`type: 'anyone'`）の検出と警告**: 実プロジェクトでは共有ボタンを使わず、Google側で手動の「リンクを知っている全員が編集可」運用がされていたことがあった。リンク共有はURLが漏れれば第三者が判定データを閲覧・改ざん（reader権限なら閲覧・流出）できるため、`mergePermissionsForDisplay` は `type==='anyone'` の権限を通常のユーザー一覧から分離し、`linkShare`（`{ role: 'writer' | 'reader' }`）として返す。`loadSharedUsers` はこれを共有リストの先頭に警告バナーとして表示する（writer=赤系、reader=黄系）。**警告文言には必ず「先に全メンバーを個別共有へ追加してから、Driveの共有設定を『制限付き』に変更する」という順番を明記する**。この順番を書かないと、警告に従ってリンク共有を先に解除した瞬間に、リンク経由でアクセスしていた現役メンバーが締め出されてしまうため。

**セットアップチェックリストへの反映（管理者向け2項目）**: 共有リストの警告は管理者がその画面を開かないと気づけないため、フルテキストタブ先頭の「セットアップチェックリスト」（`src/lib/fulltext-checklist-state.ts` / `src/sidepanel/features/fulltext-checklist.ts`）にも管理者専用の2項目を追加している（非管理者には出さない）。

- **リンク共有の検出**: 上記 `mergePermissionsForDisplay` の `linkShare` をそのまま再利用し、判定ロジックを二重化しない。writer=error（赤）、reader=warn（黄）。アクションはスプレッドシートのURLを `platform().openExternal()` で開く「Driveで共有設定を開く」ボタン
- **フォルダ共有のズレ検出**: フォルダの実際の権限一覧（`getFilePermissions(projectFolderId)`）に、「本来レビューに参加するはずのメンバー」が見当たらない場合に警告する。**このメンバー一覧の出所がブラインドセーフの要**: Decisions の `reviewer_id` から集めてはいけない（Blind中は他人の human 票がクライアントに配られないため、集計すると人によって missing の結果が変わってしまう）。代わりに全員に同じ値が見える Config 由来の割り振り設定（TiAb: `state.assignmentConfig.reviewerMap` ＋ フルテキスト: `state.fulltextAssignment.reviewerMap`）の和集合を使う。フォルダ権限が読めない（drive.file未付与で403等）場合は「異常」ではなく「アプリからは判定できない」状態なので、項目ごと黙って非表示にする（エラー表示にしない。上記の縮退方針と同じ）
- フォルダ・スプレッドシートの権限取得はDrive APIの読み取りクォータ対象のため、チェックリストの再描画のたびに叩かず、spreadsheetId単位でモジュール内キャッシュする（429対策）

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
- **`.tmp/tests` は掃除されない。** `npm run test` は `.tmp/tests/tests/*.test.js` を glob で拾うため、削除済みブランチのテストがコンパイル済みのまま残っていると件数が水増しされる（実例: `auth-pkce.test.js` が残って 392 件と表示されたが、真値は 379 件だった）。件数が合わないときは `tests/*.test.ts` の数と突き合わせること。

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
