# Agent Instructions

このプロジェクトで作業する際の注意事項。

## バージョン管理

バージョンを更新する際は、**必ず以下の2つのファイルを同時に更新すること**：

1. `package.json` - `"version"` フィールド
2. `src/manifest.json` - `"version"` フィールド

Chrome拡張機能は `manifest.json` のバージョンを表示するため、両方が一致していないとユーザーに表示されるバージョンがずれる。
