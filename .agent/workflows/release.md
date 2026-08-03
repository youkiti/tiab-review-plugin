---
description: バージョンを自動更新してChrome Web Store用のリリースビルドを作成する
---

# バージョン管理コマンド

## バージョンバンプのみ

バージョンは `0.<major>.<minor>` 形式（先頭の 0 は固定）。

// turbo
```bash
npm run bump          # = bump:minor（デフォルト）
npm run bump:minor    # 修正・小変更 (0.33.2 → 0.33.3)
npm run bump:major    # 機能追加     (0.33.2 → 0.34.0)
```

1.0.0 など先頭の数字を動かす場合のみ明示指定する:

```bash
powershell -ExecutionPolicy Bypass -File ./scripts/bump-version.ps1 -SetVersion "1.0.0"
```

## リリース（バンプ + ストア用ビルド）

リリースビルドは常に Chrome Web Store 用（`key` 削除 + `.env` の `WEBAUTH_CLIENT_ID`）。
zip を Google Drive で配布する経路は廃止済み（最終配布は v0.24.0）。

// turbo
```bash
npm run release        # = release:minor（デフォルト）
npm run release:minor  # 0.33.2 → 0.33.3 + ビルド + dist.zip
npm run release:major  # 0.33.2 → 0.34.0 + ビルド + dist.zip
```

生成された **`dist.zip`** を Chrome Web Store デベロッパーダッシュボードへアップロードする。

> **ファイル名は `dist.zip` 固定**。バージョン付きの名前（`dist-store-v0.25.0.zip` 等）ではストアへアップロードできない。

## Web アプリ版のデプロイ（GitHub Pages / 自動）

Web アプリ版は **main への push で自動デプロイ**される。`.github/workflows/deploy-web.yml` が
`npm run build:web` で `docs/app/` を本番ビルドし、`docs/` 全体を GitHub Pages へ配信する。
ビルドに必要な値は repository **variables**（secrets ではない）から供給される: `WEB_OAUTH_CLIENT_ID` /
`PICKER_API_KEY` / `GCP_PROJECT_NUMBER`。

> ⚠️ **`build:web` は本番モードのため、これらが未設定だとデプロイだけが落ちる。**
> PR の `build-check.yml` は `dev` / `dev:web`（開発モード = 未設定でも警告のみ）しか回さないので、
> **CI green でもデプロイが失敗しうる**。新しい注入変数を足すときは repository variables への
> 登録を先に済ませること（2026-07-16 の Picker 移行で実際に踏みかけた）。

- **通常運用**: main に push するだけ（`docs/app/` を手動コミットする必要はない。`.gitignore` 対象のまま）。
- **手動再デプロイ**: GitHub Actions の `deploy-web` ワークフローを workflow_dispatch で実行。
- 反映先: https://youkiti.github.io/tiab-review-plugin/app/
- ローカル動作確認: `npm run dev:web` 後に `npx http-server docs/app -p 8080` などで
  `http://localhost:8080` を開く（`localhost` を OAuth クライアントの承認済みオリジンに登録しておく）。
- OAuth クライアント（Web アプリ用）は拡張機能とは別に GCP で登録が必要。**スコープは `userinfo.email` と
  `drive.file` の2つ**（いずれも非機微）。**増やさない** — 機微スコープを1つでも要求した瞬間に
  OAuth 審査と100人上限が復活する（2026-07 の `spreadsheets` 廃止はこれが理由）。
- OAuth クライアントID を変更した場合は `gh variable set WEB_OAUTH_CLIENT_ID --body "<新ID>"` で更新する。
- Picker ページ（`docs/app/picker.html`）を拡張から検証する場合は、dev ビルド限定で
  `PICKER_PAGE_URL=http://localhost:8080/picker.html npm run dev` とすると導線をローカルへ向けられる
  （本番ビルドはこの環境変数を無視するため、localhost が焼き込まれる事故は起きない）。

## 更新されるファイル

- `package.json` - version フィールド
- `src/manifest.json` - version フィールド
- `src/sidepanel/sidepanel.html` - Build日時
- `docs/app/` - Web アプリ版ビルド成果物（CI がビルドするためコミット不要）
