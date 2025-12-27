---
description: ビルドしてzipを作成し、Google Driveにコピーする
---

# ビルド＆Zip作成

プロジェクトをビルドし、dist.zipを作成してGoogle Driveにコピーします。

## 前提条件
`.env` ファイルに `DIST_COPY_PATH` が設定されていること。

// turbo
1. 以下のコマンドを実行:
```bash
npm run build:zip
```

このコマンドは以下を実行します:
- `webpack --mode production` でビルド
- `dist/` フォルダをzip圧縮して `dist.zip` を作成
- `.env` の `DIST_COPY_PATH` で指定されたパスにコピー
