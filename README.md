# TiAb Review Plugin

Chrome拡張機能 - Systematic Reviewのタイトル・抄録スクリーニングを効率化するツール

[Chrome store](https://chromewebstore.google.com/detail/tiab-review-plugin/alejlnlfflogpnabpbplmnojgoeeabij?hl=ja)で公開されてます。

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

| 変数名                    | 用途                                 | 必須                            |
| ------------------------- | ------------------------------------ | ------------------------------- |
| `OAUTH_CLIENT_ID`       | Chrome Web Store用 OAuth Client ID   | 本番ビルド時                    |
| `LOCAL_OAUTH_CLIENT_ID` | ローカル開発用 OAuth Client ID       | 開発ビルド時                    |
| `GEMINI_API_KEY`        | Gemini API キー                      | Gemini モデル使用時             |
| `OPENROUTER_API_KEY`    | OpenRouter API キー（実験用CLIのみ） | 実験スクリプト実行時            |
| `DIST_COPY_PATH`        | dist.zip のコピー先パス              | build:zip 時                    |

> **LLM プロバイダ**: v0.19.0 から Gemini に加えて OpenRouter モデル (`qwen/qwen3-235b-a22b-2507`, `deepseek/deepseek-v4-flash`) が選択可能。OpenRouter キーは https://openrouter.ai/keys で発行し、サイドパネルの「OpenRouter APIキー」カードから登録します（環境変数は実験ランナー用途のみ）。

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

## Codex PR自動レビュー

このリポジトリでは GitHub Actions の `Codex PRレビュー` ワークフローで、PR作成・更新・再オープン時に Codex が自動レビューコメントを投稿します。

有効化に必要なリポジトリ設定:

- GitHub Secrets に `OPENAI_API_KEY` を登録してください。
- Actions の `GITHUB_TOKEN` に Pull requests と Issues への書き込み権限を許可してください。
- fork 由来のPRでは Secrets 保護のため、このワークフローは実行されません。外部コントリビューターPRも自動レビューしたい場合は、OpenAI Codex のCode review設定側でAutomatic reviewsを有効化する運用を検討してください。

レビュー指示は [.github/codex/prompts/pr-review.md](.github/codex/prompts/pr-review.md) にあります。

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

## LLMモデル履歴

- 既定のLLMモデルは `gemini-3.1-flash-lite` (GA, Temp 0) です。下記ベンチマークで速度・コスト効率に優れることを確認した上で、既定として採用しています。
- UI で選べるモデルは以下の 4 つ。Gemini 系と OpenRouter 系で別の API キーが必要です:
  - **Gemini**: `gemini-3.1-flash-lite` (既定 / depression Recall 93.6%) / `gemini-3-flash-preview` (Recall 96.1%)
  - **OpenRouter** (v0.19.0+): `qwen/qwen3-235b-a22b-2507` (Recall 93.9% / Specificity 92.2% / 約 $0.135/1K件) / `deepseek/deepseek-v4-flash` (Recall 91.1% / Specificity 90.5% / 約 $0.756/1K件)
- OpenRouter モデルは [experiments/openrouter-bench/](experiments/openrouter-bench/) の depression データセット全件 (N=1,993) ベンチで採用基準 (Recall ≥ 0.90) を満たした 2 モデルのみを同梱しています。
- **OpenRouter カスタムモデル**: 上記同梱モデル以外の OpenRouter モデル（例: `anthropic/claude-3.7-sonnet`、`openai/gpt-4o-mini` 等）も、サイドパネルの「OpenRouter カスタムモデル」カードからモデル ID を手入力できます。「テストして保存」を押すと実 API を 1 回叩き、スクリーニング用 JSON 出力が返ったモデルだけがブラウザに保存され、以降モデル選択肢に出現します（最大 20 件）。カスタムモデルは当ツールのベンチマーク対象外のため、組入精度は各自で必ず検証してください。
- **2026-05 以降は `latest` エイリアス (`gemini-flash-lite-latest` / `gemini-flash-latest`) ではなく、ベンチマーク済みの固定バージョン ID を採用しています**。Google がエイリアス実体を更新した際の挙動変化 (Recall・コスト) を防ぐためです。例として `gemini-3.5-flash` (depression Recall 93.2%) が将来 `gemini-flash-latest` の実体になった場合でも、UI 上のユーザー設定は影響を受けません。
- 既存ユーザーの設定 (`llm_model = gemini-flash-lite-latest` 等) は、Config シート読み込み時に自動で固定 ID へマイグレーションされます ([src/lib/gemini-api.ts](src/lib/gemini-api.ts) の `MODEL_ID_MIGRATIONS`)。
- Run の集約は、呼び出しに指定したモデルID（`requested_model` / 既存の `model`）で行います。
- Gemini API応答に含まれる実モデルバージョンは、`model_version` として `LLM_Executions` / `LLM_Runs` / 判定noteに保存します。
- 各モデルのスクリーニング精度比較は下の「LLMスクリーニング精度ベンチマーク」を参照してください。

## LLMスクリーニング精度ベンチマーク

`experiments/` 配下で複数モデルを 7 データセット (depression / cq1–cq5 / wilson、計約 22,000 件) で評価しています。threshold=0.5 固定、主指標は Recall (Sensitivity)。

### depression データセットでの代表的結果 (n=1,993, 陽性 280 件)

| モデル | 条件 | Recall | Precision | Fβ(7) | ms/件 | $/1K件 (推定) |
|---|---|---|---|---|---|---|
| **`gemini-3-flash-preview` (B4)** | Temp 1.0 / TopP 0.95 / Think LOW | **96.1%** | 53.4% | 95.0% | ≈300 | 約 $1.70 |
| `gemini-3.1-flash-lite` (GA) | Temp 0 | 93.6% | 61.6% | 92.6% | 9 | 約 $0.30 |
| `gemini-3.1-flash-lite-preview` | Temp 0 | 92.9% | 62.4% | 92.0% | 15 | 約 $0.30 |
| `gemini-3.5-flash` (参考・採用見送り) | Temp 1.0 / TopP 0.95 / Think MINIMAL | 93.2% | 54.6% | 91.9% | 31 | $1.93 |

### OpenRouter モデル評価 (2026-05, depression 全1,993件)

OpenRouter 経由で利用できる主要 LLM をベースラインと同一プロンプト・同一データセット (depression) で評価しました。`response_format: json_object` モードで JSON 出力を強制しています。

| モデル | 条件 | Recall | Precision | Fβ(7) | ms/件 | コスト ($/全1,993件) | 推定 $/1K件 |
|---|---|---|---|---|---|---|---|
| **`gemini-3-flash-preview` (B4, 既存記録)** | Temp 1.0 / TopP 0.95 / Think LOW | **96.1%** | 53.4% | 95.0% | ≈300 | - | 約 $1.70 |
| `qwen/qwen3-235b-a22b-2507` (Instruct) | Temp 0 | 93.9% | 47.9% | 92.2% | 650 | $0.135 | 約 $0.07 |
| `deepseek/deepseek-v4-flash` | Temp 0 (内部 reasoning あり) | 91.1% | 68.0% | 90.5% | 1,319 | $0.756 | 約 $0.38 |

**所見**:
- 2026-05 時点で OpenRouter 経由の最新 Kimi / Qwen / DeepSeek / Grok 系を試したが、**Recall ≥ 95% (採用基準) を全件 1,993 で満たすモデルは無し**。既存 B4 (`gemini-3-flash-preview`) を上回るモデルは確認できなかった。
- `qwen3-235b-a22b-2507` (Instruct) は B4 比 **コスト約 1/24** で Recall 93.9%。Recall を 2pp 譲っても圧倒的な低コストで一次スクリーニングしたい場合の「予算オプション」として有望。
- `deepseek-v4-flash` は Recall 91.1% で採用基準未達。内部 reasoning でレイテンシ・コストとも `qwen` Instruct の数倍。
- Thinking 系 (`qwen3-thinking-2507`, `kimi-k2-thinking`, `grok-4.3`) は 50〜300件サンプルでは Recall 100% を出すが、レイテンシ 16〜48 秒/件・コスト数倍〜十数倍で本番スケール非現実的。詳細は [experiments/openrouter-bench/report.md](experiments/openrouter-bench/report.md)。

### 全データセット Recall (最良条件比較)

| データセット | n | 陽性率 | `gemini-3-flash-preview` (B4) | `gemini-3.1-flash-lite` (GA) |
|---|---|---|---|---|
| depression | 1,993 | 14.1% | **96.1%** | 93.6% |
| cq1 | 5,628 | 2.0% | **99.1%** | 83.2% |
| cq2 | 3,400 | 0.5% | **100.0%** | 100.0% |
| cq3 | 1,038 | 1.5% | **100.0%** | 87.5% |
| cq4 | 4,326 | 1.7% | **100.0%** | 98.6% |
| cq5 | 2,253 | 1.8% | **97.6%** | 97.6% |
| wilson | 3,451 | 5.0% | N/A | 45.7% |

### コスト参考 (公式公表値, 2026-05 時点)

| モデル | 入力 ($/1M tok) | 出力 ($/1M tok, 思考トークン含む) |
|---|---|---|
| `gemini-3.5-flash` | $1.50 | $9.00 |
| `gemini-3-flash-preview` (B4, 当時の `gemini-flash-latest` エイリアス実体) | 推定 | 推定 |
| `gemini-3.1-flash-lite` | 低価格帯 | 低価格帯 |

**現時点の推奨**:
- 既定モデル: 速度・コスト優先で `gemini-3.1-flash-lite` (GA, Temp 0)。低 prevalence データセット (cq1 / cq3) や wilson では Recall が大きく低下する点に留意。
- Recall を最重視したい場合のオプション: `gemini-3-flash-preview` (上表 B4 構成 = Temp 1.0 / TopP 0.95 / Thinking LOW)。
- `gemini-3.5-flash` は 2026-05 評価で depression Recall 93.2% (B4 比 -2.9pp) と既存モデルを上回らず、UI 公開は見送り。
- OpenRouter 系 (Kimi K2 / Qwen3 235B / DeepSeek V4 / Grok 4.3) は 2026-05 評価でいずれも depression 全件 Recall 95% 未満で、既定モデルの差し替え候補にはならず。`qwen3-235b-a22b-2507` のみ「コスト最重視の予算オプション」として `experiments/openrouter-bench/` で再現可能。

### 詳細レポート

- 初期評価 (B1–B4 比較): [experiments/report.md](experiments/report.md)
- Verification 実験: [experiments/report_verification.md](experiments/report_verification.md)
- `gemini-3.1-flash-lite-preview`: [experiments/gemini-3.1-flash-lite/report.md](experiments/gemini-3.1-flash-lite/report.md)
- `gemini-3.1-flash-lite` (GA): [experiments/gemini-3.1-flash-lite-ga/report.md](experiments/gemini-3.1-flash-lite-ga/report.md)
- `gemini-3.5-flash` (採用見送り): [experiments/gemini-3.5-flash/report.md](experiments/gemini-3.5-flash/report.md)
- OpenRouter 比較 (Kimi/Qwen/DeepSeek/Grok, 2026-05): [experiments/openrouter-bench/report.md](experiments/openrouter-bench/report.md)
- ASReview 比較: [experiments/asreview/REPORT.md](experiments/asreview/REPORT.md)

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
├── experiments/               # 実験用コード（LLM ベンチマーク結果含む）
│   ├── gemini-3.1-flash-lite/        # Preview 版評価 (2026-03)
│   ├── gemini-3.1-flash-lite-ga/     # GA 版評価 (2026-05)
│   └── openrouter-bench/             # Kimi/Qwen/DeepSeek/Grok 評価 (2026-05)
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

