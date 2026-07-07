---
description: バージョンを自動更新してChrome Web Store用のリリースビルドを作成する
---

# バージョン管理コマンド

## バージョンバンプのみ

// turbo
```bash
npm run bump          # パッチ +1 (0.3.0 → 0.3.1)
npm run bump:minor    # マイナー +1 (0.3.1 → 0.4.0)
npm run bump:major    # メジャー +1 (0.4.0 → 1.0.0)
```

## リリース（バンプ + ストア用ビルド）

リリースビルドは常に Chrome Web Store 用（`key` 削除 + `OAUTH_CLIENT_ID`）。
zip を Google Drive で配布する経路は廃止済み（最終配布は v0.24.0）。

// turbo
```bash
npm run release        # patch bump + ビルド + dist-store-v<version>.zip
npm run release:minor  # minor bump + ビルド + dist-store-v<version>.zip
```

生成された `dist-store-v<version>.zip` を Chrome Web Store デベロッパーダッシュボードへアップロードする。

`npm run release` / `release:minor` は末尾で `npm run build:web` も実行し、Web アプリ版を
`docs/app/` に本番ビルドする（`.env` の `WEB_OAUTH_CLIENT_ID` が必須）。

## Web アプリ版のデプロイ（GitHub Pages）

Web アプリ版は `docs/app/` を GitHub Pages（main の /docs 配信）でそのまま配信する。
`docs/app/` はビルド成果物であり `.gitignore` 対象のため、デプロイ時のみ明示的にコミットする。
拡張機能の差分と混ざらないよう、Web ビルド成果物は独立コミットに分離すること。

```bash
npm run build:web                     # .env の WEB_OAUTH_CLIENT_ID を使い docs/app/ を本番ビルド
git add -f docs/app                    # .gitignore を上書きして成果物を明示的にステージ
git commit -m "chore: deploy web app v<version>"
# main へマージすると https://youkiti.github.io/tiab-review-plugin/app/ が更新される
```

- ローカル動作確認: `npm run dev:web` 後に `npx http-server docs/app -p 8080` などで
  `http://localhost:8080` を開く（`localhost` を OAuth クライアントの承認済みオリジンに登録しておく）。
- OAuth クライアント（Web アプリ用）は拡張機能とは別に GCP で登録が必要。スコープは既存3つのまま増やさない。

## 更新されるファイル

- `package.json` - version フィールド
- `src/manifest.json` - version フィールド
- `src/sidepanel/sidepanel.html` - Build日時
- `docs/app/` - Web アプリ版ビルド成果物（デプロイ時に `git add -f` で別コミット）
