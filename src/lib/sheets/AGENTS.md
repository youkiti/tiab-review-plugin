# src/lib/sheets/ の仕様

このファイルは ../../../AGENTS.md（リポジトリ根）から Issue #195 で切り出した詳細仕様です。
リポジトリ全体の規約・CRITICAL PROTOCOLS は [根の AGENTS.md](../../../AGENTS.md) を参照してください。

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
| duplicate_of    | 重複として論理削除済みかどうかのフラグ。非空なら、この行は重複として除外済みで、値は**残す側の** `ref_id`。空文字（未設定）は生きている行。判定は必ず `src/lib/duplicate-detect.ts` の `isLogicallyDeleted()` を経由すること（自前で `ref.duplicate_of` を直接見る分岐を書かない）。書き込みは `src/lib/sheets/references.ts` の `setDuplicateOf()`（`duplicateOf: null` を渡すと空文字を書いて除外を取り消せる）。**この経路（`duplicateOf: null`）の実際の呼び出し元は相互削除（同時更新の競合）の修復に限られる**: `applyPairDecision()` の書き込み直後の自動修復と、壊れたペアに出す手動の「修復する」ボタン（どちらも `repairMutualDeletion()` を共有）。通常の統合判断（「左を残す」「右を残す」）をユーザーが取り消す一般的なUIは実装されていない。取り消したい場合はスプレッドシートの `duplicate_of` 列を直接編集する必要がある（Issue #147 外部レビュー指摘）。物理削除ではないため行自体は残る（Issue #145 チャンク2、AA列） |      |

**References も列は末尾追記のみ**（`LLM_Executions タブ`の注意と同趣旨）。上記2列（W/X）はIssue #73 Phase 2 で末尾に追加した。record_type/related_ref_id（Y/Z列）はIssue #118 チャンク1（レジストリ連携フェーズ1）で追加した。duplicate_of（AA列）はIssue #145 チャンク2で追加した。新しい列は必ず配列の末尾に足し、`src/demo/seed.ts` の `REFERENCES_HEADERS` ミラーも追従させること（今回も追従済み）。

**References を読む経路を新設・変更するときの規則（Issue #145 チャンク2、PR #146 レビュー指摘）**: References の行を返す経路は、論理削除済み行（`duplicate_of` 非空）を含めるかどうかで2種類に分かれる。新しい取得経路を足すときは、必ずどちら側かを判断すること。

- **全件返す（論理削除済みも含む）**: `getReferences()`。重複レビューUIの `resolveSurvivor()`（論理削除済みの相手から残っている側を辿り直す）・`isPairAlreadySettled()`（survivor の収束・相互削除の判定）が論理削除済みの行を必要とするため、意図的にフィルタしない（Issue #147 外部レビュー指摘。個別の統合判断を取り消す一般的なUIは実装されていない）
- **論理削除行を除外する**: `getReferencesWithStatus()`（TiAb盲検）・`getReferencesWithAllDecisions()`（キー開封後）・`getFulltextPageData()`（`src/lib/sheets/project-snapshot.ts` の取得窓口。フルテキスト画面。Config タブ欠落時も同じ合成経路で除外する）。除外は必ず `isLogicallyDeleted()` を経由する

**`getReferences()` の呼び出し元を grep するだけでは経路の洗い出しに不十分**: `getFulltextPageData()` は `getReferences()` を経由せず、`src/lib/sheets/project-snapshot.ts` の `loadProjectSnapshot()` がシート値から `Reference[]` へ変換する内部関数 `parseReferenceValues()` を呼んでいる。TiAb の合成は `src/lib/reference-status.ts` の `mergeReferencesWithStatus()` / `mergeReferencesWithAllDecisions()` が担う。そのため「除外漏れが無いか」を確認するときは `getReferences(` ではなく `parseReferenceValues` で grep すること。PR #146 のレビューでこの漏れが実際に見つかった（フルテキスト画面だけ論理削除済み文献が残っていた）。

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
- `loadExecutionHistory`（`src/sidepanel/features/llm/batch/history.ts`）が `execution_type` を二値の三項演算子で扱っていたため、フルテキストの実行履歴が「判定基準生成」という誤ったラベルで TiAb の実行履歴一覧に混入していた

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
その場で確定できる（`src/sidepanel/features/fulltext/results.ts` の `renderConflicts` /
`buildConflictItem` / `handleAdjudicate`）。**`state.isKeyOpened === true`（キー開封後）のときだけ表示**する。
ブラインド中は他レビュアーの人間票がそもそもクライアントに配られない（`filterDecisionsForBlind`）ため、
不一致の検出自体が成立しないため。

**合議計算は純関数に集約**: OR合議・不一致検出・裁定の反映は `src/lib/fulltext-consensus.ts` の
`computeFulltextConsensus()` に切り出している。`features/fulltext/results.ts` は DOM/state に依存する層のため
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
`collectJudges()`（`features/fulltext/results.ts`）が `isAdjudicationKey()` で除外している。
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
| `status`（既存・互換維持のため変更しない） | `decision-aggregate.ts` の `detectConflict()` | 1人しか判定していなくても `conflict` になる旧定義 |
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
- **import_stats**: インポート統計（JSON: `{"ファイル名": {identified, duplicates, imported_at}}`）。ファイルごとの解析件数（重複除去前）と重複スキップ数をインポート時に記録し、論文用テキスト（PRISMAフロー図の識別件数・重複除去数）の自動記入に使う。ソースファイル削除時は該当キーも削除する。**`duplicates` の意味が Issue #145 チャンク1〜2で変わっている**: 従来は正規化タイトル一致も含めて数えていたが、現在は取り込み時に**確認なしで自動スキップした分のみ**（PMID一致・検証済みDOI一致・試験ID一致でsourceも一致、の3種）。自動スキップしなかった重複（正規化タイトル一致など）は References に行として残り、人が重複レビューUIで判断した後に `duplicate_of` で論理削除される。この論理削除件数は `import_stats.duplicates` には入らず、`src/lib/prisma-identification.ts` の `computeIdentification()` が合算することで `identified − duplicates = screened` の縦の辻褄を合わせる（詳細は下記「論文用テキスト生成」参照）。
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

`saveLlmExecution`（`src/lib/sheets/llm-history.ts`）は行を**位置ベース**で組み立てて `appendRows` する。ヘッダ名は見ていない。既存シートのヘッダは `ensureLlmExecutionsSheet` に加え、読み取り（`getLlmExecutions` / `getLlmRuns`）でも本体の1行目から不足列を**末尾へ追記**する同じ移行を行う。したがって `LLM_EXECUTIONS_HEADERS` の途中に列を挿入すると、既存プロジェクトのシートで列がずれて壊れる。**新しい列は必ず配列の末尾に足すこと。**

- 読み取り側（`getLlmExecutions` / `updateLlmExecution`）はヘッダ駆動なので、新しい列の型変換が必要なら `getLlmExecutions` の `switch (header)` に case を足す
- `src/demo/seed.ts` に `REFERENCES_HEADERS` / `DECISIONS_HEADERS` / `LLM_EXECUTIONS_HEADERS` / `LLM_RUNS_HEADERS` のミラーがあり、**実際に drift していた**（Issue #62 時点で `LLM_EXECUTIONS_HEADERS` のミラーが `target_mode` / `target_sets` / `target_selected_count` の3列ぶん古かった）。列を変更したら両方を確認すること

## API設計

### Google Sheets API 使用方法

```typescript
// 読み取り
GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}

// 追記（判定記録）
POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append
```

### 判定保存フロー

判定種別によって分岐する（`src/lib/sheets/decisions.ts` の `saveDecisionInner`）。human判定・ML手動確認判定は
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

**保存の直列化（Issue #154）**: `saveDecision()` はスケジューリングをキー単位（`spreadsheetId` +
`ref_id` + `reviewer_id` + `screening_phase`）で直列化している。追記専用経路（human判定・ML手動確認判定）は
`getDecisions()` を一切呼ばないため、他キーを巻き添えにするキャッシュ丸ごと差し替え
（`primeDecisionRowCache`）が発生せず、異なる文献への保存は並行して走れる（保存内容キャッシュへの書き込みは
自キーへの上書きが基本で、未構築時・別スプレッドシート時のみオブジェクトごと作り直すが、JSがシングルスレッド
であることから並行しても安全。詳細は `decisions.ts` の `scheduleKeyedSave` 直上のコメント参照）。
一方 upsert経路（ML自動判定・LLM判定）は cold時に `getDecisions()` が行番号キャッシュ／保存内容キャッシュを
丸ごと差し替えるため、全キーをまたぐグローバル直列のまま（先行する全ての保存の完了を待ってから走り、以後の
保存——既にキー別チェーンを持っているキーへの保存を含む——はそれを待つ）にしている。この「既存キーの追い越し
防止」を担うのが `scheduleGlobalSave` の `saveChainsByKey.clear()` で、単なる後始末ではなく正しさに直結する
（詳細は `decisions.ts` の同関数のコメント参照）。経路の判定は保存をスケジュールする時点で行い、実行時の
`hit`/`absent`/`cold` 判定では分岐させない（キュー待ち中に TTL が切れて判定がずれるため）。

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

