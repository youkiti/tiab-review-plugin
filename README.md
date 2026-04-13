# TiAb Review Plugin

Chrome拡張機能 - Systematic Reviewのタイトル・抄録スクリーニングを効率化するツール

[Chrome store](https://chromewebstore.google.com/detail/tiab-review-plugin/alejlnlfflogpnabpbplmnojgoeeabij?hl=ja)で公開されてます。

📄 **プレプリント**: Kataoka Y, Banno M, Kyo M, et al. TiAb review plugin: A browser-based tool for AI-assisted title and abstract screening. arXiv. 2026. [arXiv:2604.08602](http://arxiv.org/abs/2604.08602)

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
4. 拡張機能ID: (後で `chrome://extensions`から取得)
5. 作成されたクライアントIDを `.env` に設定（下記参照）

### 5. 環境変数の設定

`.env.example` を `.env` にコピーして値を設定します。

| 変数名                    | 用途                               | 必須          |
| ------------------------- | ---------------------------------- | ------------- |
| `OAUTH_CLIENT_ID`       | Chrome Web Store用 OAuth Client ID | 本番ビルド時  |
| `LOCAL_OAUTH_CLIENT_ID` | ローカル開発用 OAuth Client ID     | 開発ビルド時  |
| `GEMINI_API_KEY`        | Gemini API キー                    | LLM機能使用時 |
| `DIST_COPY_PATH`        | dist.zip のコピー先パス            | build:zip 時  |

> **ローカル開発とストア公開で異なる OAuth Client ID が必要です。**
> ローカル開発用は `manifest.json` の `key` から決まる拡張機能IDに紐づけたクライアント、ストア用は公開後の拡張機能IDに紐づけたクライアントを使用します。

### 6. ビルド

```bash
# 開発ビルド（LOCAL_OAUTH_CLIENT_ID + key 保持）
npm run dev

# 本番ビルド（OAUTH_CLIENT_ID + key 削除）
npm run build

# ウォッチモード（開発中）
npm run watch
```

### 7. Chrome への読み込み

1. `chrome://extensions` を開く
2. 「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」→ `dist` フォルダを選択

## 開発コマンド

| コマンド              | 説明               |
| --------------------- | ------------------ |
| `npm run build`     | 本番用ビルド       |
| `npm run dev`       | 開発用ビルド       |
| `npm run watch`     | ホットリロード開発 |
| `npm run lint`      | ESLint実行         |
| `npm run typecheck` | 型チェック         |

## Chrome Web Store への提出（初回公開向け）

- 提出用ZIPは `npm run build:release` で生成される `dist.zip` をアップロードします。
- Chrome Web Store では `manifest.json` の `key` フィールドが禁止のため、本リポジトリでは **本番ビルド（production）時のみ** `dist/manifest.json` から `key` を自動的に除去します。
- `chrome.identity` のOAuthを使う場合、公開後の「拡張機能ID」に紐づくOAuthクライアント（Chrome拡張機能）をGCP側で作成し、`.env` の `OAUTH_CLIENT_ID` に設定してください。
- `OAUTH_CLIENT_ID` が未設定の状態で本番ビルドすると、誤った `client_id` 混入防止のためビルドを失敗させます。
- テスター配布向けの Google Drive コピー付きZIPは `npm run build:zip` を使います。

## 担当セット（複数人レビュー）

- 管理者は、文献取り込み後に「全員用キャリブレーション」と「残りのグループ分割」を一度だけ作成できます。
- 分割後は `References` シートの `screening_set` 列に `calibration` / `group-n` を保存します。
- 管理者は設定画面から各グループの担当者メールを編集できます。
- 一般ユーザーには、自分に割り当てられたセットと `calibration` のみ表示されます。
- ウィザードで「今回は分割しない」を選ぶと再表示されませんが、管理者は設定画面から再表示できます。
## オフライン同期

- 判定保存に失敗した場合はキューに退避し、オンライン復帰時や次回保存時に再送します
- 100件未満は `chrome.storage.local`、100件以上は IndexedDB に保存します

## 手動レビュー時の戻る挙動

- `未判定` フィルタで手動レビューしている間は、`戻る` / `←` で直近5件のレビュー履歴を新しい順にたどれます
- 履歴を開くだけでは判定は変更されません
- 履歴から `include` / `exclude` / `maybe` を押し直すと、その文献の既存判定を上書きし、`decided_at` を更新します
- 文献カード上部には現在の判定を示すチップが表示され、手動レビュー画面と ML 画面で同じ見え方になります

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

リモート環境では `dist`フォルダを都度ダウンロードする必要があり、開発効率が低下します。

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

ローカルの `dist`フォルダをChromeに読み込めば、コード変更後は拡張機能の**リロードボタン（🔄）**を押すだけで反映されます。

## 論文 / Publication

本ツールについてのプレプリントが公開されています。引用する場合は以下をご利用ください。

> Kataoka Y, Banno M, Kyo M, Nakao S, Sato T, Taito S, Takayama T, Tsuge T, Tsujimoto Y, So R, Furukawa TA. TiAb review plugin: A browser-based tool for AI-assisted title and abstract screening [Internet]. arXiv [cs.DL]. 2026. Available from: http://arxiv.org/abs/2604.08602

## ライセンス

MIT

## 研究助成 / Funding

本プロジェクトは以下の研究費の助成を受けて開発されています。
This project is supported by the following research grant.

**大規模言語モデルが加速するエビデンスの統合**
**Accelerating Evidence Synthesis with Large Language Models**

| 項目 / Item                 | 内容 / Details                                         |
| --------------------------- | ------------------------------------------------------ |
| 研究課題番号 / Grant Number | 25K13585                                               |
| 研究種目 / Category         | 基盤研究(C) / Grant-in-Aid for Scientific Research (C) |
| 配分区分 / Funding Type     | 基金 / Fund                                            |
| 研究期間 / Period           | 2025-04-01 – 2028-03-31                               |
|                             |                                                        |

