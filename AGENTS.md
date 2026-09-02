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
| fulltext_drive_source_id | Drive直接取り込みの取り込み元PDFのDriveファイルID（W列） |      |
| fulltext_drive_copy_id   | 同じく、取り込み時に作成/再利用したコピーのDriveファイルID（X列） |      |
| record_type     | レコード種別。`article` / `registration`。未設定は `article` 相当（後方互換）。確定値を持つのはCTG/ICTRPパーサと、論文候補の取り込み（`buildImportedPublicationReference()`。取り込んだ論文行は常に `article` を確定値として書く）。判定は必ず `src/lib/registry-record.ts` の `isRegistrationRecord()` を経由すること（Y列）。`isRegistrationRecord()` が true の行は、フルテキスト取得（`retrieveAndCacheFulltext()`）でも通常のOAウォーターフォール（PMC OA/Europe PMC/Unpaywall/OpenAlex、pmid/doi前提）に入れず、レジストリ内容の自己完結HTMLスナップショットをDriveへ保存する経路に分岐する（レジストリ連携フェーズ1チャンク2パスA。下記「試験登録レコードのフルテキスト取得（レジストリスナップショット）」参照） |      |
| related_ref_id  | 取り込んだ論文行から、発見元のregistration行の `ref_id` への**一方向**の参照（registration行側に逆リンクは張らない。`src/lib/publication-import.ts` の `buildImportedPublicationReference()` が書く）。この列が非空の行は、TiAb票を一切持たなくても `src/lib/fulltext-candidates.ts` の `isFulltextCandidateRef()` / `isProjectFulltextCandidateRef()` / `isSharedFulltextPoolMember()` が無条件でフルテキスト候補として扱う（レジストリ連携フェーズ1チャンク3、Issue #118。下記「論文候補の取り込み（Referencesへの追加）」参照）（Z列） |      |

**References も列は末尾追記のみ**（`LLM_Executions タブ`の注意と同趣旨）。上記2列（W/X）はIssue #73 Phase 2 で末尾に追加した。record_type/related_ref_id（Y/Z列）はIssue #118 チャンク1（レジストリ連携フェーズ1）で追加した。新しい列は必ず配列の末尾に足し、`src/demo/seed.ts` の `REFERENCES_HEADERS` ミラーも追従させること（今回も追従済み）。

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
| context_json    | 判定の瞬間に人間がAIの情報にどれだけ暴露されていたかを記録するJSON（`DecisionContextV1`、`src/lib/decision-context.ts`）。human判定（TiAb/フルテキストの `handleDecision`/`handleSave`）の保存時のみ設定する。**書くだけの列で、読み手（既存のUI・集計）の挙動は一切変えない**。将来「人間の判定はAIから独立していたか」を遡って検証するための記録専用列 |      |

**重要**（2026-08 追記専用化。詳細は「κ（Cohen's kappa）の算出」参照）:

- **Decisions は追記専用**: human 判定（`client_version` に `-human` を含む）と ML 手動確認判定（`-ml` を含み `-auto` を含まない）は、既存行を更新せず**常に新しい行として追記**する
- 同一 `ref_id` + `reviewer_id` + `screening_phase` の行は複数存在しうる。**`decided_at` が最新の行（同値の場合はシート上で後の行）を有効な判定とする**。読み取り側（UI・進捗集計・不一致検出など）はこの最新行だけを見るため、下流の挙動は追記専用化前と同じ
- 過去の行は判定変更の履歴として保持する（合議前後の κ 算出などに利用できる）
- **ML自動判定・LLM判定は従来どおり既存行を更新する**（pending→confirm の行更新と `deleteFulltextAiRound` のラウンド管理を壊さないため）
- **他者の判定**: 他の `reviewer_id` の判定行は上書き禁止（変更なし）
- スプレッドシートの列定義は変更していないため、既存プロジェクトはそのまま動作する

**Decisions を横断する処理は `screening_phase` を必ず見ること**: TiAb のAI判定もフルテキストAI判定も `reviewer_id` は同じ `llm:{model}@{timestamp}` 形式を使い、区別は `screening_phase`（`'tiab'` 省略可 / `'fulltext'`）だけでつく。`reviewer_id.startsWith('llm:')` のような前方一致だけで横断すると TiAb とフルテキストが混ざる。実際に既存コードが2箇所で踏んでいた（Issue #62 で修正済み）:

- `findOrphanedExecutions`（`src/sidepanel/features/llm/recovery.ts`）が `screening_phase` を見ておらず、フルテキストAI判定のラウンドを TiAb の「孤立判定」として誤検出していた。復旧を実行すると `execution_type='batch_screening'` の偽の行が作られ、`migrateLegacyExecutionsToRuns` が Run に束ねて TiAb の active 判定に混ざりうる
- `loadExecutionHistory`（`src/sidepanel/features/llm/batch.ts`）が `execution_type` を二値の三項演算子で扱っていたため、フルテキストの実行履歴が「判定基準生成」という誤ったラベルで TiAb の実行履歴一覧に混入していた

教訓: `execution_type` や `reviewer_id` を分岐に使うときは、二値前提の三項演算子ではなく明示的な除外／網羅を書くこと。

#### Audit_Log タブ（監査ログ、追記専用）

key の開閉など、判定イベントではないため Decisions の行に相乗りできない操作を、独立したイベント行として記録する（Decisions.context_json との役割分担は同列の説明を参照）。`src/lib/audit-log.ts`（ヘッダー定数・`buildAuditEventRow` の純関数）と `src/lib/sheets-api.ts` の `logAuditEvent()`（実際の書き込み）が担う。

| 列名           | 説明                                                     | 必須 |
| -------------- | -------------------------------------------------------- | ---- |
| event_id       | イベントID（UUID、呼び出し側で `crypto.randomUUID()`）   | ✓   |
| event_type     | `key_opened` / `key_closed`（今回のスコープは key 開閉のみ） | ✓   |
| actor          | 操作者（email）                                           | ✓   |
| occurred_at    | 発生日時（ISO 8601）                                      | ✓   |
| client_version | 拡張機能バージョン                                        |      |
| detail_json    | 追加情報（今回のスコープでは常に空文字）                  |      |

- **タブが無いプロジェクトは初回書き込み時に自動作成する**: `addSheet` → `[ヘッダ行, 本体行]` を1回の append でまとめて書き込む。Config タブ欠落時の `trySaveConfigValue` と同じ自動作成パターンを踏襲している（ヘッダ行と本体行を別々の append に分けると、ヘッダ側だけが失敗した場合に「タブは存在するがヘッダー無し」の状態が恒久化してしまうため、まとめて1回にしている）
- **ベストエフォート方針**: `logAuditEvent()` は失敗しても外へ throw しない（catch して `console.warn` するのみ）。監査ログの書き込み失敗で key 開閉などの本体操作を失敗扱いにしてはならないため
- **呼び出し元は key 開閉（`handleKeyToggle`、`src/sidepanel/features/screening/actions.ts`）のみ**。ML確認判定・裁定票など他の判定イベントは今回のスコープ外で、記録しない

#### 合議判定の構造化マーク（-human-consensus）

TiAbスクリーニング画面の「合議モード」チェックボックス（`state.consensusMode`、`src/sidepanel/state.ts`）は、**キー開封後（`state.isKeyOpened === true`）のときだけ表示する**（合議はブラインド中に成立しないため。フルテキストの裁定UIと同じガード）。ONの間に保存する判定は `getClientVersion('-human-consensus')` を使う。`isHumanDecision()` は `-human` の部分一致で判定するため、合議判定も通常のhuman判定と同じ追記専用（append-only）経路に乗りつつ、`client_version` から「合議での判定変更」だけを正確に識別できる（κ算出手順を参照）。

- ONのときは判定ボタン付近にバッジを表示し、合議モードを付け忘れたまま通常判定してしまう事故を防ぐ
- key を Blind へ戻す（`handleKeyToggle` の CLOSE 経路）、プロジェクト切替（`resetForBack`）、ログアウト（`resetForLogout`）のいずれでも合議モードは自動的に OFF へ戻る
- **表示ガードだけに頼らず、判定の書き込み地点（`handleDecision`）でも `state.isKeyOpened === false` なら `state.consensusMode` の値によらず必ず `-human` に落とす**（`humanDecisionSuffix()`、`src/lib/client-version.ts`）。トグル非表示時に `state.consensusMode` を落とし忘れる／リセット関数から漏れるといった経路のバグがあっても、ブラインド初回判定が `-human-consensus` として保存されない多層防御
- `persistDisplayedNote` のメモのみ行（pending）は判定イベントではないため、合議モードの状態に関わらず常に `'-human'` のまま保存する

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

#### フルテキスト判定画面（PDFウィンドウ）の「他レビュアーの判定」

`src/fulltext/fulltext.ts` の右ペイン折りたたみ（`renderContextPanel`）には、抄録・自分のTiAb判定に加えて
**キー開封後（`keyOpened === true`）のときだけ**、同じ文献に対する他レビュアーのフルテキスト判定
（判定・除外理由・メモ）を出す。不一致をPDFで読み直すとき、サイドパネルの「不一致の解消」へ戻らずに
相手の言い分を読めるようにするため（従来はこの画面に自分とAIの判定しか出ていなかった）。

- 選別ロジックは `src/lib/fulltext-other-decisions.ts` の純関数（`selectOtherFulltextDecisions` /
  `otherReviewerLabel`）に切り出す。`fulltext.ts` は DOM/ページ状態に依存する層でテストできないため
  （`fulltext-consensus.ts` と同じ方針）。テストは `tests/fulltext-other-decisions.test.ts`。
- ブラインドの線引きは**3層**で持つ（多層防御）: `getFulltextPageData` が `filterDecisionsForBlind` で
  他レビュアーの票を落とし、`selectOtherFulltextDecisions` も `keyOpened === false` なら必ず空を返す。
  両者のポリシー本体は `src/lib/blind-visibility.ts` の `isDecisionVisibleDuringBlind()` に一元化している
  （「自分の判定」または「AI（`llm:`）判定」のみ表示可）。3層目として、サイドパネルでキー状態が
  変わったときは `platform().emitMessage({ type: 'blind:key-changed', spreadsheetId, keyOpened })` で
  別ウィンドウへ通知する（`src/sidepanel/features/screening/actions.ts` の `handleKeyToggle()`）。
  `fulltext.ts` はこれを購読し、Blindへ戻る通知では**再取得を待たずその場で** `allDecisions` から
  他レビュアーの票を破棄する（`applyKeyOpenedChange()`）。別ウィンドウでPDF判定画面を開いたまま
  サイドパネル側だけBlindへ戻された場合、購読していないと文献を移動してもメモリ上のキャッシュから
  他レビュアーの判定が再表示され続けてしまうため。
- AI票（`llm:`）はここには出さない（判定パネル上部のAI判定サマリと二重になるため）。
  裁定票（`adjudication:`）は「不一致がどう解消されたか」を示すので出すが、`note` は裁定時点の票の
  スナップショット（JSON）なので本文としては表示しない。裁定票は reviewer_id（裁定者）ごとではなく
  **全裁定者を横断して1グループ**として畳み、`decided_at` が最新の1件だけを出す
  （`computeFulltextConsensus()` と同じ「裁定票のうち最新のものを最終とする」規則）。
- 表示名（`otherReviewerLabel`）は通常の判定者・裁定者ともに完全なメールアドレスを出す
  （ローカル部だけだと `alex@hospital-a.example` と `alex@hospital-b.example` を取り違える）。
- 折りたたみは既定で閉じているため、**見出しに件数を出す**（`#ft-context-summary` を実行時に書き換え）。
  畳んだままだと相手の判定があること自体に気付けない。

### TiAb エクスポート（CSV/RIS）の判定者別列

`src/sidepanel/features/import-export.ts` の `handleExportCSV()` / `handleExportRIS()` が対象。
「誰が何と判定したか」が分かるよう、`status` 列とは別に `team_status` 列を追加している。
集計ロジックは純関数として `src/sidepanel/features/screening/decision-summary.ts` に切り出してあり
（`../../state` / `../../dom` を import しない。テストから state/dom 抜きで検証するための制約）、
`render/helpers.ts` からは `computeReviewerKey()` のみ再利用している
（`detectConflictWithSettings()` は使っていない。conflict 判定は `byReviewer` の decision 値の
ユニーク数から独自に行っている。判定人数のカウント方法が異なるため流用していない）。

**`status` と `team_status` は定義が違う（意図的な別物）**:

| 列 | 算出元 | 「判定1件のみ」の扱い |
|---|---|---|
| `status`（既存・互換維持のため変更しない） | `sheets-api.ts` の `detectConflict()` | 1人しか判定していなくても `conflict` になる旧定義 |
| `team_status`（新設） | `decision-summary.ts` の `summarizeTeamDecision()` | 2人以上で判定が割れた場合だけ `conflict`。分母（`n_expected`）に満たなければ `incomplete` |

`team_status` の値:

| 値 | 意味 |
|---|---|
| `pending` | この文献をまだ誰も判定していない、または人間の判定者が0人（AIだけが判定している場合を含む） |
| `incomplete` | 判定済み人数（`n_judged`）が分母（`n_expected`）より少ない（他のレビュアーがこの文献をまだ判定していない） |
| `conflict` | 判定済みの全員（AI・ML含む）の判定内容が割れている |
| `include` / `exclude` / `maybe` | 全判定者が一致 |
| `blinded` | キー未開封（`state.isKeyOpened===false`）のためエクスポート側で判定者情報を出せない |

**`n_judged` / `n_expected`（分母）は「人」単位で数える**: AI(`reviewer_id` が `llm:` で始まるもの)は
数えない。ML判定（`::ml` サフィックス）は同一人物の手動判定と同じ「人」に畳んで数える。
これは AI の `reviewer_id` が `llm:{model}@{timestamp}` 形式でバッチ実行ごとに変わり
（`src/lib/llm-processor.ts`。中断・再開が通常系のため同一AIが複数の異なるキーとして現れうる）、
AIを分母に含めると再実行のたびに `incomplete` が増えてしまうため。
ただし **conflict の判定には AI・ML を含む全判定が従来どおり参加する**（AIと人間の判定が割れていれば
`conflict` になる。分母から外すことと conflict 判定から外すことは別）。

分母（`n_expected`）の決め方は `src/lib/assignment-roster.ts` の `getExpectedReviewersForRef()` に集約している:

- 担当割り振り（`state.assignmentConfig`）が `configured` なら、その文献の `screening_set`
  （`getRefAssignmentSet()`。空欄は `'unassigned'`）の担当者（`AssignmentConfig.reviewerMap[setId]`）が分母になる。
  `calibration` セットだけは特別扱いで `reviewerMap` 全体の和集合（`assignment.ts` の
  `getAssignedSetsForUser()` が calibration を全員の担当としているのと同じ規則）。
  **この経路では、その文献をまだ1件も判定していない担当者も正しく分母に入る**（未着手の担当者がいれば `incomplete` になる）。
- 担当割り振りが未設定（`status !== 'configured'`）、またはそのセットが名簿に登録されていない
  （`unassigned` を含む）・登録があっても空配列の場合は、従来どおり `collectReviewerKeys()` で得られる
  「判定実績のある人間レビュアー」の集合にフォールバックする。この経路では、まだ1件もこのプロジェクトで
  判定していないレビュアーは分母に入らない（判定実績から推定するしかないという仕様上の割り切り）。
- 名簿外の人（`reviewerMap` に載っていない人）が判定しても、その人は分母に含まれないため
  `n_judged` の分子にはカウントされない（`n_judged` は判定者と分母の積で数える）。

CSV ヘッダーは
`status, team_status, n_judged, n_expected, <レビュアーキー列...>, decision_notes, note, source_file`
の順（レビュアー列は生の reviewer_id/キー文字列で、表示ラベルではない。人間 → ML(`email::ml`) → AI(`llm:`) の順）。
レビュアー列の集合は `state.references` 全体（フィルタ結果ではない）から集めるため、フィルタを変えても列構成は変わらない。
RIS は既存の `C1 - Status: ...` の直後に `C1 - Team status: ...` を追加し、非ブラインド時のみ
`C2 - Decisions: a@x.com=include; b@y.com=exclude` を1行追加する（判定者が1人もいなければ省略）。

`decision_notes` 列は各判定者の理由・メモを1列にまとめたもの（`formatDecisionNotes()`）。
LLM判定の note は生の JSON 文字列（TiAb は `LlmDecisionNote`、フルテキストは `FulltextLlmDecisionNote`）
のため、そのまま出すと JSON が丸見えになる。`voteNoteText()` が人間可読な理由部分だけを取り出す:
TiAb 形（`reasons: string[]`）は非空要素を `'; '` で連結、フルテキスト形（`reason: string`）はそのまま。
どちらも取れない場合は生テキストにフォールバックする。

ブラインド中（`state.isKeyOpened===false`）は他レビュアーの判定がそもそもクライアントに配られていない
（他レビュアーの人間判定だけが配られない。`src/lib/sheets-api.ts` の判定取得は自分の人間判定を
`myDecision`、AI判定を `allDecisions` に入れて返すため `allDecisions` 自体は空ではないが、
`team_status` を算出するのに必要な他レビュアーの人間判定が揃わない）ため、
レビュアー別の列・`decision_notes` 列自体を出力せず、`team_status` は全行 `blinded`、`n_judged` / `n_expected` は空文字にする。
このとき完了トーストに警告（`export_blindedReviewerColumnsOmitted`）を連結して1本で出す。
別トーストを遅延表示すると見逃され、「レビュアー列の無いCSV」をそのまま配ってしまうため。

#### Config タブ（プロジェクト設定）

- **include_keywords**: 組み入れハイライト用キーワード（緑）
- **exclude_keywords**: 除外ハイライト用キーワード（赤）
- **fulltext_pool_rule**: フルテキスト候補ルール（JSON: `{version, voters, threshold}`）。採用する判定者（voter: `human:{email}` / `ml:{email}` / `llm:{...}`）の TiAb Include 票が `threshold` 以上の文献を候補とする。キー開封後にフルテキストページから設定。未設定時は、管理ユーザーは読み込まれている全レビュアーの TiAb Include が1件でもある文献を候補とし、非管理ユーザーは既存の割り振りで見える文献のうち自分が TiAb Include した文献だけを候補とする。
  - **候補計算を判定票に依存させるとBlindで壊れる（2026-08 実事故）**: Blind中（key_opened=FALSE）は他人の human 票がクライアントへ配られないため、human voter を含むルールは自分以外のメンバーには常に0票＝候補0件と評価される。このため候補判定は `src/lib/fulltext-candidates.ts` に集約し、**担当割り振り設定済みの場合は References の `fulltext_set` 列（判定票非依存）を候補の一次ソース**にしている。候補系のロジックを触るときは必ずこのモジュールを経由し、`isInFulltextPool` を直接呼ぶ実装を新設しないこと。なお `mountRuleEditor` はキー未開封ではフォームを描画しないため、「キー未開封で保存」経路のガードは実質通らない。実際の事故経路は「開封してルール保存 → Blindへ戻す」で、警告は `handleKeyToggle` の CLOSE 側にある。
- **import_stats**: インポート統計（JSON: `{"ファイル名": {identified, duplicates, imported_at}}`）。ファイルごとの解析件数（重複除去前）と重複スキップ数をインポート時に記録し、論文用テキスト（PRISMAフロー図の識別件数・重複除去数）の自動記入に使う。ソースファイル削除時は該当キーも削除する。
- **review_criteria**: レビュー基準（組入・除外基準）を1本の自由記述テキストとして保存する（JSON: `{text, updated_at, updated_by}`。`src/lib/review-criteria.ts` の `ReviewCriteria` 型）。プロトコル文書を都度開かなくても、複数レビュアーがTiAb画面・フルテキスト画面から常設ボタン（📋 / ショートカット `c`）で参照できるようにするための**人間レビュアー向けの表示専用**設定。編集はサイドパネル（管理者のみ）に一本化しており、フルテキスト画面は閲覧専用。
  - **AI 判定用の `llm_criteria`（PICO/PECO/SPIDER の構造化基準、`LLM_CONFIG_KEYS` 系）とは別物**。`llm_criteria` はAIへ渡すプロンプトの一部で `config_hash` の算出対象に入っているため、運用メモとしての `review_criteria` をここに混ぜると、基準の言い回しを直しただけで `config_hash` が変わり、同じ設定のはずの Run が新規Runとして扱われてしまう（「中断からの再開」「新規にやり直す」が壊れる）。両者は保存先キーを分け、`llm_config` 系の更新経路（`updateLlmConfig` 等）とは混ぜないこと。`llmCriteriaToText()` で `llm_criteria` の内容を `review_criteria` へ一方向コピー（インポート）する導線はあるが、逆はない。
- **fulltext_exclude_reasons**: フルテキストの除外理由リスト（JSON: `{items: [{key, label, labelEn}], retiredKeys: string[], updated_at, updated_by}`。`src/lib/exclude-reason-config.ts`）。**配列の順序が優先順位**で、判定画面の数字キー（先頭9件）もこの並びで決まる。未設定なら既定の PICO 7区分。PCC（scoping review）・PECO・SPIDER のプリセットを同モジュールに持つ。編集はフルテキストタブのインラインエディタ（管理者のみ）。上限は `items` が最大15件（`MAX_EXCLUDE_REASON_ITEMS`、`exclude-reasons.ts` 定義）、ラベルは最大50文字（`MAX_REASON_LABEL_LENGTH`）。Config タブは直接編集できるセルのため、`parseExcludeReasonConfig` がこの上限の唯一の信頼境界で、超過分は先頭切り捨て／ラベルは切り詰めで受ける（バリデーションエラーにはしない）。
  - `key` は Decisions シートの `reason` 列に入る**保存値**なので、発番後は変更しない（新規項目は `r1`, `r2`… で自動発番）。項目を削除しても過去の判定は消えず、集計では生キーのまま残る。
  - `retiredKeys`: 過去に使われて今は `items` に無いキー（＝削除された理由のキー）。`nextExcludeReasonKey` の衝突判定は `items` だけでなくこれも見る。ブラインド中は他レビュアーの票が読み込まれず使用件数が0件に見えるため、`items`（や使用件数）だけで衝突判定すると削除→再追加で他人が使っていたキーを再発行してしまう（実事故）。エディタ側は保存のたびに「編集開始時点にあって保存時に無いキー」を退役させ、`items` に戻ったキーは退役解除する。
  - `labelEn` は PRISMA フロー図・論文用テキスト（`manuscript.ts`）で使う。未入力なら `label` で代替する。
  - この設定は `config_hash` の算出対象ではない（`llm_config` 系とは別経路）。ただしフルテキストAI判定の出力スキーマ（enum）とプロンプトはこのリストから生成されるため、レビュー途中で理由を入れ替えると**前後のAI票で区分の意味が変わる**。運用上はスクリーニング開始前に確定させること。判定時点のリストは `LLM_Executions.exclude_reasons_snapshot` にスナップショットされるため、後から入れ替えても過去 Run の区分の意味は復元できる。

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

#### LLM_Executions タブ（列は末尾追記しかできない）

`saveLlmExecution`（`src/lib/sheets-api.ts`）は行を**位置ベース**で組み立てて `appendRows` する。ヘッダ名は見ていない。既存シートのヘッダは `ensureLlmExecutionsSheet` が不足列を**末尾へ追記**する形でしか育たない。したがって `LLM_EXECUTIONS_HEADERS` の途中に列を挿入すると、既存プロジェクトのシートで列がずれて壊れる。**新しい列は必ず配列の末尾に足すこと。**

- 読み取り側（`getLlmExecutions` / `updateLlmExecution`）はヘッダ駆動なので、新しい列の型変換が必要なら `getLlmExecutions` の `switch (header)` に case を足す
- `src/demo/seed.ts` に `REFERENCES_HEADERS` / `DECISIONS_HEADERS` / `LLM_EXECUTIONS_HEADERS` / `LLM_RUNS_HEADERS` のミラーがあり、**実際に drift していた**（Issue #62 時点で `LLM_EXECUTIONS_HEADERS` のミラーが `target_mode` / `target_sets` / `target_selected_count` の3列ぶん古かった）。列を変更したら両方を確認すること

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
   - 除外理由入力（exclude時必須。選択肢はプロジェクト設定 `fulltext_exclude_reasons`）
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
   - **Gemini の implicit prompt caching で TiAb のコストは下げられない**（実測で確定、2026-09-01）。
     キャッシュ入力は標準入力の 0.10 倍なので、得になる条件は `N < C0 / m = 10 × C0`
     ＝**共有プレフィックスは10倍までしか伸ばせない**。現行の screeningPrompt は実測109トークンで
     上限1,090トークンだが、implicit caching の実測閾値は `gemini-3.1-flash-lite` で
     `5,852 < 閾値 ≤ 6,111` と約6倍高い（公称は「モデルにより2,048〜4,096」だが flash-lite の行は無い）。
     閾値が仮に2,048でも成立しないため、単価倍率や閾値の細かい値に結論は依存しない。プロンプトを
     水増しして閾値に届かせる方向は**どう転んでも損**（詳細: `experiments/gemini-prompt-cache/report.md`）。
     蒸し返さないこと。なお前置きが別の理由で既に閾値を超えているユーザーには implicit caching が
     既定で効いており、**実装すべきものは無い**
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
   - **実行履歴**（Issue #62）: `handleStartAiBatch` は `LLM_Executions` へ
     `execution_type='fulltext_batch_screening'` の行を2フェーズで書く（開始時に `status='pending'`
     で先書き→終了時に `status='confirmed'` へ確定）。`execution_id` は `reviewer_id`（ラウンドID）と同一。
     全件失敗して Decisions に1行も残らなくても「実行したが0件成功だった」という事実がこの行として残る。
     TiAb 用の列に加え `executed_by`（実行アカウント）・`maybe_count`（フルテキストは3値判定）・
     `failed_count`・`failure_breakdown`（`src/lib/fulltext-ai-failures.ts` の
     `FulltextAiFailureKind` 別内訳をJSON文字列化したもの）・`exclude_reasons_snapshot`
     （判定時点の除外理由リストのJSON文字列 `[{key,label,labelEn}]`。`criteria_snapshot` /
     `screening_prompt` と同列のスナップショットで、後から `fulltext_exclude_reasons` の
     ラベルを変えても過去 Run の区分の意味を復元できるようにする。TiAb の実行では null）を持つ。
     **`is_active` は使わず、採用状態は常に Config の `fulltext_ai_active_round` が正**（常に `false` 固定で保存する）。
     **TiAb の Run/Batch モデルには載せない**: `loadExecutionHistory`（`llm/batch.ts`）は
     `fulltext_batch_screening` 行を TiAb の実行履歴一覧から除外し、`findOrphanedExecutions`
     （`llm/recovery.ts`、孤立判定の復旧）は `screening_phase==='fulltext'` の判定行を対象から除外する
     （reviewer_id の形式が `llm:{model}@{timestamp}` で TiAb と同じため、除外しないと誤検出・混入する）。
     フルテキストの実行履歴自体は AI判定タブのラウンド一覧（`src/lib/fulltext-ai-rounds.ts` の
     `mergeRoundsWithExecutions` が Decisions由来のラウンドと結合する）で表示する
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
- `c` : レビュー基準（組入・除外基準）の表示/非表示

**入力欄の Enter と日本語入力（IME）**

- フルテキストの補足メモ欄（`ft-reason-note`）は `Enter` で「保存して次の候補へ」、`Shift+Enter` で改行、`Escape` でフォーカス解除
- 日本語入力では**変換の確定にも `Enter` を使う**ため、Enter にアクションを割り当てた入力欄では
  `src/lib/ime-composition.ts` の `isImeComposing()` で変換中のキーを必ず読み飛ばすこと。
  これを忘れると、メモを書いている途中の変換確定で次の文献へ飛ぶ（キーワード入力欄なら半端な語が登録される）
  - `isComposing` / `keyCode === 229` に加え、`compositionstart` / `compositionend` で追跡した状態も渡せる
    （`isComposing` を立てない IME への保険。補足メモ欄はこの追跡込みで実装している）

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
    - 編集UIはフルテキストタブのインラインエディタ（`src/sidepanel/features/fulltext-reason-editor.ts`、管理者のみ）
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

### 試験登録レコードのフルテキスト取得（レジストリスナップショット）

CTG/ICTRP由来のregistration行（上記2マッピング参照）は試験ID（NCT/jRCT/UMIN等）が pmid 列に入っており、通常論文向けのOA取得ウォーターフォール（`src/lib/fulltext-retriever.ts` の `iterateFulltextCandidates`。PMC OA → Europe PMC → Unpaywall → OpenAlex 等、pmid/doi前提）に入れても必ず `unavailable` で行き止まりになる。そのため `retrieveAndCacheFulltext()` は先頭で `isRegistrationRecord(ref)` を見て、trueならOAウォーターフォールへは一切入らず、登録内容を自己完結HTMLスナップショットにしてDriveへ保存する別経路（`retrieveRegistrationSnapshot()`）へ分岐する（レジストリ連携フェーズ1チャンク2パスA、Issue #118）。

- 試験ID抽出は `src/lib/registry-record.ts` の `extractTrialId()`（`NCT\d{8}` 完全一致なら `kind:'nct'`、それ以外の非空値は `kind:'other'`）
- `kind==='nct'` の場合、`src/lib/registry-api.ts` の `fetchCtgStudy()` で ClinicalTrials.gov API v2（`GET /api/v2/studies/{NCT}`）から詳細を取得してスナップショットに使う。取得失敗時は例外を投げず `null` を返す
- API失敗時（`null`）または `kind==='other'`（NCT以外のレジストリはAPI対象外）は、References に保存済みのフィールドだけでスナップショットを組み立てる。abstract列はCTG/ICTRPパーサが `ラベル: 値` を ` | ` 区切りで合成した文字列なので、`parseRegistryFieldsFromAbstract()` で逆変換する。この経路はネットワーク不要
- スナップショットHTML自体は `buildRegistrySnapshotHtml()`（外部CSS/JS/画像を一切参照しない自己完結HTML。埋め込み値は必ずHTMLエスケープする）、ファイル名は `buildRegistrySnapshotFileName()`（`buildPdfFileName()` と同じ命名規約で拡張子だけ `.html`）、Driveアップロードは `src/lib/drive-api.ts` の `uploadHtmlToDrive()`（`uploadPdfToDrive()` と同じmultipartアップロード処理を内部ヘルパーへ共通化）が担う
- Drive保存に失敗した場合は例外を外に投げず、原簿URL（`ref.url`）が `src/lib/registry-record.ts` の `isSafeHttpUrl()`（http/httpsのみを安全とみなすガード。元はHTML埋め込み専用のmodule-private関数だったが、この用途のため `export` した）を通れば `linked`、通らなければ（`javascript:`/`data:` 等の危険なスキームや相対URL・不正な値）または `ref.url` 自体が無ければ `none` にフォールバックする（一括取得ループを止めないため。既存OA経路の catch → `console.warn` の作法と同じ）。`ref.url` は References の url 列＝ユーザーが直接編集できるセル由来のため無検証で通してはいけない。この値はサイドパネルの `buildLinkBtn()` を経由して `chrome.tabs.create({ url })` にそのまま渡るため（描画側のガード追加は別スコープ。PR #122 レビュー指摘3、Issue #118 チャンク2）
- 通常の論文レコード（`isRegistrationRecord()` が false）の挙動はこの分岐追加前と変わらない
- パスB（論文候補探索）はチャンク2で実装済み（下記「試験登録レコードの論文候補探索」参照）。候補の表示・取り込み・References への行追加はチャンク3で実装済み（下記「論文候補の取り込み（Referencesへの追加）」参照）

### 試験登録レコードのフルテキストビューア表示（スナップショット）

上記で保存したHTMLスナップショットを `src/fulltext/fulltext.ts`（フルテキストビューア）で表示できるようにし、「PDFとして保存」導線を置く（レジストリ連携フェーズ1チャンク3c、Issue #118 実装内容10）。

- 表示経路の判定は `src/lib/fulltext-display-mode.ts` の `resolveFulltextDisplayMode()`（UI非依存の純関数）に集約している。`record_type`（`isRegistrationRecord()` 経由）と `fulltext_status`/`fulltext_url` から `'registry_snapshot' | 'pdf' | 'linked' | 'unavailable' | 'not_retrieved'` を返す。`isRegistrationRecord(ref)` かつ `fulltext_status==='cached'` かつ `fulltext_url` があるときだけ `'registry_snapshot'` になり、既存の `showCachedPdf()`（PDF.js経路）には一切入らない。HTMLをPDF.jsに渡すと解析に失敗し、catch節の「Chrome内蔵ビュワー(iframe blob)へのフォールバック」に落ちて非サンドボックスの `ft-pdf-frame` に生HTMLが載ってしまうため、この暗黙のフォールバックに頼らず明示的に分岐させている
- **`showPdfForRef()` だけでなく `handleResolve()`（初回自動検索）の `outcome.kind==='cached'` 分岐も同じ判定で出し分けること。** `showCachedPdf()` の呼び出し元は複数あり、`showPdfForRef()` だけを直すと registration行の**初回**表示（一度も fetch していない状態から取得した直後）だけ旧経路（PDF.js→フォールバック）に残ってしまう。この抜け漏れはブリーフが名指ししていなかったが、`showCachedPdf()` の全呼び出し元を grep して見つけて塞いだ（`openLinkedInline()`/`uploadPdfFile()` からの呼び出しは対象外のまま据え置き。前者は registration行の 'linked' フォールバック時の別経路、後者はマジックナンバー検証済みの実PDFで、どちらも常にPDF経路で正しい）
- 表示は専用のサンドボックスiframe `#ft-snapshot-frame`（`fulltext.html`）に `srcdoc` でHTMLを流し込む（`showRegistrySnapshotFrame()`）。**sandbox属性は `allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox` で、`allow-scripts` は絶対に付けない。** スナップショットは `buildRegistrySnapshotHtml()` がエスケープ済みで生成するが、保存先はユーザーが編集し得るDriveファイルのため信頼できない前提で扱う。`allow-same-origin` は親から `frame.contentWindow.print()` を呼ぶために必要（「PDFとして保存」ボタン、`#ft-snapshot-print-btn`。既存の「このPDFを保存」＝ `ft-save-pdf-btn` とは別物）。`allow-scripts` と同時に付けるとsandboxが実質無効化されるが、scriptsを付けないため危険な組み合わせにはならない。既存の `ft-article-frame`（`sandbox="allow-scripts allow-same-origin ..."`）とは用途もsandbox設定も別物のため流用していない
  - **`allow-popups` / `allow-popups-to-escape-sandbox`（PR #124 レビュー指摘3）**: `buildRegistrySnapshotHtml()` が埋め込む原簿URLの `<a>` には `target="_blank" rel="noopener noreferrer"` を付けている。機序は次のとおり（Chromium 151 で実測した結果は下記「サンドボックス挙動の実機確認結果」を参照。ブラウザ実装差の可能性は残る）: 当初この属性が無く `#ft-snapshot-frame` に `allow-popups` 系を一切付けていなかったため、クリックするとサンドボックスiframe自身がその場で遷移していた。サンドボックス化された閲覧コンテキストが「自分自身」を遷移させることは常に許可されており、これは `allow-top-navigation`（トップレベルの閲覧コンテキストの遷移を制御する別のフラグ）の有無とは無関係に起こる。この遷移でスナップショット表示が消え、遷移先には sandbox が再適用（`allow-scripts` 無し）されて崩れた表示になり、ペインへ戻る手段が無くなっていた。`target="_blank"` を付けても `allow-popups` が無い場合は、HTML仕様の「sandboxed auxiliary navigation browsing context flag」が立っているため補助閲覧コンテキスト（新規タブ）の生成自体がブロックされる。**iframe内遷移へフォールバックするのではなく、リンクをクリックしても何も起きない**（ブラウザがコンソールにエラーを出す想定）。そのため `allow-popups` も要る。`allow-popups-to-escape-sandbox` は、サンドボックス化された閲覧コンテキストが開いた補助閲覧コンテキストへ sandbox が継承されると、`allow-scripts` の無い新規タブで遷移先が崩れるため、それを避ける目的で付けている。**ただし Chromium 151 の実測では、このトークンの有無で挙動は変わらなかった**（`allow-popups` だけでも新規タブは非サンドボックスになる。下記「サンドボックス挙動の実機確認結果」参照）。機序は特定できていないが、仕様どおり継承するブラウザ向けの保険として残している。**この組み合わせが安全な理由**: スナップショットHTMLに `allow-scripts` を付けない以上スクリプトは一切実行されないため `window.open` を programmatic に呼ぶ経路は存在せず、ポップアップはユーザーのアンカークリックのみから発生する。かつそのhrefは `isSafeHttpUrl()`（http/httpsのみ）を通ったものに限られる（`buildRegistrySnapshotHtml()` 側で保証済み）
  - **サンドボックス挙動の実機確認結果**（2026-08-27、Chromium 151 + Playwright で実測。以前ここには「この環境では実行検証できない」と書いていたが誤り。下記の方法で認証なしに検証できる）:
    - **検証方法**: dev ビルドを `--load-extension` で読み込み、`chrome-extension://<拡張ID>/fulltext/fulltext.html` を **`ref_id` クエリ無し**で開く。`initFulltextPage()` は `refId` が空なら `getAuthToken()` の**手前で** return するため、認証もスプレッドシートも無しに実CSP・実DOM・実sandbox属性の上でページが立ち上がる。あとは `page.evaluate()` で `#ft-snapshot-frame` に `srcdoc` を入れて直接叩けばよい（拡張ロードの雛形は `scripts/doc-screenshots/capture.mjs`）。ただし init が認証前に return する＝`wireSnapshotPrintButton()` 等の配線は張られていないので、ボタン起点で試すならハンドラ本体を張り直してからクリックする
    - **`contentWindow.print()`**: `allow-modals` があると無視されず `beforeprint` が発火し、印刷プレビューが実際に開く。印刷対象はスナップショットiframeの中身だけで、親ペインの判定パネルを巻き込まない（1ページ、送信先に「Microsoft Print to PDF」が選べる）。**対照実験**: `allow-modals` を外した iframe へ同じ呼び出しをすると `Ignored call to 'print()'. The document is sandboxed, and the 'allow-modals' keyword is not set.` が出て `beforeprint` は発火しない。modal 系APIの検証はこの対照が無いと成功側の観測が何も証明しないので必ず置くこと。なお `print()` は印刷プレビューでレンダラを同期ブロックするため `page.evaluate()` の戻り値では結果を取れない（`beforeprint` ハンドラの `console.log` で拾う。`page.click()` の ack がタイムアウトすること自体がプレビューが開いた傍証になる）
    - **原簿リンク**: 本番の sandbox 値で新規タブが開き、iframe 自身は遷移せずスナップショット表示が残る。**対照実験**: `allow-popups` を外すと新規タブは開かず `Blocked opening '<URL>' in a new window because the request was made in a sandboxed frame whose 'allow-popups' permission is not set.` が出る。**iframe内遷移へフォールバックはしない**（上記の想定どおりの挙動）
    - **`allow-popups-to-escape-sandbox` の効果は観測できなかった**: `allow-popups` のみでも新規タブは非サンドボックス（`document.location.origin` が遷移先そのもので、スクリプトも動く）になり、`allow-popups-to-escape-sandbox` を足しても変わらない。`<a>` の `rel="noopener noreferrer"` の有無でも変わらない（sandbox 2通り × rel 2通りの4通りすべて同じ結果）。機序は特定していない。仕様どおり継承するブラウザ向けの保険として残しているだけなので、**このトークンが実際に効いていることを前提にした変更をしないこと**
    - **`allow-scripts` を付けていないことの効果**: スナップショットHTMLに `<script>`・`<img onerror>`・`<svg onload>` を仕込んでも、いずれも実行されない（`document.title` も書き換わらない）
- Driveからの取得は `showCachedPdf()` と全く同じ作法（`extractDriveFileId()`/`downloadDriveFile()`、`pdfPrefetch` の先読み再利用、`token`/`isStale()` による取り違え防止）。`prefetchNeighbors()` は cached の隣接候補を中身に関わらず先読みするため、registration行の隣接候補でも二重ダウンロードは起きない。取得失敗時は無言の空ペインにせず、`showPdfAccessFailure()` と同じ `describePdfLoadFailure()` の分類を再利用しつつ、"PDF" と明記した既存文言だけをスナップショット向けに差し替えた専用パネル（`showRegistrySnapshotAccessFailure()`）を出す。**`buildPdfAccessFailurePanel()` 自体は変更せず複製した**（既存のPDF失敗UIへの影響をゼロにするため）
  - **0バイトのBlobも取得失敗として扱う（PR #124 レビュー指摘5）**: `showRegistrySnapshot()` の空ペイン防止ガードは `if (!blob || blob.size === 0)` で判定する。`null`/`undefined` と違い0バイトの `Blob` は truthy なので `if (!blob)` だけでは素通りしてしまい、`looksLikePdfBlob()`（先頭5バイト判定）も空文字のため `false`、`blob.text()` は `''` を返して `showRegistrySnapshotFrame('')` が `srcdoc=''` を設定しプレースホルダも隠すため、ペインが完全な空白になる「無言の空ペイン」が発生していた。0バイトはアップロード途中断やDrive側で中身が消えたファイルなどで起こりうる
- **実PDFで差し替えられた場合の安全網**: `isRegistrationRecord(ref)` は `record_type` というメタデータだけを見るため、ツールバーの「別のPDFをアップロード」でregistration行の `fulltext_url` が実PDFへ差し替えられていても `record_type` は `'registration'` のままで、`resolveFulltextDisplayMode()` は引き続き `'registry_snapshot'` を返す。この不整合はメタデータだけの純関数では解決できない（バイト列を見るにはfetchが要る）。そこで `showRegistrySnapshot()` は取得したバイト列の先頭が `%PDF`（`uploadPdfFile()` と同じマジックナンバー判定）なら、HTMLとして描画せず `showCachedPdf()`（通常のPDF経路）へ委譲する。`pdfPrefetch` の Promise は一度解決したBlobを返すだけなので、委譲しても二重ダウンロードにはならない。**純関数（メタデータ判定）と実行時のバイト列補正は責務を分けており、後者を前者に混ぜ込まない**
- ツールバー（`updateToolbarMode()`）は `fulltext_status==='cached' && fulltext_url` を `hasPdf` として「別のPDFをアップロード」「削除」を出す判定を持つが、これはスナップショット表示時も true になる。**どちらも隠さない**（削除はスナップショットを消して取り直す導線として、アップロードは登録内容のPDF＝プロトコル文書等で差し替える運用として、それぞれ実用上の意味がある）。ただし両ボタンの既定ラベルは「PDF」と明記しており表示中の中身（HTMLスナップショット）と食い違うため、`resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'` のときだけラベルをスナップショット向けの文言に差し替える。HTMLの既定ラベルは初回呼び出し時に記憶しておき、通常のPDF経路（registration行以外）では一切変えない
  - **`handleDeletePdf()` の後始末は必ず `updateToolbarMode()` に委ねる（PR #124 レビュー指摘4）**: 以前は `finally` で `delBtn.textContent = 'PDFを削除'` を直接ハードコードしており、`updateToolbarMode()` が設定したスナップショット向けラベルを削除失敗時に打ち消してしまっていた（スナップショットが表示されたままボタンだけ通常PDF向けラベルに戻る）。`finally` では `delBtn.disabled = false` のみ行い、ラベルの復元は `updateToolbarMode()` の呼び出し1本に一元化した（`defaultDeleteBtnLabel` を記憶しているため成功/失敗どちらのケースでも正しく出し分けられる）。判定（`resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'`）は `currentRef.fulltext_url`/`fulltext_status` を書き換える**前**、関数の先頭で行う（削除処理中に状態を変えるため、後回しにすると常に非スナップショット扱いになる）
  - **`window.confirm()` の文言もスナップショット表示中は出し分ける**: `resolveFulltextDisplayMode(currentRef) === 'registry_snapshot'` のときだけ `fulltext_snapshotDeleteConfirm`（ja/en 追加済み）を使い、それ以外は従来の「このPDFをDriveから削除します」のまま
  - **既定ラベルのHTML i18n化は調査済み・未実施（本PRのスコープ外と判断）**: `src/lib/i18n.ts` に `data-i18n`/`data-i18n-title` 等を読んで `applyI18n()` で置換する仕組みが存在し `popup.html`/`sidepanel.html` では使われているが、`fulltext.html` は `data-i18n` 系属性を一切使っておらず `fulltext.ts` も `t()` しかimportしていない（`applyI18n()` 未呼び出し）。つまりこの2ボタンの既定ラベル（HTMLへ直書きした日本語）だけを `data-i18n` に乗せても、フルテキストビューア全体でこの仕組みを初めて使うことになり影響範囲が読めない。そのため既定ラベルは日本語ハードコードのまま据え置き、enロケールのユーザーには「スナップショット表示中は英語ラベル、通常PDF表示中は日本語の既定ラベル」という非対称が残る（HTMLのi18n基盤をフルテキストビューアへ新設するのは別スコープ）

### 試験登録レコードの論文候補探索（Publication_Candidates タブ）

registration行から「その試験の結果論文（linked publication）」の候補を発見し、`Publication_Candidates` タブへ保存する（レジストリ連携フェーズ1チャンク2パスB、Issue #118）。**この探索パス自体は候補の保存までで、References への行追加は一切行わない**（候補の表示・取り込みはチャンク3で実装済み。下記「論文候補の取り込み（Referencesへの追加）」参照。**References に行を追加する経路をこの探索パスに作らないこと** — 取り込みは必ず「取り込む」ボタンの明示操作を経由する。詳細は次項）。

- 探索ロジックは `src/lib/publication-suggest.ts`（UI非依存）の `discoverPublicationCandidates()`。3戦略を**直列**で実行する（PubMed E-utilities がAPIキー無しで3 req/s上限のため並列にしない）:
  1. `ctgov_reference`: `fetchCtgStudy()` が返す `pmids`（CTGov `referencesModule` 由来。呼び出し側が渡す。fetch不要）。`referencesModule.references` は `type` が `BACKGROUND`/`RESULT`/`DERIVED` に分かれており、`fetchCtgStudy()` 側で `type`（trim・大文字化）が `'BACKGROUND'`（試験結果と無関係な背景文献）の参照だけを除外する（PR #122 レビュー指摘1、Issue #118 チャンク2）。`RESULT` のみのallowlistにはしていない: `DERIVED` は「PubMed側がそのNCT番号を参照している論文」で結果論文の主要な供給源、`RESULT` はスポンサーが手動登録した分しか入らないため、allowlistだと取りこぼしが大きい。`type` 欠落・未知の値（将来API側に新種別が増えた場合を含む）は残す側に倒す（後方互換）。同一PMIDが複数の参照エントリに現れる場合は重複排除し元の出現順を保つ
  2. `pubmed_id`: esearch（`buildPubmedIdQuery()` が組み立てる `"<試験ID>"[si] OR "<試験ID>"[tiab]` クエリ）
  3. `europepmc`: Europe PMC で検索（jRCT/UMIN 等、NCT以外にも有効）。1回目は抄録限定 `ABSTRACT:"<試験ID>"`（`buildEuropePmcQuery()`）で検索し、1回目が**成功して**0件のときだけ2回目として従来の全文検索 `"<試験ID>"` へフォールバックする（1件以上ヒットすれば2回目は発生させない。1回目が失敗＝非200・JSON不正・ネットワーク例外の場合はフォールバックせずこの戦略をスキップして空配列を返す。失敗を「0件だった」と同一視して広い全文検索へフォールバックすると、落ちているサービスへの負荷が倍になるうえ一過性の失敗から拾ったノイズ候補が Publication_Candidates シートへ永続化されてしまうため）。ClinicalTrials.gov/UMIN-CTR/ISRCTNの3レジストリ×各12試験=36ペア（PubMedの`[si]`から作った正解ペア、発行年2015-2022限定。索引ラグで recall が0に潰れるのを避けるため）で実測したところ、全文検索一本（旧実装）は recall 86%（31/36）・平均ヒット数9.0件だったのに対し、抄録限定+0件時フォールバック案は recall 89%（32/36）・平均ヒット数4.0件だった。全文検索は「本文中で試験IDに言及しただけ」の総説・論説・別試験まで拾ってノイズになる（実例: EOLIA試験(NCT01470703)でEurope PMC由来23件がヒットしたが1件も結果論文ではなかった）。抄録限定・全文検索は単独では recall 86%（31/36）で同値だが、取りこぼす対象が異なる: NCT04112121（正解PMID 40496603）はPubMed抄録に試験の登録番号が書かれていないため抄録限定では0件になり取りこぼすが、全文検索なら1件ヒットして拾える。逆にNCT03719521（正解PMID 38162283）は抄録限定なら17件に絞られ1ページ目に収まり拾えるが、全文検索だと38件ヒットし`pageSize=25`の1ページ目からあふれて取りこぼす。フォールバックを残すのは、この2つの検索方式が互いに違うケースを取りこぼしており、0件時だけ全文検索へフォールバックすることで両方の取り分を得られるため（NCT04112121を拾えるようになる一方、NCT03719521は抄録限定の1回目で既に拾えているためフォールバックは発生せずノイズも増えない）。`TITLE:"<id>"`のOR追加は36ペア中結果が変わったのが0件だったため見送った（試験IDは論文タイトルには出現しない）。`resultType=lite`・`pageSize=25` は両クエリ共通で明示する（pmid/doi/title/journalTitle/pubYearしか使わないため `core`（全文リンク・抄録込みの重いレスポンス）は使わない）。フォールバックの有無にかかわらず `strategy` は両経路とも `europepmc` のまま（新しい戦略値は追加していない）
- 戦略1・2で集めたPMIDの書誌（title/journal/year/doi）は esummary に**1リクエストでまとめて**問い合わせる（PMIDごとに呼ばない）。esearch → esummary の eutils連続呼び出しの間だけ待機を入れる（既定350ms、テストでは`options.delayMs`で注入可能）。esearch/esummaryには `src/lib/fulltext-retriever.ts` の `enrichNcbiIds()` と同じ流儀で `tool: 'tiab-review-plugin'` と（`DiscoverPublicationCandidatesInput.email` が渡されていれば）`email` を申告する（NCBIのE-utilities利用規約）
- 各戦略の失敗（ネットワーク・非200・JSON不正）は例外を投げずその戦略だけスキップする。全滅時は空配列。出版年（`pubYear`/`pubdate`）が非数値の場合は `NaN` ではなく `undefined` にする（シートへ文字列 `"NaN"` を書かないため）
- 統合順は戦略の強い順（`ctgov_reference` → `pubmed_id` → `europepmc`）。`dedupePublicationCandidates()` は候補ごとにPMIDキーとDOIキーの**両方**を見て、どちらか一方でも既出なら重複として捨てる（esummaryでPMIDのみの候補へ後からDOIが補完されることがあるため、片方のキーだけでは同一論文を見逃す）。複数戦略で見つかった場合は先に見つかった側（＝より強い戦略）を残す。続けて `filterAlreadyImportedCandidates()` が既存References行のPMID/DOIと一致する候補を除外する
- CTGov の `referencesModule` 由来PMIDは、`retrieveRegistrationSnapshot()`（フルテキスト取得）が既に `fetchCtgStudy()` で取得済みのものを `FulltextFetchOutcome` の任意フィールド `registryPmids`（`cached`/`linked` のみ。`none` には無い）に載せて渡す。**CTG APIをスナップショット取得と論文候補探索で2回叩かないための配線**
- 呼び出し側は `src/sidepanel/features/fulltext-tab.ts` の一括検索（`handleBulkFetch`）・単発検索（`handleSingleFetch`）。`isRegistrationRecord(ref)` が true の行についてのみ探索する（email には `state.userEmail` を渡す）。UI文言・バッジ・完了サマリは変更していない
  - **一括検索は候補を`savePublicationCandidates()`へ即時保存しない**。registration行1件ごとに保存すると「ensure→全行読み取り→append」がそのまま行数倍のリクエストになり、Sheets APIの読み取りクォータ（ユーザーあたり毎分60読み取り）を容易に超える。既存の `pendingWrites`/`flush()`（fulltext_urlの5件ごとバッチ書き込み）と同じ流儀で `pendingCandidates` をため込み、`flush()` の中でまとめて `savePublicationCandidates()` を呼ぶ。URL書き込みと候補保存は互いに独立した try/catch を持ち、片方の失敗がもう片方を巻き込まない
  - `fulltext_url` の書き込み（`pendingWrites.push()` / `updateReferenceFulltextUrl()`）は、論文候補探索（最大3回のネットワーク往復）より**先に**行う。探索が遅くても本質的なURL保存が後回しにならないようにするため
  - 単発検索（`handleSingleFetch`）は1行だけなので `savePublicationCandidates()` を即時呼び出す（失敗は独立した try/catch で `console.warn` のみ）
- **候補探索は取得状態（`fulltext_status`）から独立して何度でも再実行できる**（PR #122 レビュー指摘2、Issue #118 チャンク2）。`handleBulkFetch`（取得）の中でしか探索が走らない設計だと、registration行はスナップショット保存に成功した時点で `cached` になり二度と対象にならないため、PubMed等の一時障害やSheets書き込み失敗で候補が欠落するとUIから回復する手段が無くなる。対策として `fulltext-tab.ts` に `handleBulkSuggest()`（一括再探索）を独立ルーチンとして追加した:
  - 対象は `getVisibleFulltextCandidateList()` のうち `isRegistrationRecord(ref)` が true の行**全部**。`fulltext_status` は一切見ない（`cached`/`retrieved`/`unavailable`/`not_retrieved` のいずれでも対象）
  - **「候補行が既にあるか」で探索済みを推測する実装にはしていない**（未探索／候補0件／探索失敗を区別できず、候補0件の登録が永久に対象へ残り押すたびに外部APIを叩き続けることになるため）。代わりにユーザーが押したときだけ走る明示的な導線にし、`savePublicationCandidates()` の `filterNewCandidates()`（同一 `ref_id` かつ同一PMID/DOIの候補を除外）による冪等性を根拠に「何度再実行しても Publication_Candidates に重複行が増えない＝安全に繰り返せる」としている
  - NCTのときだけ `fetchCtgStudy()` を1回呼ぶ（取得時の `outcome.registryPmids` が手元に無い独立経路のため自前で取得する。既存の「取得と探索でCTG APIを2回叩かない」配線＝`retrieveRegistrationSnapshot()` → `outcome.registryPmids` は変更していない）。失敗時（`null`）は `ctgPmids: []` で続行する
  - `handleBulkFetch` と同じ `bulkRun` ガード・中止ボタンを共有するため、取得と再探索は同時に走らない
  - NCT判定・CTG呼び出し可否・`discoverPublicationCandidates()` 呼び出しの結合部分は `src/lib/publication-candidate-rerun.ts` の `discoverCandidatesForRerun()`（UI非依存の純関数、fetchCtg/discoverCandidatesを引数注入してテスト可能）に切り出している
  - 起動導線は `sidepanel.html` の `.fulltext-fetch-row` にあるボタン `#fulltext-suggest-btn`（`dom.ts` では `dom.fulltextSuggestBtn`。`getElement()` は要素が無いと例外を投げるため `sidepanel.html` に必ず存在させている）。`renderRetrievalSummary()` が registration行の件数でラベル（`fulltext_suggestBtn`）を更新し、件数0なら `hidden`、`bulkRun` 実行中（取得・再探索のどちらでも）は `disabled` にする。i18nキーは `fulltext_suggestBtn`/`fulltext_suggestProgress`/`fulltext_suggestDone`/`fulltext_candidateSaveError` の4本を追加した（ja/en両方）。候補そのものの表示・バッジ・取り込みはチャンク3のスコープのままで、このPRで足したUIは探索を起動するボタン1つだけ
- **保存失敗時にバッファを捨てない**（PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点））。以前の `handleBulkFetch` の `flush()` は `pendingCandidates.splice(0)` してから保存していたため、保存失敗の瞬間にバッファごと候補が消え `console.warn` にしか残らなかった。`src/lib/publication-candidate-rerun.ts` の `flushCandidateBuffer()`（コピーを渡して保存 → 成功時のみ `splice` で取り除く汎用ヘルパー）に統一し、`handleBulkFetch`・`handleBulkSuggest` の両方で使う。失敗時はバッファを保持し次のflush（5件ごと or 最終）で再送する。ただし `handleBulkSuggest` 側は閾値を5固定にすると、失敗でバッファが保持されたままになる都合で以降のループが毎行flushを呼び直してしまう（Sheetsが落ちている間、1行につき1回ずつ ensure→読み取り→append を空振りさせることになる）。そのため次の閾値を `nextCandidateFlushThreshold()`（成功なら基準値5、失敗なら「現在のバッファ長+5」を返す純関数）で決め、失敗したらさらに5件たまるまで再試行しない。ループ終了時の最終flushでも失敗して候補が残っている場合は `console.warn` だけで終わらせず `showToast()`（`fulltext_candidateSaveError`）で未保存件数を通知する。`pendingWrites`（`fulltext_url` の書き込み）側の挙動は変えていない（既に別try/catchでトーストを出している）
- 永続化は `src/lib/sheets-api.ts` の `savePublicationCandidates()`。ensure → 既存行を読んで（`ensurePublicationCandidatesSheet()` を再度呼ばない内部専用の読み取りヘルパー経由）`filterNewCandidates()`（同一 `ref_id` かつ同一PMID/DOIの候補を除外）→ 残りを追記。**一括検索を2回流しても行が重複しない**ことがこのフィルタの目的。`getPublicationCandidates()`（チャンク3向けの公開読み取りAPI）は ensure してから読む従来どおりの実装のまま
- `Publication_Candidates` タブのヘッダー（この順）:

  | 列名 | 説明 |
  | --- | --- |
  | candidate_id | 候補ID（UUID） |
  | ref_id | 発見元のregistration行（References への FK） |
  | trial_id | `extractTrialId()` で取れた試験ID |
  | pmid | 候補論文のPMID（無ければ空） |
  | doi | 候補論文のDOI（無ければ空） |
  | title | 候補論文のタイトル |
  | journal | 候補論文のジャーナル名 |
  | year | 候補論文の出版年 |
  | strategy | `ctgov_reference` / `pubmed_id` / `europepmc`（詳細は表の下） |
  | status | `suggested` / `imported` / `dismissed`。`imported`/`dismissed` への更新は `sheets-api.ts` の `updatePublicationCandidateStatus()`（チャンク3）が担う |
  | suggested_at | 発見日時（ISO 8601） |
  | decided_by | 決定者（email）。`updatePublicationCandidateStatus()` が書く（チャンク3） |
  | decided_at | 決定日時（ISO 8601）。同上 |
  | imported_ref_id | 取り込んで新規作成したReferences行の `ref_id`（`imported` のときのみ）。同上 |

  **`strategy` 列の想定外の値への備え**: `readPublicationCandidatesRows()`（`sheets-api.ts`）はこの列を `value as PublicationCandidateStrategy` と無検証キャストで読むため、ユーザーがセルを直接編集/削除すると想定外の値が入りうる。`publication-candidate-panel.ts` の `STRATEGY_ORDER` 参照（並び替え用）と `publicationCandidateStrategyLabelKey()`（表示ラベル用）はどちらもこれに備えたフォールバックを持つ: 前者は未知の戦略を `Number.MAX_SAFE_INTEGER` 扱いにして末尾へ寄せる（素の `undefined - undefined` はNaNになりsortの結果が実装依存になるため）、後者は `pubCandidate_strategyUnknown` を返す（default分岐が無いとundefinedを返しUIに文字列"undefined"がそのまま出る）。PR #124 レビュー指摘4

- **タブ欠落時の自動作成・列欠落時の末尾追記は `ensurePublicationCandidatesSheet()` が担う。`ensureLlmRunsSheet()` と完全に同じ ensure パターン**（ヘッダー欠落は末尾へ追記、タブ欠落は `addSheet` → ヘッダー append、それ以外の例外は再送出）
- **列は末尾追記のみ**の規約（References/Decisions/LLM_Executions と同趣旨）。新しい列は必ず配列の末尾に足し、`src/demo/seed.ts` の `PUBLICATION_CANDIDATES_HEADERS` ミラーも必ず追従させること（`tests/publication-candidates-headers.test.ts` がドリフトを検出する）
- ステータス更新（`imported` / `dismissed`）・候補のReferencesへの取り込みはチャンク3で実装済み（`src/lib/publication-import.ts` / `src/lib/publication-candidate-panel.ts` / `src/sidepanel/features/fulltext-publication-candidates.ts`。下記「論文候補の取り込み（Referencesへの追加）」参照）

### 論文候補の取り込み（Referencesへの追加）

候補（`Publication_Candidates` の1行）をReferencesへ実際に取り込む処理（レジストリ連携フェーズ1チャンク3、Issue #118 実装内容7・8）。**References に行が追加される経路は、`src/sidepanel/features/fulltext-publication-candidates.ts` の「取り込む」ボタン（`handleImportCandidate()`）だけ。** 一括検索・再探索・自動処理からは1行も追加しない（探索パス側の制約は上記「試験登録レコードの論文候補探索」参照）。

- 行の組み立ては `src/lib/publication-import.ts` の `buildImportedPublicationReference()`（UI非依存の純関数。`crypto.randomUUID()`/`new Date()` は呼ばず、呼び出し側から `refId`/`importedAt` を注入する）が担う。`record_type='article'`（確定値）、`related_ref_id`＝発見元registration行の `ref_id`、`source`＝`Registry linkage (試験ID)` 形式（試験IDは registrationRef から `extractTrialId()` で取る。取れない場合は `buildRegistrySnapshotHtml()` の「(不明)」表記に合わせて `Registry linkage (不明)` とする）、`dedupe_key` は `import-helpers.ts` の `generateDedupeKey()` をそのまま使う（重複実装しない）。`url` は `src/lib/external-record-url.ts` の `buildDoiUrl()`/`buildPubmedUrl()` で組み立てる（doi優先→pmid→どちらも無ければ空文字。`fulltext-tab.ts` の `recordPageUrl()` と同じ規則を再利用しており、あちらもこの2関数を呼ぶ薄いラッパーに切り出し済み）。`screening_set` は発見元registration行の `screening_set` を担当割り振りの状態で分岐せず無条件でコピーする（空でコピーすると担当割り振り済みプロジェクトで `getReferenceAssignmentSet()` が `'unassigned'` と解決し、非管理者の `state.references` から取り込み行が丸ごと落ちるため。PR #124 レビュー指摘1）
  - **この `screening_set` コピーの帰結（ユーザーが明示的に選んだ設計）**: 取り込んだ論文行は発見元registration行と**同じ担当グループのTiAbスクリーニングキューに未判定として並ぶ**。`src/lib/team-progress.ts` の `computeTeamProgress()` は `refs.filter((r) => assigned.has(refSetOf(r)))` で各メンバーの `tiabTotal`（TiAb分母）を数えるため、**そのグループの担当者のTiAb分母が取り込み件数だけ増え**、誰かが実際にTiAb判定するまで未消化のまま残る。検討した代替案は「`screening_set` を空（`unassigned`）のままにし、代わりに `related_ref_id` 非空の行を担当フィルタの対象外にする」というものだった。`unassigned` は既に「誰の担当セットでもない＝進捗の分母にも入らない」と定義されている（`src/sidepanel/features/assignment.ts` の `describeSetReviewers()` 参照）ためTiAb分母は動かないが、担当フィルタの意味論に例外（「`unassigned` だが表示だけはされる」）を持ち込むことになる。**前者（無条件コピー）を採用したのはユーザーの明示的な選択であり、「取り込んだ論文も人がTiAb判定すべき対象である」という判断に基づく。** `fulltext_set` を `resolveImportedFulltextSet()` でコピーしている既存実装（次の箇条書き）とも対称的な設計
- 取り込み後、担当割り振りが `configured` のときだけ registration行の `fulltext_set` を新規行へコピーする。コピーすべき値の判定は `src/lib/publication-import.ts` の `resolveImportedFulltextSet()`（純関数）に切り出してあり、実際の書き込み（`updateReferenceFulltextSets()`）は呼び出し側が行う
- `handleImportCandidate()` の実行順序:
  1. **重複チェック**: `state.allReferences`（担当フィルタ前の全件）を押した瞬間にもう一度見て、同一PMIDまたは同一DOIの行が既にあれば、Referencesへ行を追加せず候補を `dismissed` にして終了する（探索時点の `filterAlreadyImportedCandidates()` とは別に、探索から取り込みまでの間に References が変わりうるため、押した瞬間にもう一度見る必要がある）。担当フィルタ済みの `state.references` を見ると、非管理者が「他のレビュアーが既に取り込んだ論文」を検出できず二重取り込みしてしまう（PR #124 レビュー指摘2）。判定は `src/lib/publication-candidate-panel.ts` の `isPublicationCandidateAlreadyImported()` が `filterAlreadyImportedCandidates()`（`publication-suggest.ts`）を最小限のシム経由で再利用する（判定ロジックを独自実装しない）
  2. `crypto.randomUUID()`/`new Date().toISOString()` を呼び出し側で用意し `buildImportedPublicationReference()` へ注入 → `addReferences()` で1行追加
  3. `resolveImportedFulltextSet()` が非空を返すときだけ `updateReferenceFulltextSets()` で新規行の `fulltext_set` を書く（空文字を書きに行く無駄なリクエストは出さない）
  4. `updatePublicationCandidateStatus()`（`sheets-api.ts`）で候補を `imported`/`decided_by`/`imported_ref_id` に更新
  5. `reloadReferences()`（`fulltext-ai.ts`）で state を更新
  6. 新規行に対して単発OA検索を自動起動する（`fetchSingleFulltextForRef()`。`handleSingleFetch()` からボタン要素前提の見た目更新を切り離して独立させた関数）。この関数は内部の catch で例外を握りつぶし正常returnするため、呼び出し側は戻り値（`Promise<boolean>`。成功=true）で失敗を検出する。取り込みフローからは `{ reloadCandidates: false, suppressErrorToast: true }` を渡し、内部の `fulltext_sheetSaveError` トーストを止めて、失敗を7の完了トーストへ一本化する（PR #124 レビュー指摘3。ボタン起点の `handleSingleFetch()` は options を渡さないため従来どおり内部トーストが出る）
  7. 候補キャッシュ（`fulltext-tab.ts` のモジュールローカルキャッシュ）を再読込・再描画する
- **部分失敗への備え**: 手順2（`addReferences`）が成功した直後に、候補ID→新規`ref_id`の対応を `fulltext-publication-candidates.ts` のモジュールローカルMap（`importedRefIdByCandidateId`）へ記録する。その後3〜6のいずれかが失敗して候補が `status='suggested'` のまま残っても、同じ候補へ再度「取り込む」を押されたときはこの記録を最優先で見て、`addReferences()` を呼び直さず（＝Referencesへの二重追加を避け）記録済みの `ref_id` で残りのステップだけをやり直す。4（ステータス更新）に成功すればこの記録は不要になり削除する。この記録が無い場合（例: ブラウザ再起動でモジュール状態が失われた）でも、1の重複チェックが References 上の同一PMID/DOIを検出するため二重追加そのものは常に防がれるが、その場合候補は `dismissed` として決着する（誰がいつ取り込んだ行か特定できず `imported_ref_id` を安全に紐付けられないため。行自体は失われない）
- **「ステータス更新(4)は成功したが fulltext_set 更新(3)が失敗した」場合には復旧導線が無い。** 候補は `imported` になりパネル・バッジから消えるため、UIから「担当グループが未設定のまま」に気付いて再操作する手段が構造的に無い。実害は `fulltext_set` が空のままになることに限られる（`related_ref_id` が非空のため、フルテキスト候補一覧・共有分母には引き続き載る＝候補自体を見失うわけではない。次の箇条書き参照）。管理者が手動で担当割り振りを再生成するか、シートを直接編集するしかない
- 完了トーストの「もう一度『取り込む』を押すと再試行できます」という案内は、それが実際に成り立つ場合（手順4のステータス更新自体が失敗して候補が `suggested` のまま残っている）だけに出す。手順4が成功して候補がパネルから消えるケースでは別の文言（再試行を促さない）を出す（`pubCandidate_importPartialRetryable` / `pubCandidate_importPartialNoRetry`）。多段階処理の完了メッセージを作るときは、それぞれの失敗パターンで案内の内容が実際に成り立つかを個別に確認すること（この教訓は「取り込む」経路だけでなく「対象外」経路にも及ぶ。下記 `handleDismissCandidate()` 参照。PR #124 レビュー指摘6ではこの教訓が「対象外」側に反映されておらず「取り込む」側だけ直っていた）
- 「対象外」ボタン（`handleDismissCandidate()`）は `updatePublicationCandidateStatus()` を `status='dismissed'` で呼ぶだけで References には一切触れないが、2点のガードを持つ:
  - **`importedRefIdByCandidateId` に記録がある候補は対象外にできない**（PR #124 レビュー指摘5）。上記「部分失敗への備え」の状態（`addReferences()` は成功したが手順4のステータス更新が失敗し候補が `suggested` のまま）でこのガードが無いまま「対象外」を押すと、`imported_ref_id` が空のまま `status='dismissed'` が書かれ、既に作られたReferences行を指す候補が消える。その行はPublication_Candidatesから辿れなくなる一方、`related_ref_id` は非空のためフルテキスト候補一覧・共有分母には載り続け孤児化する。記録があればシートへ書き込まずに中断し `pubCandidate_dismissBlockedAlreadyAdded` トーストで「取り込む」を押し直すよう促す
  - **ステータス更新と `reloadPublicationCandidates()` を別tryに分ける**（PR #124 レビュー指摘6）。1つのtryで包むと、書き込み自体は成功したのに再読込だけ失敗したケースでも `pubCandidate_dismissError`（「対象外への更新に失敗しました」）が出て事実と異なる報告になる。ステータス更新が成功したかを別フラグで持ち、再読込のみ失敗したときは `pubCandidate_dismissReloadFailed`（「対象外にしました（一覧の再読込に失敗しました）」）を出す。**この再読込失敗トーストの発火経路は後続ターンで実際に到達可能になった**: `fulltext-tab.ts` の `loadPublicationCandidates()` は当初、内部で自分のエラーを `console.warn` するだけで再送出しない実装だった（`createAsyncCoalescer` の factory 自身がtry/catchで握りつぶすため）ため呼び出し元から失敗を検出できなかったが、`Promise<void>` → `Promise<boolean>`（成功/読み込み不要=true、Sheets読み込み失敗=false）へ改め、`suppressErrorToast?: boolean`（既定false）オプションを追加した。既定では失敗時に自前で `fulltext_candidateLoadError` トーストを出すが、`handleDismissCandidate()` は `{ suppressErrorToast: true }` を渡してこれを止め、戻り値が `false` のときだけ `pubCandidate_dismissReloadFailed` を出す（try/catchによる検出から戻り値による検出へ変更）。`deps.reloadPublicationCandidates` の型もこれに合わせて `(options?: { suppressErrorToast?: boolean }) => Promise<boolean>` にした
- **`related_ref_id` が非空の行は無条件でフルテキスト候補になる**（実装内容9）。取り込んだ論文行はTiAb票を一切持たない（通常のTiAbスクリーニングを経ないため）ので、`fulltext_set`・プールルール・TiAb Include票のいずれで判定してもフルテキスト候補プールから落ちてしまう。`src/lib/fulltext-candidates.ts` の `isFulltextCandidateRef()` / `isProjectFulltextCandidateRef()` / `isSharedFulltextPoolMember()` はいずれも、`related_ref_id` が非空なら（poolRule評価より先に）無条件で候補として扱う分岐を持つ。`isSharedFulltextPoolMember()` はIssue本文が名指ししていない（他の2関数のみ名指し）が、「全員で一致すべき分母」という要件と矛盾しないため（`related_ref_id` の非空はユーザー非依存の属性）同じ扱いにした
  - **落とし穴（実際に踏んだ）**: 上記3関数の引数型は `ref: Pick<Reference, 'fulltext_set' | 'related_ref_id'>` のように `Reference` を絞り込んだ型を取る。チーム進捗集計用の `src/lib/team-progress.ts` の `TeamProgressRef`（`Reference` をさらに絞り込んだ最小形）が最初 `related_ref_id` を持っておらず、`src/sidepanel/features/team-progress.ts` 側で `ReferenceWithStatus` から `TeamProgressRef` を組み立てる2箇所が `related_ref_id` を運んでいなかった。`Pick<Reference, ...>` はoptional同士だと構造的に適合してしまうため、`related_ref_id` を落とした絞り込み型を渡してもtypecheckは通ってしまい（コンパイラはフィールドが無いことを検出できない）、`isSharedFulltextPoolMember()` の分岐は本番で一度も発火しなかった。詳細・一般化した教訓は下記「テスト・作業ツリーの落とし穴」参照

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
- **flush の直列化**: `src/sidepanel/utils/offline-queue.ts` の `flushDecisionQueue` は queueKey（spreadsheetId::userEmail）ごとにコールセーサーで直列化する。flush 中に新たに `enqueueDecision` された項目は、書き戻し時にキューを再読込してから送信済み分だけを取り除く実装のため消えない。合流した呼び出しは同じ結果（最後の失敗 `lastError` を含む）を受け取るため、対話的flushとバックグラウンドflushが合流しても失敗種別がどちらの呼び出し元にも届く（PR #138 レビュー指摘対応）
- **読み込み時の反映**: `loadDataAndShowScreening`（`src/sidepanel/features/project.ts`）はサーバから取得した文献一覧に、`getQueuedDecisions` で読んだ未送信キューを `src/lib/queued-decisions-merge.ts` の `mergeQueuedDecisions`（純関数）で重ねてから画面へ渡す。オフラインキュー退避中の判定はサーバ側（Decisionsタブ）にまだ書き込まれていないため、これをしないと再読み込みのたびに「未評価」に戻って見えてしまう。読み込み時のマージは、キー開封後は `detectConflict`（`sheets-api.ts`、`export` 済み）で不一致状態（`hasConflict`/`status`）も再計算する（PR #138 レビュー指摘対応）
- **未送信バッジ**: `src/sidepanel/features/unsent-queue.ts` がツールバーの未送信件数バッジ（クリックで送信。認証切れなら対話的な再ログインを挟んで1回だけ再試行）と、判定保存の共通ロジック（`saveDecisionOrQueue`）を提供する。TiAb判定・ML確認判定の両方（`screening/actions.ts` / `ml/actions.ts`）がここへ委譲する
- **保存失敗の分類**: `src/lib/save-failure.ts` の `classifySaveFailure` が保存失敗を `'auth'`（ログイン切れ、再ログインで直る可能性がある）/ `'offline'` / `'other'`（権限不足等、再ログインでは直らない）に分類する。判定クリック直後の保存失敗が `'auth'` の場合はキューへ積む前にその場で再ログインを試し、成功すれば1回だけ保存を再試行する
- **2026-09 事故の要約**: Web版（GIS認証、トークンはメモリ上で1時間のみ）でログイン切れ後の判定保存が軒並みオフラインキューへ退避される一方、ユーザーはそれに気づかず判定を続け、退避先のブラウザプロファイルで264件が滞留した。加えて、この滞留を解消しようとした複数回の flush が並走し、60秒TTLのスナップショットキャッシュを超える間隔で同一判定が再送されたことで、197件が重複追記（393行）された。上記の直列化・画面反映・バッジ・分類はこの事故の再発防止として追加したもの

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
- **合議モード**: 合議モード（`-human-consensus` サフィックス）ONで保存した判定も、human判定として同じ追記専用経路（常に `append`）に乗る。追記専用経路に相乗りするだけなので、通常判定と別の保存フローを持たない

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
- **合議モード（`-human-consensus` サフィックス、下記「合議判定の構造化マーク」）を使うと、`decided_at` による
  前後判定というヒューリスティックに頼らず、合議での判定変更を `client_version` から正確に識別できる**。
  下記R例のフィルタ `grepl("-human", client_version)` は `-human-consensus` の行も含むため、合議後κ（全行対象）
  はそのままで問題ない。合議前κだけに絞りたい場合は、さらに `!grepl("-human-consensus", client_version)` を
  かけて合議モードの行を除けばよい

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

#### Drive直接取り込みの「取り込み済み」判定は二段構え（Issue #73 Phase 2・変更禁止）

`drive.file` スコープでは他人が作成したDriveコピーが見えないため（上記参照）、「このソースPDFは取り込み済みか」の真値をDriveの`appProperties`だけに置くと、コピー作成者本人以外からは常に「未取り込み」に見える（Issue #71 症状1・2）。そのため真値は References シートへ移し、`appProperties` はベストエフォートの補助情報として残す二段構えにしている。

| 問い | 真値の置き場 | 有効範囲 |
| --- | --- | --- |
| このソースPDFは取り込み済みか | References の `fulltext_drive_source_id`/`fulltext_drive_copy_id`（W/X列） | 全メンバー |
| 再利用できるコピー実体があるか | Drive の `appProperties`（sourceFileId/refId/spreadsheetId） | コピー作成者本人のみ（中断復帰用） |

**`appProperties` は廃止できない**: 真値をSheets単独にすると `reuse-and-update`（`files.copy` 成功→シート更新前に中断、からの再開）が成立しない。source IDを書くのも「シート更新」の一部なので、同じ中断点でsource IDも一緒に失われ、中断のたびに新規コピーが1つ増えてしまう。「files.copy は成功したが Sheets 更新は失敗した」という部分障害の間は `appProperties` だけが手がかりという残存制約は変わらない。

- **書き込みは `T:U` と `W:X` の2つの非連続レンジを同一 `values:batchUpdate` に積む（`fulltext-drive-write.ts`）。`T:X` の連続レンジにしてはならない**（V列 `fulltext_set`＝フルテキスト担当割り振りを消してしまう）
- **`updateReferenceFulltextUrl(s)` の `driveSource` は必須引数**。Drive直接取り込みだけが実値を渡し、残り9経路（OA取得・手動アップロード・リンクPDF自動保存・PDF削除等）は必ず `null` を渡してW/Xをクリアすること。**クリアし忘れると、Drive側 `findImportedCopy` のクエリが持っていた `trashed=false` の暗黙保証がシート側の真値には無いため、ゴミ箱にあるコピーを「取り込み済み」と誤判定する**
- **クレームの自己検証**（`drive-import-claim.ts` の `isFulltextClaimValid`）: シートのクレームが有効なのは `status === 'cached'` かつ `fulltext_url` 非空 かつ `extractDriveFileId(fulltext_url) === fulltext_drive_copy_id` の3条件をすべて満たすときだけ。旧バージョンの拡張は `T:U` しか書かずW/Xをクリアしないため、「誰かがDrive取り込み→旧版ユーザーがOA取得や差し替えでPDFを交換」という自動更新ラグ中の操作で「別PDFのURL＋古いsource ID」が同じ行に共存しうる。URLとコピーIDの食い違いでそうしたクレームは自動的に失効する
- **W/X書き込み前のヘッダー検証**（`validateFulltextDriveHeaders()`、spreadsheetId単位でメモ化）。ユーザーが独自の23列目以降を足していた場合、Drive直接取り込みはfail-fastでエラー、それ以外の経路はW/Xをスキップして`T:U`だけ書く（独自データを空文字で壊さないため）。**`ensureHeaders`（`sheets-api.ts`）は目的の異なる別関数 `validateReferencesManagedHeaders()` で同様にガードする**（PR #105 実機確認で発覚した回帰の修正）。2つ要るのは目的が違うため:
  - `ensureFulltextDriveColumnsOnce`（`updateReferenceFulltextUrls` の前段）側は、フルテキストページ（`src/fulltext/fulltext.ts`）がサイドパネル接続時の `ensureHeaders` を経由しないための、W/X書き込み前の唯一の保証経路
  - `ensureHeaders` 側は、**ユーザー独自のヘッダー名を改名しない**ための保護。列数に関わらず常に `validateReferencesManagedHeaders()`（検証対象は `REFERENCES_MANAGED_TAIL_START_INDEX`＝22＝W列以降から、終端は `REFERENCES_HEADERS.length`（配列長から導出。現在26列 = Z列まで）まで）を実行し、衝突があれば列名・期待値・実際値を警告してPUTしない。衝突がなく、かつ列数も足りているときだけPUTする。もともとW/X列（index 22/23）限定の検証だったため、record_type/related_ref_id（Y/Z列）追加時にこの検証が追従しておらず同じ穴が再発した（25列シート＝独自1列足し：`25 < 26`で「不足」分岐に入るが旧検証はW/Xしか見ず通過し独自列を無警告で改名／26列シート：列数一致で「移行済み」誤判定となり検証自体が走らない）。検証範囲を配列長から導出する形に一般化したので、以後は末尾に列を足すだけなら呼び出し側の追従は不要。ただし `REFERENCES_MANAGED_TAIL_START_INDEX` は「後付け列はここから始まる」という前提そのものであり、列の**途中挿入**をすればこの前提が崩れる（「データ設計 > スプレッドシート構造」の**References も列は末尾追記のみ**の規約を守ること）
  - **検証は `ensureHeaders` のヘッダー行書き込みの前に置くこと**。後に置くと自分が改名した結果を検証することになり、常に一致して素通りする
- **表示用3値判定は純関数化**（`drive-import-classify.ts` の `classifyDriveImportState`）。逆引きを `state.references`（非管理者では担当分に絞られている）から全行スナップショット（`getFulltextClaimsSnapshot`）へ移し、担当外文献へ取り込まれたPDFが「未完了」と誤表示される既存バグを修正した。判定順2のフォールバックはW列が空の行も引けるようref_id起点のマップ（`byRefId`）を使う（本Issue以前に取り込まれた既存ファイルがすべて該当するため、source ID起点のマップだと誤って未完了になる）。Picker で選択が確定した直後にクレームのスナップショットを1回だけ取り直す（`state.allReferences` はロード時のスナップショットのため）。ファイルごとに取り直すとN+1になる
- **1つのソースPDFを2件目の文献へ対応付けることはできない**（表示フェーズの仕様。PR #105 レビュー指摘3の確定）。`classifyDriveImportState` の判定順1は「有効なクレームが**1件でも**あれば done」なので、既にどこかの文献へ取り込まれたソースPDFは対応付けモーダルで候補から外れる。本Issue以前からコピー作成者本人には掛かっていた制限（自分のコピーが `findImportedCopy` で見つかる→already-done→done→除外）を全メンバーへ揃えた結果であり、作成者以外は「他人のコピーが見えない」バグの副作用として対応付けできていたにすぎない
  - データ層（`FulltextClaimsSnapshot.bySourceId`）がクレームを**配列**で持つのは、同一sourceへの複数対応付けを表示フェーズで支援するためではなく、**無効化された古いクレームに紛れた有効なクレームを取りこぼさないため**（実行フェーズの `resolveImportAction` は別文献への `copy-and-update` を今も許容しているため、同一sourceの重複行はデータとして成立しうる）
  - 2件目へ対応付け直したい場合の逃げ道は「先に1件目の文献のフルテキストPDFを削除する」（削除経路が `driveSource: null` でW/Xをクリアするためクレームが消え、再び `none` として選べるようになる）。**この逃げ道はUIから案内すること**（`fulltext_importAlreadyMappedNotice`。done行は対応付け候補から外れるため、取り込み先の文献名と手順を出さないと画面上は行き止まりに見える）
- **バックフィル（`shouldBackfillDriveColumns`）は実行フェーズのみ**（表示フェーズからは書かない）。表示判定はロード済みスナップショット依存で、判定と書き込みの間に他ユーザーがPDFを削除・差し替えると古いsource IDを新しいPDFに結び付けてしまう。Sheetsの原子性は1リクエスト内のみでread-check-writeのCASにはならない。条件は `status===cached`・`appProperties.refId` 一致・URL一致の3つが揃い、かつW/Xが空のときだけ
- **後方互換**: 新規取り込み分は修正後から一貫して記録できる。既存分はコピーを検索できるユーザー（主に作成者）による段階的バックフィルで埋まっていく。作成者が不在の既存コピーは自動復元できない可能性がある

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
6. リリースは `npm run release`（バージョンバンプしてローカル commit + ストア用ビルド + `dist.zip` 作成）。機能追加時は `npm run release:major`

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

**CI ゲート**: `.github/workflows/build-check.yml` が PR ごとに次の5つを実行し、どれかが落ちるとマージ不可になる。ローカルでも同じ5つを通してから PR を出すこと。CI には `.env` が無いため、`npm run dev` / `npm run dev:web` の2ステップだけ `ALLOW_NO_AUTH=1` を指定してビルド疎通確認に限定している（`.env` があるローカルでは不要）。

```bash
npm run typecheck && npm run lint && npm run test
ALLOW_NO_AUTH=1 npm run dev && ALLOW_NO_AUTH=1 npm run dev:web
```

### 過去のレビュー指摘をコメントで参照するときの書き方

**「なぜこうなっているか」をコメントに残すときは、必ず PR 番号か Issue 番号でアンカーすること**（`PR #122 レビュー指摘2`、`Issue #118 チャンク2`）。既存コードもこの形になっている（`src/sidepanel/features/fulltext-ai.ts` の `PR #102 レビュー指摘`、`tests/ensure-headers-drive-columns.test.ts` の `PR #121 レビュー指摘対応`）。

- **裸の通し番号（`修正2`・`指摘2b` など）を書かないこと。** レビュー依頼やタスク分解の中だけで通じる番号は、マージされた後のコードでは何も指さない。読み手は元のやり取りを持っていないので復元もできない
- **この漏れは「指示の側が項目に番号を振ったとき」に起きる。** 実例: PR #122 のレビュー対応で、指示文の `修正1`〜`修正3` という通し番号がそのままコメントとテスト見出しへ写り、7ファイル分を差し戻して書き直した。番号付きの指示を受けて実装するときは、コメントに落とす前に PR/Issue 番号へ言い換えること
- **枝番（`2b` など）も使わない。** 指摘の内容を短く言い添える（`PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点）`）。元のレビューに `2b` という項目が存在しないことすらある
- Issue 番号だけで足りるように見えても **PR 番号を併記しておく**と、後から `gh pr view <n>` で当時の議論と差分の両方に辿り着ける

### テスト・作業ツリーの落とし穴

- **`tests/tsconfig.json` の `types` は明示列挙**（`node` / `chrome` / `google.accounts`）。新しい ambient 型に依存するテストを足すと `Cannot find namespace` で `npm run test` が落ちるので、型の追加もセットで行うこと。`include` も明示列挙だが、テストから import したモジュールは推移的に取り込まれるため、通常は `types` 側だけが問題になる。
- **`.gitignore` の `node_modules/` は末尾スラッシュ付きでディレクトリにしかマッチしない。** `git worktree` を作って `node_modules` をシンボリックリンクで共有すると untracked のまま残り、`git add -A` でコミットへ混入する。worktree で作業するときは変更ファイルをパス指定でステージすること。
- **`.tmp/tests` は掃除されない。** `npm run test` は `.tmp/tests/tests/*.test.js` を glob で拾うため、削除済みブランチのテストがコンパイル済みのまま残っていると件数が水増しされる（実例: `auth-pkce.test.js` が残って 392 件と表示されたが、真値は 379 件だった）。件数が合わないときは `tests/*.test.ts` の数と突き合わせること。
- **`node:assert/strict` の `deepEqual` は「値が `undefined` のプロパティ」と「プロパティ自体が無い」を区別する。** 戻り値の型（例: `FulltextFetchOutcome`）に**任意**フィールドを1本足しただけで、その戻り値を `deepEqual` で丸ごと比較している既存テストが「actual に余分なキーがある」と落ちる。実装のバグではないので、期待値側にそのキーを明示して追従させること（Issue #118 チャンク2で `registryPmids` を足した際に3件が落ちた）。
- **`src/demo/seed.ts` はテストから直接 import できない。** `sample/*.nbib` を raw-text import（`declare module '*.nbib'`、webpack ローダー前提）しているため、`tsc` + `node --test` の経路では `.nbib` を JS として読もうとして落ちる。そのためヘッダーミラーのドリフト検出テストは、seed.ts 側の期待値をテストファイルへ直書きして `sheets-api.ts` の実エクスポートと突き合わせる流儀になっている（`tests/references-headers-record-type.test.ts` / `tests/publication-candidates-headers.test.ts`）。**seed.ts だけを変えるとドリフトを検出できない**ので、列を足すときは seed.ts・sheets-api.ts・テストの3箇所を必ず同時に直すこと。
- **lint は型の緩さを検出しない。** `.eslintrc.cjs` は `@typescript-eslint/no-explicit-any` も `no-unused-vars` も有効にしていないため、`any` や未使用変数は CI を素通りする。`src/lib/` の既存コードが `any` を使っていないのは規約であって強制ではないので、レビュー側で見ること。
- **References の読み取り範囲は `A:X` のような終端列直書きにしない。** Issue #118 チャンク1で `References!A:X` を4箇所（`getReferences` / `updateReferenceColumnByRefId` / `getFulltextPageData` の2箇所）直書きしていたのを、`REFERENCES_LAST_COLUMN`（`columnLetter(REFERENCES_HEADERS.length)`、Decisionsの`DECISIONS_LAST_COLUMN`と同じ流儀）から導出する形に直した。直書きのままだと末尾に列を足しても新列が読み取り範囲外になり、書き込んでも永久に空として読まれる。`ensureHeaders()` 内のヘッダー行範囲（`A1:${REFERENCES_LAST_COLUMN}1` での読み取り・書き込み）も同じ理由で `A1:Z1` 直書きから導出に揃えた（26列がちょうどZ列なのは偶然で、次に列を1本足すと読み取り打ち切り＋書き込み時の列数不一致エラーの両方が起きるところだった）。ただし `References!T:X`（fulltext系5列専用の部分範囲）や `References!A1:X1`（W/X列単体の検証用、`ensureFulltextDriveColumnsOnce()` 内）のように、意味的に「References全体」ではない固定範囲は対象外＝変更不要。
- **`Pick<Reference, ...>` のように `Reference` を絞り込んだ型は、絞り込んだフィールドが全て optional だと構造的部分型のせいで typecheck をすり抜ける。** 絞り込み型Aが「実際に必要なフィールドの一部だけ持つ、より狭い絞り込み型B」を要求する関数に、Bより広いはずのAの値を渡しても、Aに欠けているフィールドがBの型定義上 optional なら、コンパイラは「無い」ことを検出できずコンパイルが通る。レジストリ連携フェーズ1チャンク3で実際に踏んだ（`src/lib/team-progress.ts` の `TeamProgressRef` が `related_ref_id` を持たないまま `fulltext-candidates.ts` の関数へ渡され、`isSharedFulltextPoolMember()` の分岐が本番で一度も発火しなかった。詳細は「論文候補の取り込み」節参照）。**`Reference` を絞り込んだ型を新設・変更するときは、型チェックだけで安心せず、配線の全経路（絞り込み型を組み立てている全箇所）が本当に必要なフィールドを運んでいるか目視確認すること。** 純関数のユニットテストも、引数へ絞り込んだオブジェクトリテラルを直接手書きして渡す形だと、配線側の欠落を再現できず検出できない（配線の境界＝実際に絞り込み型を組み立てている関数の入出力でテストすること）。PR #124 レビュー指摘7でこの教訓を実際に適用した: `ReferenceWithStatus` → `TeamProgressRef` の変換を `src/lib/team-progress.ts` の `toTeamProgressRef()` という小さな純関数へ切り出し（呼び出し元だった `initTeamProgress()` / `buildFooter()` の2箇所の重複実装を統一）、`tests/team-progress.test.ts` にこの関数自体の入出力を検証するテストを追加して、配線の境界へ実際に移した。
- **真偽値フラグ（`if (loading) return;`）による非同期処理の二重起動防止は、その処理の完了を `await` して待つ呼び出し元がいると成り立たない。** 進行中の呼び出しを「捨てる」だけで、待っている側には何も返せないため、`await` 側は実際には何も起きていないのに「完了した」と思い込んで先へ進んでしまう。レジストリ連携フェーズ1チャンク3で実際に踏んだ（`fulltext-tab.ts` の `loadPublicationCandidates()` を、一括検索/再探索の完了時は fire-and-forget（`void`）で呼ぶ一方、候補の取り込み完了後は `await` して待っていたため、前者が進行中に後者が呼ばれると空振りしていた）。fire-and-forget と `await` の呼び出しが混在する非同期処理には、進行中の Promise をそのまま返して合流させるヘルパー（`src/lib/async-coalesce.ts` の `createAsyncCoalescer()`）を使うこと。
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
