# Handoff: OAuthスコープ縮小（drive.file + Google Picker移行）

作成: 2026-07-15 ／ 状態: **計画確定・未着手**（ユーザー承認済み方針、実装はこのドキュメントから開始する。2026-07-15 レビュー指摘6点を反映済み）

## 経緯・意思決定

- Google OAuth審査（機微スコープ `spreadsheets`）で差し戻し（2026-07-15受領）。審査チームは `drive.file` + Google Picker の `setFileIds()`（2025-01追加）を明示して「最小スコープ要件を満たさない」と指摘。返信の選択肢は「Confirming narrower scopes」（縮小する）か「Unable to use narrower scopes」（正当化で押す）の二択。
- **OAuthユーザー数上限 100/100 が振り切れ済み**で、101人目以降の新規ユーザーはログイン不能（インストール数は200超。上限のカウント対象は「OAuth同意した人数」でありアンインストールや手動のアクセス削除では実質減らない）。
- 正当化で押す案は却下リスク高（Googleが対策APIを先回り提示済み・ポリシー文言も「UIの都合は例外理由にならない」と明記）。承認されてもフルスコープの怖い同意画面・組織管理者ブロック・再審査リスクは残る。
- **決定（2026-07-15 ユーザー承認）: Picker移行単独で進める。** 審査自体が不要になり、100人上限・ドメイン所有権要件・「未確認アプリ」警告がすべて消滅。Issue #23（組織ブロック）の緩和も期待。
- **機能喪失はゼロ**（調査済み）。変わるのは「他人の共有シートを初めて開くとき、ユーザー×シートごとに1回だけPicker選択クリックが増える」ことのみ。drive-api.ts（フォルダ/PDF）・共有機能・シート新規作成・最近一覧は既にdrive.file前提で成立している。

## 確定済みの技術的事実（再調査不要）

- スコープ定義は2箇所のみ: `src/background/auth-flow.ts:14-18`（拡張・launchWebAuthFlow implicit）と `src/platform/web/auth.ts:12-16`（Web版・GIS initTokenClient）
- MV3 CSP（`src/manifest.json:13-15` `script-src 'self'`）のため拡張ページ内にPicker（apis.google.com のリモートスクリプト）を埋め込めない → **Web側（docs/app 配信）にPickerページをホストし、拡張から `platform().openExternal` でタブとして開く**
- 両OAuthクライアントは**同一GCPプロジェクト（番号 451307229828）**（ビルド成果物のクライアントID接頭辞一致で確認済み: 拡張 `451307229828-803l...`／Web `451307229828-9t60...`）。Pickerによる drive.file 付与は**プロジェクト（アプリ）単位**なので、WebページでPicker選択→拡張クライアントのトークンでもアクセス可能になる（要実測、検証7b-4）
- `.github/workflows/deploy-web.yml` は `docs/` 全体を GitHub Pages にアップロード（`upload-pages-artifact` path: docs、:40-42）。`docs/app/` は .gitignore 済みでCIビルド
- Picker には developerKey（Google API key）と `setAppId`（プロジェクト番号）が必要。**API keyはリポジトリに存在しない → 新規発行が必要**
- `manifest.json` に `oauth2` セクションなし（スコープ変更で manifest 変更不要）。`externally_connectable` なし（今回は使わない設計）
- URL貼り付け接続フロー: `src/sidepanel/features/project.ts` の `extractSpreadsheetId()` (:108-124) と `handleConnect()` (:129-184)。初回アクセスは `getSpreadsheetInfo()`（`src/lib/sheets-api.ts:363-381`、既に404分岐あり）。既存プロジェクト再オープン時の catch は `project.ts:488-495`（`loadDataAndShowScreening`）
- `project.ts` は拡張/Web共有コード（bootstrapCommon経由）→ `chrome.tabs` 直接使用不可
- エラー型イディオム: `class GeminiApiError extends Error` + `instanceof` 分岐（`src/lib/gemini-api.ts:32,400`）
- 誘導UIイディオム: `showStatus(...)` 後に `dom.statusMessage.appendChild(button)`（`project.ts:278-298` の再認証ボタン）
- i18n: `src/_locales/{ja,en}/messages.json`。Webページ側は `src/platform/web/i18n.ts` の `getMessage` を直接 import 可
- `getRecentSpreadsheets`（sheets-api.ts:144）は現状でも drive.file 相当の挙動（フルスコープでも広がっていない）→ 退行なし。むしろPicker選択済みシートが一覧に載るようになる
- **drive.file は Sheets API の公式推奨スコープ**で、`spreadsheets.create` も drive.file で利用可能（公式資料）— 本移行の根幹は公式推奨と一致
- **GIS `initTokenClient` の `include_granted_scopes` は既定 true**（過去に付与したスコープを新トークンが引き継ぐ）→ スコープ縮小を確実にするには **`include_granted_scopes: false` の明示が必須**
- GIS の login_hint 用正式パラメータ名は **`login_hint`**（`hint` は現行公式API・インストール済み型定義で非推奨）
- GIS の `TokenResponse` に**メールアドレスは含まれない** → アカウント照合には userinfo エンドポイント（要 `userinfo.email` スコープ）が必要
- **`DocsView.setFileIds()` は「事前フォーカス」ではなく「表示対象を指定IDに限定する」仕様**（公式）。ユーザーが当該ファイルへの Drive 共有権限を持たない場合、そのファイルは Picker に表示されない

## 実装ステップ

### Step 0: GCPコンソール作業（ユーザー手作業・実装と並行可、検証前に完了必須）

1. Google Picker API を有効化（プロジェクト 451307229828）
2. API key 新規発行: HTTPリファラー制限 `https://youkiti.github.io/*`（+ ローカル検証用 `http://localhost:8080/*`）、API制限 = Picker API のみ
3. 両クライアントが同一プロジェクトの認証情報一覧に並んでいることを目視確認
4. GitHub repository variables に `PICKER_API_KEY` / `GCP_PROJECT_NUMBER` を追加
5. ローカル `.env` にも同2変数を追記

⚠️ 同意画面からの spreadsheets スコープ削除と審査返信は**リリース後**（Step 9）。Googleメールの指示どおり、今の時点では消さない（"DO NOT remove any previously approved scopes... at this time"）。

### Step 1: エラー型の追加 — `src/lib/sheets-api.ts`

`SheetsAccessDeniedError extends Error`（spreadsheetId, status 保持）を定義・export（GeminiApiError のイディオム）。

throw 箇所:
- `getSpreadsheetInfo` (:363-381): 403/404 で throw（既存の 404 文字列throwを置換）
- `getSheetValues` (:421-429): 同様（再オープン時の検知はここで網羅）

403/404 の実レスポンス（`error.status` 文字列）は事前検証（7a-4）で実測して条件確定。

### Step 2: スコープ削除（Step 3-5 と同一リリース必須）

- `src/background/auth-flow.ts:14-18` から `spreadsheets` 行を削除、コメント更新
- `src/platform/web/auth.ts:12-16` 同上
- **【重大】`src/platform/web/auth.ts:30` 付近の `initTokenClient` に `include_granted_scopes: false` を明示**（GISの既定は true のため、既存ユーザーが過去に許可した spreadsheets を新トークンが引き継いでしまう。Pickerページのトークンクライアント（Step 3）も同様に false を明示）
- `.env.example` のスコープ数コメント修正 + `PICKER_API_KEY` / `GCP_PROJECT_NUMBER` の2変数を追記
- `src/platform/web/index.ts` 等、spreadsheets 前提のコメントを更新

⚠️ 先にスコープだけ削ると共有シートが開けなくなる。Picker導線と必ず同時リリース。

### Step 3: Pickerページ新規作成（Webビルド第2エントリ）

- **`src/webapp/picker.html`**（新規）: gsi/client + apis.google.com/js/api.js + picker.js を読むテンプレート。**ボタン起点**（ページ読込直後の自動ポップアップはブロックされる）
- **`src/webapp/picker.ts`**（新規エントリ）:
  1. **URLフラグメント（`location.hash`）から `fileId`（任意）と `email`（login_hint用）を取得**。クエリ文字列は使わない — メールアドレスがブラウザ履歴や配信側ログに残るのを避けるため。フラグメントはHTTPリクエストに送信されない
  2. ボタン → GIS `initTokenClient({client_id: __WEB_OAUTH_CLIENT_ID__, scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email', login_hint: email, include_granted_scopes: false})` → トークン取得（パラメータ名は **`login_hint`**。`hint` は非推奨）
  3. **【重大】アカウント一致確認（Picker表示前・必須）**: `TokenResponse` にメールは含まれないため、userinfo エンドポイント（`https://www.googleapis.com/oauth2/v3/userinfo`）でメールを取得し、`email` パラメータと比較する。**不一致なら Picker を表示せずトークンを破棄**（`google.accounts.oauth2.revoke`）し、正しいアカウントで許可し直すよう警告を表示（別アカウントで許可しても拡張から使えないため）。このために picker ページのスコープに `userinfo.email` を含める（上記2）
  4. `gapi.load('picker')` → `PickerBuilder().setDeveloperKey(__PICKER_API_KEY__).setAppId(__GCP_PROJECT_NUMBER__).setOAuthToken(token).addView(view).setLocale(ja|en).setCallback(onPicked)`
     - `view = new DocsView(ViewId.SPREADSHEETS)`。**`fileId` がある場合のみ `setFileIds(fileId)` を呼ぶ**（無い場合は全シートビュー）
     - **setFileIds は「表示対象の限定」であり事前フォーカスではない**。ユーザーに Drive 共有権限が無いファイルは一覧に表示されない → ページに「シートが表示されない場合は、先に Google Drive でこのシートが自分のアカウントに共有されているか確認してください」の案内を常設し、**setFileIds なしの全シートビューで開き直すリンク**も用意する
  5. PICKED → 成功表示「拡張機能のパネルに戻ってください（自動で再接続されます）」+ `window.close()` 試行 ／ CANCEL → キャンセル表示 + 再試行ボタン
  6. **TokenResponse の `scope` に `spreadsheets` が含まれないことを開発時に検証**（include_granted_scopes: false の効果確認）
- **`src/types/google-picker.d.ts`**（新規）: 使用分のみの最小 ambient 宣言（Pickerの公式型は無い）
- **`webpack.config.js` buildWebConfig (:138-198)**: entry に `picker: './src/webapp/picker.ts'` 追加、DefinePlugin に `__PICKER_API_KEY__`/`__GCP_PROJECT_NUMBER__` 追加（本番ビルドで未設定なら throw、WEB_OAUTH_CLIENT_ID と同様）、CopyPlugin に picker.html 追加
- **`.github/workflows/deploy-web.yml` (:35-37)**: build:web の env に `PICKER_API_KEY: ${{ vars.PICKER_API_KEY }}` / `GCP_PROJECT_NUMBER: ${{ vars.GCP_PROJECT_NUMBER }}` 追加

配信URL: `https://youkiti.github.io/tiab-review-plugin/app/picker.html#fileId=...&email=...`（**フラグメント渡し**。クエリ `?` は使わない — メールを履歴・ログに残さないため）

※ API keyの docs/ 直下ハードコード案は不採用（公開repoへのキーコミット回避・既存の変数注入パターン踏襲）。

### Step 4: サイドパネル誘導UI — `src/sidepanel/features/project.ts`

- **4a**: `handleConnect` (:129-184) の本体（getSpreadsheetInfo 以降）を `connectToSpreadsheet(spreadsheetId)` に切り出し
- **4b**: `showPickerAccessGuidance(spreadsheetId)` 新設（再認証ボタンのイディオム）:
  - 「Googleで許可する」→ `platform().openExternal(buildPickerUrl(spreadsheetId, state.userEmail))` + ポーリング開始（3秒×最大40回で `getSpreadsheetInfo` 再試行、成功で `connectToSpreadsheet` 自動実行。多重起動ガード。UI消滅時にタイマー破棄）
  - 「再試行」→ `connectToSpreadsheet(spreadsheetId)`
  - **誘導UIの文言は404をPicker未選択と断定しない**: 「アクセス許可が未付与」のほかに「シートが削除された／URLが誤っている可能性」も併記し、Picker選択後も失敗が続く場合の最終エラー文言（削除済み・ID誤りを示唆）を用意する
- **4c**: catch 分岐2箇所 — `handleConnect` catch (:178-181) と `loadDataAndShowScreening` catch (:488-495) で `instanceof SheetsAccessDeniedError` → 誘導UI（後者は `showProjectView()` 後に表示）
- **4d**: `src/lib/picker-url.ts`（新規・小）: `PICKER_PAGE_URL` 定数 + `buildPickerUrl()`（**フラグメント形式**でfileId/emailを組み立て。単体テスト必須 — Step 6）
- **4e**: i18n キー追加（ja/en 両方）: `picker_accessNeeded`（「このシートを開くには Google への許可が必要です。開いたページでこのシートを選択してください（初回のみ）」）/ `picker_openBtn` / `picker_retryBtn` / Pickerページ用 `picker_pageTitle` `picker_pageIntro` `picker_startBtn` `picker_success` `picker_cancelled` `picker_error($1)` `picker_wrongAccount($1)`
- `state.userEmail` はログイン時設定済み（`src/sidepanel/features/auth.ts:123-125`）

### Step 5: プライバシーポリシー・関連ドキュメント同期

**`docs/privacy-policy.html`**:
- Sheets項 (:49-53) を「本サービス内で新規作成したもの、および**ユーザーが Google ピッカーで明示的に選択したもの**」へ変更。※PR #29（フルスコープ向け文言）は現行ストア版が生きている間は正確なので先にマージしてよい。本ブランチで上書きする
- 第三者サービス項 (:115-123) に「Google Picker API」追記、last-updated (:26) 更新

**その他の同期（すべて必須）**:
- `docs/help.html`: 共有シート初回のPicker許可手順の節を追加
- `README.md`: Picker API のGCP設定手順と新環境変数（`PICKER_API_KEY` / `GCP_PROJECT_NUMBER`）の説明
- `AGENTS.md`: OAuthスコープ一覧の更新（spreadsheets 削除）
- `src/platform/web/index.ts`: spreadsheets 前提のコメント更新（Step 2 と重複するがチェック漏れ防止のためここにも記載）

### Step 6: 静的検査・テスト

- `npm run typecheck` / `npm run lint` / **`npm run test`**（CI `build-check.yml:20` でも実行されるため必須） / `npm run build` / `npm run build:web`（docs/app に picker.html/picker.js が出ること、docs/ 直下静的ファイルが無傷なこと）
- **必須**: 403/404分類ヘルパーと `buildPickerUrl`（フラグメント組み立て）の単体テスト（tests/, node --test）

## 検証計画

### 7a. 事前検証（実装着手後すぐ、devビルド `ifnejj...` で）

1. myaccount.google.com/permissions で本アプリの既存付与を削除（クリーン状態）
2. スコープ削除だけの dev ビルドで再ログイン
3. **フルスコープ時代にアプリで作成したシートが drive.file で開けるか確認**（開けなくても誘導UIで救済されるため致命傷ではない）
4. 他人作成の共有シートURL → 403/404 のレスポンスボディ（`error.status`）実測 → Step 1 の条件確定

### 7b. 実装後チェックリスト（devビルド + `npm run dev:web` @ localhost:8080）

1. 新規ログインの同意画面が2権限（email / drive.file）に減っている
2. **【重大】過去にフルスコープを許可済みのアカウントで、新トークンの `scope` に `spreadsheets` が含まれないこと**を確認（Web版 GIS の `include_granted_scopes: false` の効果確認。拡張版も launchWebAuthFlow のリダイレクトフラグメント `scope` パラメータで同様に確認）
3. 新規プロジェクト作成 → RISインポート → 判定保存 → フォルダ整理（setupProjectFolder）
4. 自分の旧アプリ作成シートが Picker 不要で開ける
5. **他人の共有シート: URL貼付 → 誘導UI → Pickerページ（setFileIds で対象シートのみ表示）→ 選択 → ポーリングで自動再接続**（Web側付与→拡張トークンで有効、の実測を兼ねる）
6. **Drive共有権限が無いシートの fileId で Picker を開く → 一覧に何も表示されない → 「先にDriveで共有を確認」案内と全シートビューへの切替リンクが機能する**
7. Pickerキャンセル / **別アカウント選択時（userinfo照合 → トークン破棄 → 警告表示）**
8. 既存 storage.local の spreadsheetId 再オープン → catch → 誘導UI
9. PDF保存（drive-api）・共有ボタン（sharing.ts）が引き続き動く
10. Web版で同フロー
11. ブラウザ再起動（トークン失効）後の再オープン

※ Seleniumハーネス（scripts/selenium-review/）でURL貼り付け接続を自動化している場合、Pickerウィンドウのクリック操作の追加が必要（後続タスクでよい）。

## ロールアウト順序

1. 実装 → 7a/7b 検証
2. main マージ（Web版が先に自動デプロイされ新挙動に。drive.file付与は蓄積型なのでストア版フルスコープと併存しても壊れない）
3. `npm run release` → **dist.zip** をストアへアップロード（ファイル名固定）
4. ストア審査通過後、**旧バージョンの自動更新の浸透を待つ**（可能ならストア版の更新確認をリリースゲートにする）。目的は「旧版利用者の認可・再認可を壊さないため」の安全マージン。※Google公式資料上、コードと同意画面のスコープ不一致は主に「未確認アプリ画面・100人上限」の要因とされており、旧版が即 invalid_scope になるとは断定できない（当初の記載を訂正）
5. 新規アカウント1つで本番同意画面スモークテスト
6. Console 同意画面から `spreadsheets` スコープ削除
7. Google 審査メールへ返信: **「Confirming narrower scopes」**（+ "We have removed the spreadsheets scope from our codebase and Cloud Console." の一文）

→ 検証リクエストがクローズし、100人上限・未確認アプリ警告が消滅。新規ユーザーのブロック解消はストア公開時点（手順3）から。

## 不確実な点（検証で潰す）

1. フルスコープ時代のアプリ作成シートが drive.file で見え続けるか（7a-3。ダメでも誘導UIで救済）
2. Picker付与のプロジェクト単位性（Webクライアントで選択→拡張クライアントのトークンで有効か。ドキュメント上はアプリ=プロジェクト単位、7b-5で実測必須）
3. 403 vs 404 の実レスポンス（7a-4）
4. Pickerページの `window.close()` が効くか（効かなくても成功メッセージで成立）
5. `include_granted_scopes: false` で既許可ユーザーのトークンから spreadsheets が確実に外れるか（7b-2 で実測。拡張版 launchWebAuthFlow 側で同挙動が必要なら認可URLパラメータ `include_granted_scopes=false` の明示を検討）

※解決済み（レビューで確定、不確実リストから昇格）: `setFileIds` は「表示対象の限定」仕様（公式）／ GIS のパラメータ名は `login_hint`（`hint` は非推奨）／ TokenResponse にメールは含まれない → userinfo 照合が必要

## 見積り

実装+検証 2〜4日、ストア審査 1〜3日、旧版自動更新待ち 2〜3日 → **約1.5〜2週間で完全クローズ**。

## 関連

- Googleからの差し戻しメール: 2026-07-15受領（本ドキュメント冒頭の経緯参照。返信テンプレは Step 9-7）
- PR #29: プライバシーポリシーのフルスコープ向け修正（本移行で Step 5 が上書きする）
- Issue #23: launchWebAuthFlow移行（完了・v0.26.0）／ Issue #26: implicit→PKCE移行（本移行とは独立、別途）
- 旧ハンドオフ: `.agent/artifacts/oauth-launchwebauthflow-migration.md`
