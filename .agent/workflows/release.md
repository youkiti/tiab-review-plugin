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

## 更新されるファイル

- `package.json` - version フィールド
- `src/manifest.json` - version フィールド
- `src/sidepanel/sidepanel.html` - Build日時
