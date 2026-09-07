# src/platform/ の仕様

このファイルは ../../AGENTS.md（リポジトリ根）から Issue #195 で切り出した詳細仕様です。
リポジトリ全体の規約・CRITICAL PROTOCOLS は [根の AGENTS.md](../../AGENTS.md) を参照してください。

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
  - 認証トークンは呼び出し側から渡す。`drive-shared-drive.ts` が互換窓口 `sheets-api.ts` 経由で `getAuthToken`（実体は `sheets/transport.ts`）を import すると循環参照になるため
- 適用先は `src/lib/drive-api.ts` の13箇所と **`src/lib/drive-recent-files.ts` の1箇所**（`getRecentSpreadsheets` の `files.list`）と **`src/lib/drive-permissions.ts` の4箇所**（permissions の list/create/delete、`isUserAdmin` の capabilities）。特に `getRecentSpreadsheets` は `files.list` なので、欠けると**共有ドライブ上のスプレッドシートが一覧から黙って消える**
- **パラメータが落ちても `files.list` 系のテストは緑のまま通る**（200 + 0件のため）。回帰は `tests/drive-shared-drive.test.ts` で検出する。実際に飛ぶ URL を見張るテストに加え、**`drive-api.ts` / `drive-permissions.ts` / `drive-recent-files.ts` のソースに `fetch(` の直呼びが残っていないことを機械的に検査**している（新しい経路が `driveFetch` を通さずに増えた瞬間に落ちる）
- **`classifyBlockedReason()`（`src/sidepanel/features/fulltext/drive-import/validate.ts`）の共有ドライブブロックは撤去した。** `getDriveFileMetadata()` の `files.get` に `supportsAllDrives` が無かった間、`meta.driveId` を読む前に 404 で throw していたため到達不能な死んだコードだった（`fulltext_importErrorSharedDrive` は一度も表示されていない）。パラメータを付けた時点でこれが**生きたコードに変わり、実測では読めるはずの共有ドライブ上のPDFを新たに弾き始める**ため、パラメータ付与とセットで消す必要があった
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

上記の帰結として、フォルダ単位での一括付与は成立しない。代わりに **Picker の複数選択で1セッションにまとめて再付与する**（`features/fulltext/regrant.ts`）。Picker の一覧表示は `drive.file` ではなく**ユーザー自身の Drive 権限**を使うため、fulltext フォルダに Drive 共有さえされていれば、共同研究者にも他人がアップロードした PDF が見えて選択できる（＝ Drive 共有は付与経路ではないが、Picker で選ぶための前提にはなる）。

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

> 関連: `isUserAdmin()`（`src/lib/drive-permissions.ts`）は role が **owner または writer** で `true` を返す。共同研究者は編集者として招待されるため、**`isAdmin` ではオーナーと共同研究者を区別できない**。オーナー限定の分岐が必要な場合は別の識別子を用意すること。

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
- **W/X書き込み前のヘッダー検証**（`validateFulltextDriveHeaders()`、spreadsheetId単位でメモ化）。ユーザーが独自の23列目以降を足していた場合、Drive直接取り込みはfail-fastでエラー、それ以外の経路はW/Xをスキップして`T:U`だけ書く（独自データを空文字で壊さないため）。**`ensureHeaders`（`sheets/references.ts`）は目的の異なる別関数 `validateReferencesManagedHeaders()` で同様にガードする**（PR #105 実機確認で発覚した回帰の修正）。2つ要るのは目的が違うため:
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

**セットアップチェックリストへの反映（管理者向け2項目）**: 共有リストの警告は管理者がその画面を開かないと気づけないため、フルテキストタブ先頭の「セットアップチェックリスト」（`src/lib/fulltext-checklist-state.ts` / `src/sidepanel/features/fulltext/checklist.ts`）にも管理者専用の2項目を追加している（非管理者には出さない）。

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

