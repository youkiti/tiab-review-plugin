module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2020: true,
  },
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
  },
  rules: {
    "no-undef": "off",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "no-constant-condition": "off",
    "no-useless-escape": "off",
    // 共有コード（デフォルト）: chrome グローバルの直接参照を禁止する。
    // 表示・判定系の新機能を書いても自動で Web 版に載る状態を機械的に保証するため、
    // 拡張専用機能（下の overrides の許可リスト）以外では platform() アダプタを経由させる。
    "no-restricted-globals": ["error", {
      name: "chrome",
      message: "共有コードで chrome API を直接使わない。src/platform/ のアダプタを経由すること（Web版ビルドが壊れる）。",
    }],
  },
  overrides: [
    {
      // 拡張専用ファイル: Web バンドルに含めないため chrome 直接参照を許可する。
      files: [
        "src/platform/chrome/**",
        "src/background/**",
        "src/popup/**",
        "src/fulltext/**",
        "src/lib/storage.ts",
        // chrome.storage.sync（デバイス間同期）を使用。PlatformAdapter は local 相当のみ抽象化しており
        // sync に対応する概念が無いため、storage.ts と同様に拡張専用として直接 chrome API を使う。
        "src/lib/share-email-history.ts",
        "src/lib/gemini-api.ts",
        "src/lib/llm-provider.ts",
        "src/lib/llm-processor.ts",
        "src/lib/providers/**",
        "src/lib/pdf-image-only.ts",
        "src/sidepanel/sidepanel.ts",
        "src/sidepanel/features/llm/**",
        "src/sidepanel/features/ml/**",
        "src/sidepanel/features/fulltext-*.ts",
        "src/sidepanel/features/import-export.ts",
        "src/sidepanel/features/manuscript.ts",
      ],
      rules: {
        "no-restricted-globals": "off",
      },
    },
  ],
};
