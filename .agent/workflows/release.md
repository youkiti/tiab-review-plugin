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

## Web アプリ版のデプロイ（GitHub Pages / 自動）

Web アプリ版は **main への push で自動デプロイ**される。`.github/workflows/deploy-web.yml` が
`npm run build:web` で `docs/app/` を本番ビルドし、`docs/` 全体を GitHub Pages へ配信する。
OAuth クライアントID は repository variable `WEB_OAUTH_CLIENT_ID` から供給される。

- **通常運用**: main に push するだけ（`docs/app/` を手動コミットする必要はない。`.gitignore` 対象のまま）。
- **手動再デプロイ**: GitHub Actions の `deploy-web` ワークフローを workflow_dispatch で実行。
- 反映先: https://youkiti.github.io/tiab-review-plugin/app/
- ローカル動作確認: `npm run dev:web` 後に `npx http-server docs/app -p 8080` などで
  `http://localhost:8080` を開く（`localhost` を OAuth クライアントの承認済みオリジンに登録しておく）。
- OAuth クライアント（Web アプリ用）は拡張機能とは別に GCP で登録が必要。スコープは既存3つのまま増やさない。
- OAuth クライアントID を変更した場合は `gh variable set WEB_OAUTH_CLIENT_ID --body "<新ID>"` で更新する。

## 更新されるファイル

- `package.json` - version フィールド
- `src/manifest.json` - version フィールド
- `src/sidepanel/sidepanel.html` - Build日時
- `docs/app/` - Web アプリ版ビルド成果物（CI がビルドするためコミット不要）
