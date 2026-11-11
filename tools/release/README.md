# Chrome Web Store への API 提出

TiAb Review Plugin（アイテム ID: `alejlnlfflogpnabpbplmnojgoeeabij`）の状況確認、zip のアップロード、審査提出を行う CLI です。掲載文・スクリーンショット・プライバシー項目の編集は API にないため、デベロッパーダッシュボードで行います。

## 初期設定

1. GCP プロジェクトで Chrome Web Store API を有効にします。
2. OAuth 同意画面を「外部」にし、テストユーザーに発行元アカウントを追加します。
3. OAuth クライアントを「ウェブ アプリケーション」で作り、承認済みリダイレクト URI に `https://developers.google.com/oauthplayground` を追加します。
4. [OAuth Playground](https://developers.google.com/oauthplayground) で自前のクライアントを使用し、スコープ `https://www.googleapis.com/auth/chromewebstore` を承認して refresh token を取得します。
5. デベロッパーダッシュボードのアカウント設定で発行元 ID を確認します。

次の4キーをこのリポジトリの `.env` に設定します。CLI 専用で、拡張のビルドには注入されません。

```dotenv
CWS_CLIENT_ID=取得したクライアントID
CWS_CLIENT_SECRET=取得したクライアントシークレット
CWS_REFRESH_TOKEN=取得したリフレッシュトークン
CWS_PUBLISHER_ID=発行元ID
```

代わりに `CWS_ENV_FILE=<別の .env のパス>` を1行書けば、4キーを共有できます。同じ発行元アカウントの `sr-data-extraction-plugin` の `.env` を指せば、トークンの入れ直しが1か所で済みます。共有する場合、上の4キーの空行は削除してください。空文字も設定済みと扱い、共有元へフォールバックせず設定エラーにします。

値の優先順はキーごとに「環境変数 → このリポジトリの `.env` → `CWS_ENV_FILE` の指すファイル」です。`--env-file=<path>` で第一のファイルを差し替えられます。`CWS_ENV_FILE` 自体は環境変数を優先し、相対パスは第一のファイルのディレクトリ基準です。未設定・空文字なら共有ファイルを読みません。指定した共有ファイルを読めなければ設定エラーで停止します。

同意画面が「テスト中」だと refresh token は7日で失効します。`invalid_grant` で止まったら OAuth Playground で再承認し、`CWS_REFRESH_TOKEN` を入れ直してください。共有している場合は共有元の `.env` を直します。

## コマンド

| コマンド | 動作 |
| --- | --- |
| `npm run store:status` | 認証して公開中・審査中の状況を確認。書き込みなし |
| `npm run store:status -- --json` | 状況を JSON で表示（秘密値は伏せ字） |
| `npm run store:status -- --require-submittable` | 提出不可なら非0で終了 |
| `npm run store:submit` | 再ビルドせず、今ある `dist.zip` をアップロードして審査提出 |
| `npm run store:submit -- --dry-run` | 認証・状況・版を確認。アップロード・提出なし（通信は行う） |
| `npm run store:submit -- --zip=<path>` | 任意のファイル名の zip を指定して提出 |
| `npm run release` | 小変更の版上げ PR → 必須チェック待ち → マージ → ストア用ビルド → 提出 → 版タグと GitHub Release（`release:minor` も同じ） |
| `npm run release:major` | 機能追加の版上げで同じ処理を実行 |
| `npm run release -- --dry-run` | 何も変えず、続きの位置と新しい版だけを表示 |
| `npm run release:submit` | `release` の別名 |
| `npm run release:submit:major` | `release:major` の別名 |

提出では zip 内 `manifest.json` と `package.json` の版が一致することを確認し、公開中の全チャネルの版より新しい版だけを提出します。`--zip` 指定時も同じ照合を行います。

`release`（`tools/release/release.mjs`）は次の段を順に進めます。`main` へは直接 push せず、版上げは PR 経由です（`main` の必須チェックは直接 push も止めるため）。

1. 前提の確認（何も変えません）: `gh` のログイン、`main` 上・作業ツリーがクリーン・fetch 後の `origin/main` と HEAD が一致、`.env` の `WEBAUTH_CLIENT_ID`、ストアの提出可否、CHANGELOG の「未リリース」の節、新しい版のブランチとタグが `origin` に無いこと。
2. `chore/release-v<版>` ブランチの作成、CHANGELOG の版の節への書き換え、バンプ commit、push。
3. PR の作成と、必須チェック（`quality`・`build-extension`・`build-web`・`bundle-budget`）の成功待ち。失敗したら PR を残して止まります。
4. `gh pr merge --merge --delete-branch` でマージし、`main` を取り込みます。
5. `npm run build:release` と `storeApi.mjs submit`。
6. 版タグと GitHub Release: 段4の merge commit に annotated タグ `v<版>` を打って push し、Release が無ければ `gh release create --verify-tag` で作ります（本文は CHANGELOG の該当節と、`src/lib/citation.ts` の concept DOI の行。draft・prerelease にせず、ファイルは添付しません）。`origin` のタグが別のコミットを指していれば止まります。過去の版にはタグを打ちません: `release.mjs` の `TAG_FROM_AFTER_VERSION` より新しい版だけが対象です。

途中で止まったら同じコマンドを再実行します。続きの位置は、今いるブランチ、開いているリリース PR、`origin/main` の版とストアの公開中・審査中の版から毎回決めます（`release:resume` はありません）。審査中の版が `origin/main` の版と同じなら、提出済みとして何もしません（ただし `origin` にタグか Release が無く、版が `TAG_FROM_AFTER_VERSION` より新しければ、段6だけを行います）。リリースを取りやめるときは、開いている PR を閉じてブランチを消します。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功（dry-run 含む） |
| 1 | 失敗・提出不可 |
| 2 | 設定・引数の不備 |
| 3 | 結果不明 |

upload / publish は自動再試行しません。結果不明なら、再実行する前に `npm run store:status` で状況を確認してください。`release` で提出段階まで進んだ場合、マージと zip 作成は完了済みです。再実行すると提出から続きます。
