import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  { ignores: ["**/*.js", "**/*.mjs", "**/*.cjs"] },
  {
    files: ["**/*.ts"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.es2020 },
      parser: tsParser,
      ecmaVersion: 2020,
      sourceType: "module",
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...js.configs.recommended.rules,
      // ESLint 8.57 の recommended に無かった規則。移行では検出の範囲を変えない。
      "no-constant-binary-expression": "off",
      "no-empty-static-block": "off",
      "no-unassigned-vars": "off",
      "no-unused-private-class-members": "off",
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      // ESLint 8 と同じく、ブロック内の関数宣言も検出する。
      "no-inner-declarations": ["error", "functions", { blockScopedFunctions: "disallow" }],
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
  },
  ...[
    {
      // Issue #157: 現状0件の lib → UI 違反を編集時にも検出する。
      files: ["src/lib/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [{
          group: ["**/sidepanel", "**/sidepanel/**", "**/fulltext", "**/fulltext/**", "**/guide-ui", "**/guide-ui/**", "**/popup", "**/popup/**", "**/webapp", "**/webapp/**", "**/background", "**/background/**", "**/demo", "**/demo/**"],
          message: "純関数・保存APIは src/lib/、画面と処理の調整は src/sidepanel/ に置き、lib から画面を参照しないでください。",
        }] }],
      },
    },
    {
      // platform → demo の既存1件だけは構造検査の基準値で管理する。
      files: ["src/platform/**"],
      rules: {
        "no-restricted-imports": ["error", { patterns: [{
          group: ["**/sidepanel", "**/sidepanel/**", "**/fulltext", "**/fulltext/**", "**/guide-ui", "**/guide-ui/**", "**/popup", "**/popup/**", "**/webapp", "**/webapp/**", "**/background", "**/background/**", "**/lib", "**/lib/**"],
          message: "純関数・保存APIは src/lib/、画面と処理の調整は src/sidepanel/ に置き、platform から上位を参照しないでください。",
        }] }],
      },
    },
    {
      // 拡張専用ファイル: Web バンドルに含めないため chrome 直接参照を許可する。
      files: [
        "src/platform/chrome/**",
        "src/background/**",
        "src/popup/**",
        "src/fulltext/**",
        "src/lib/storage.ts",
        "src/lib/api-key-store.ts",
        // chrome.storage.sync（デバイス間同期）を使用。PlatformAdapter は local 相当のみ抽象化しており
        // sync に対応する概念が無いため、storage.ts と同様に拡張専用として直接 chrome API を使う。
        "src/lib/share-email-history.ts",
        "src/lib/gemini-api.ts",
        "src/lib/llm-provider.ts",
        "src/lib/llm-processor.ts",
        "src/lib/providers/**",
        "src/lib/pdf-image-only.ts",
        // chrome.identity.launchWebAuthFlow で Picker を開く再付与フロー。呼び出し元は
        // サイドパネルとフルテキストページ（どちらも拡張専用）のみで、Web版は独自の
        // Picker フローを持つため PlatformAdapter へは載せない。
        "src/lib/drive-regrant-picker.ts",
        "src/sidepanel/sidepanel.ts",
        "src/sidepanel/features/llm/**",
        "src/sidepanel/features/ml/**",
        "src/sidepanel/features/fulltext/**",
        "src/sidepanel/features/import-export.ts",
        "src/sidepanel/features/manuscript.ts",
      ],
      rules: {
        "no-restricted-globals": "off",
      },
    },
    {
      // デモモード専用コード: Playwright録画用のモック実装で chrome.storage を直接使う。
      // Web版ビルドには含まれない（webpack.config.js の `--env demo` 経由でのみ使用）。
      files: [
        "src/demo/**",
        "src/platform/demo/**",
      ],
      rules: {
        "no-restricted-globals": "off",
      },
    },
  ].map(config => ({
    ...config,
    files: config.files.map(pattern => ["**/*.ts", pattern]),
  })),
];
