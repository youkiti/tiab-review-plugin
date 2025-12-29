---
description: バージョンを自動更新してビルド・リリースする
---

# バージョン管理コマンド

## バージョンバンプのみ

// turbo
```bash
npm run bump          # パッチ +1 (0.3.0 → 0.3.1)
npm run bump:minor    # マイナー +1 (0.3.1 → 0.4.0)
npm run bump:major    # メジャー +1 (0.4.0 → 1.0.0)
```

## バンプ + ビルド

// turbo
```bash
npm run release       # バンプ + ビルド
```

## バンプ + ビルド + zip + Driveコピー

// turbo
```bash
npm run release:zip   # バンプ + ビルド + zip + Driveにコピー
```

## 更新されるファイル

- `package.json` - version フィールド
- `src/manifest.json` - version フィールド
- `src/sidepanel/sidepanel.html` - Build日時
