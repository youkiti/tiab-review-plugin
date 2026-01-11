# TiAb Review Plugin

Chrome拡張機能 - Systematic Reviewのタイトル・抄録スクリーニングを効率化するツール

## 必要条件

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Google Cloud CLI** (`gcloud`) - OAuth設定に使用

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Google Cloud CLI のインストール

```bash
# Ubuntu/Debian
sudo snap install google-cloud-cli --classic

# macOS
brew install google-cloud-sdk

# Windows (PowerShell)
(New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/GoogleCloudSDKInstaller.exe", "$env:Temp\GoogleCloudSDKInstaller.exe")
& $env:Temp\GoogleCloudSDKInstaller.exe
```

### 3. Google Cloud プロジェクトのセットアップ

```bash
# ログイン
gcloud auth login

# 新しいプロジェクトを作成（または既存のプロジェクトを使用）
gcloud projects create tiab-review-plugin --name="TiAb Review Plugin"
gcloud config set project tiab-review-plugin

# 必要なAPIを有効化
gcloud services enable sheets.googleapis.com
gcloud services enable drive.googleapis.com
```

### 4. OAuth 2.0 クライアントIDの作成

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) を開く
2. 「認証情報を作成」→「OAuthクライアントID」
3. アプリケーションの種類: **Chrome拡張機能**
4. 拡張機能ID: (後で`chrome://extensions`から取得)
5. 作成されたクライアントIDを `src/manifest.json` の `oauth2.client_id` に設定

### 5. ビルド

```bash
# 開発ビルド
npm run dev

# 本番ビルド
npm run build

# ウォッチモード（開発中）
npm run watch
```

### 6. Chrome への読み込み

1. `chrome://extensions` を開く
2. 「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダを選択

## 開発コマンド

| コマンド | 説明 |
|----------|------|
| `npm run build` | 本番用ビルド |
| `npm run dev` | 開発用ビルド |
| `npm run watch` | ホットリロード開発 |
| `npm run lint` | ESLint実行 |
| `npm run typecheck` | 型チェック |

## Chrome Web Store への提出（初回公開向け）

- 提出用ZIPは `npm run build:zip` で生成される `dist.zip` をアップロードします。
- Chrome Web Store では `manifest.json` の `key` フィールドが禁止のため、本リポジトリでは **本番ビルド（production）時のみ** `dist/manifest.json` から `key` を自動的に除去します。
- `chrome.identity` のOAuthを使う場合、公開後の「拡張機能ID」に紐づくOAuthクライアント（Chrome拡張機能）をGCP側で作成し、`src/manifest.json` の `oauth2.client_id` を差し替える必要があります。

## オフライン同期

- 判定保存に失敗した場合はキューに退避し、オンライン復帰時や次回保存時に再送します
- 100件未満は `chrome.storage.local`、100件以上は IndexedDB に保存します

## ディレクトリ構造

```
tiab-review-plugin/
├── scripts/                   # 分析用Pythonスクリプト
├── src/
│   ├── manifest.json          # Chrome Extension Manifest V3
│   ├── background/            # Service Worker
│   ├── popup/                 # ポップアップUI
│   ├── sidepanel/             # サイドパネルUI
│   │   └── features/          # 機能モジュール (LLM, Screening等)
│   └── lib/                   # 共通ライブラリ
├── experiments/               # 実験用コード
├── dist/                      # ビルド出力
├── package.json
├── tsconfig.json
└── webpack.config.js
```

## 開発時の注意点

> **⚠️ Chrome拡張機能はブラウザにインストールしないとテストできません**
>
> Chrome拡張機能のAPIは通常のウェブページからは利用できないため、ヘッドレスブラウザやリモート環境のブラウザではテストできません。

### リモート開発環境（Codespaces, devcontainer等）を使う場合

リモート環境では`dist`フォルダを都度ダウンロードする必要があり、開発効率が低下します。

**推奨: ローカルでの開発**

```bash
# リモートでコミット＆プッシュ
git add .
git commit -m "Update"
git push

# ローカルPCでクローン
git clone <repo-url>
cd tiab-review-plugin
npm install
npm run watch  # 変更を監視して自動ビルド
```

ローカルの`dist`フォルダをChromeに読み込めば、コード変更後は拡張機能の**リロードボタン（🔄）**を押すだけで反映されます。

## ライセンス

MIT
