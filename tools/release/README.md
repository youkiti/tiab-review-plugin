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
| `npm run release:submit` | 小変更の版上げ → ストア用ビルド → `origin/main` へ push → 提出 |
| `npm run release:submit:major` | 機能追加の版上げで同じ処理を実行 |

提出では zip 内 `manifest.json` と `package.json` の版が一致することを確認し、公開中の全チャネルの版より新しい版だけを提出します。`--zip` 指定時も同じ照合を行います。

`release:submit` は `main` 上・作業ツリーがクリーン・fetch 後の `origin/main` と HEAD が一致するときだけ進みます。認証・提出可否を確認してから版を上げ、バンプ commit の push まで自動で行います。既存の `npm run release` は push を行いません。提出失敗時は版を上げ直さず、原因を解消して `store:submit` で提出だけをやり直します。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功（dry-run 含む） |
| 1 | 失敗・提出不可 |
| 2 | 設定・引数の不備 |
| 3 | 結果不明 |

upload / publish は自動再試行しません。結果不明なら、再実行する前に `npm run store:status` で状況を確認してください。`release:submit` で提出段階まで進んだ場合、zip 作成と push は完了済みです。
