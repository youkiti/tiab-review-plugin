const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');
const dotenv = require('dotenv');
const packageJson = require('./package.json');

dotenv.config();

module.exports = (env, argv) => {
    // Web アプリ版ビルド（GitHub Pages 配信用）。既存の拡張機能ビルドとは完全に分岐する。
    if (env && env.target === 'web') {
        return buildWebConfig(argv);
    }
    return buildExtensionConfig(env, argv);
};

/**
 * Picker ページのURLを上書きする（dev ビルド限定）。
 * ローカル配信（例: http://localhost:8080/picker.html）で Picker 導線を検証するための口。
 * 本番ビルドでは環境変数があっても無視し、localhost が焼き込まれる事故を構造的に防ぐ。
 * 空文字を返した場合は src/lib/picker-url.ts が本番URLへフォールバックする。
 */
function resolvePickerPageUrlOverride(isProduction) {
    if (isProduction) return '';
    const override = process.env.PICKER_PAGE_URL?.trim();
    if (!override) return '';
    console.warn(`[webpack] Picker ページURLを上書きします（dev ビルド限定）: ${override}`);
    return override;
}

// =====================================================================
// 拡張機能ビルド
// 通常の dev/production ビルドの挙動は一切変更しない。`--env demo` 指定時のみ
// デモモード（Playwright 録画用。実credentials/実ネットワーク無し）に切り替わる。
// =====================================================================
function buildExtensionConfig(env, argv) {
    const isProduction = argv.mode === 'production';
    // デモビルド（Playwright録画用。実credentials/実ネットワーク無しでUIを動かす）。
    // `npm run build:demo`（webpack --mode development --env demo）で有効になる。
    const isDemo = Boolean(env && env.demo);
    // launchWebAuthFlow はリダイレクトURI（chromiumapp.org）を拡張機能IDから実行時に導出するため、
    // getAuthToken 時代のような拡張機能IDごとのクライアント選択は不要。ウェブアプリ型クライアント
    // 1つを全ビルド（dev/zip/store）で共用する。
    const webauthClientId = process.env.WEBAUTH_CLIENT_ID?.trim();
    // デモビルドは実認証を一切行わない（src/platform/demo が肩代わりする）ため、
    // WEBAUTH_CLIENT_ID 未設定でも本番モードのビルドを止めない。
    if (isProduction && !webauthClientId && !isDemo) {
        throw new Error('WEBAUTH_CLIENT_ID が未設定です。.env に WEBAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。');
    }
    if (!webauthClientId && !isDemo) {
        console.warn('[webpack] WEBAUTH_CLIENT_ID が未設定です（dev ビルド）。Google認証は動作しません。');
    }
    const pickerPageUrl = resolvePickerPageUrlOverride(isProduction);

    return {
        entry: {
            'background/service-worker': './src/background/service-worker.ts',
            'popup/popup': isDemo ? './src/demo/popup-entry.ts' : './src/popup/popup.ts',
            'sidepanel/sidepanel': isDemo ? './src/demo/sidepanel-entry.ts' : './src/sidepanel/sidepanel.ts',
            'fulltext/fulltext': isDemo ? './src/demo/fulltext-entry.ts' : './src/fulltext/fulltext.ts',
        },
        output: {
            path: path.resolve(__dirname, isDemo ? 'dist-demo' : 'dist'),
            filename: '[name].js',
            clean: true,
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    // pdfjs-dist は ESM(.mjs)。完全指定(fullySpecified)を緩めないと
                    // 内部の拡張子なし import を webpack が解決できずビルドが落ちる。
                    test: /\.mjs$/,
                    include: /node_modules/,
                    type: 'javascript/auto',
                    resolve: { fullySpecified: false },
                },
                {
                    // デモモードのシード（src/demo/seed.ts）が PubMed サンプルデータを
                    // テキストとして bundle へ取り込むための rule。demo エントリ以外からは
                    // 参照されないため、通常ビルドの出力には影響しない。
                    test: /\.nbib$/,
                    type: 'asset/source',
                },
            ],
        },
        resolve: {
            extensions: ['.ts', '.js', '.mjs'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        plugins: [
            new webpack.DefinePlugin({
                __EXTENSION_OAUTH_CLIENT_ID__: JSON.stringify(webauthClientId ?? ''),
                __PICKER_PAGE_URL__: JSON.stringify(pickerPageUrl),
                __DEMO__: JSON.stringify(isDemo),
            }),
            ...(isDemo
                ? [
                    // sidepanel/fulltext/popup の `import { chromePlatform } from '../platform/chrome'`
                    // を実クロームアダプタからデモアダプタ（src/platform/demo）へ差し替える。
                    // 既存ソースは一切書き換えず、ビルド設定だけで挙動を切り替えるための仕組み。
                    new webpack.NormalModuleReplacementPlugin(
                        /platform\/chrome$/,
                        path.resolve(__dirname, 'src/platform/demo/index.ts')
                    ),
                ]
                : []),
            new CopyPlugin({
                patterns: [
                    {
                        from: 'src/manifest.json',
                        to: 'manifest.json',
                        transform(content) {
                            const manifest = JSON.parse(content.toString('utf8'));

                            // 本番ビルドは原則 key を削除する（ストア提出ではストア側が ID を付与するため）。
                            // ただし zip 配布（テスター向け, --env keepKey）では src/manifest.json の key を
                            // 保持し、全テスターが同じ固定の拡張機能ID (ifnejjicfekmighagknaacliiiliodgf) になる
                            // ようにする。launchWebAuthFlow のリダイレクトURI
                            // （https://<拡張機能ID>.chromiumapp.org/）は拡張機能IDから実行時に導出されるため、
                            // key を消してIDがランダム化すると WEBAUTH_CLIENT_ID に登録した承認済みリダイレクト
                            // URIのどちらとも一致せず認可に失敗する。
                            // Chrome 設定画面・ツールバーでストア版と区別できるよう、名称末尾に
                            // " (dev)" を付与するヘルパー。name は __MSG_extName__ プレースホルダを
                            // 含むが、Chrome i18n は文字列中のプレースホルダを置換するため後ろに連結
                            // しても問題ない。dev ビルドと zip 配布ビルドの両方で使う
                            // （どちらもストアではない side-load 版のため）。
                            const appendDevSuffix = () => {
                                manifest.name = `${manifest.name} (dev)`;
                                if (manifest.action?.default_title) {
                                    manifest.action.default_title = `${manifest.action.default_title} (dev)`;
                                }
                            };

                            if (isDemo) {
                                // デモビルド: key はそのまま保持する（Playwrightでの拡張機能ID固定のため）。
                                // (dev) ではなく (demo) サフィックスでストア版・dev版と区別する。
                                manifest.name = `${manifest.name} (demo)`;
                                if (manifest.action?.default_title) {
                                    manifest.action.default_title = `${manifest.action.default_title} (demo)`;
                                }
                            } else if (isProduction && env.keepKey) {
                                // zip 配布: key はそのまま保持し、(dev) サフィックスでストア版と区別する
                                appendDevSuffix();
                            } else if (isProduction) {
                                delete manifest.key;
                            } else {
                                appendDevSuffix();
                            }
                            return JSON.stringify(manifest, null, 4);
                        },
                    },
                    { from: 'src/popup/popup.html', to: 'popup/popup.html' },
                    { from: 'src/popup/popup.css', to: 'popup/popup.css' },
                    { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel/sidepanel.html' },
                    { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel/sidepanel.css' },
                    { from: 'src/sidepanel/styles', to: 'sidepanel/styles' },
                    { from: 'src/fulltext/fulltext.html', to: 'fulltext/fulltext.html' },
                    { from: 'src/fulltext/fulltext.css', to: 'fulltext/fulltext.css' },
                    { from: 'src/icons', to: 'icons' },
                    { from: 'src/_locales', to: '_locales' },
                    // PDF.js: worker は remote script 禁止のためローカル同梱して dist 直下に置く。
                    // pdf-renderer.ts が chrome.runtime.getURL('pdf.worker.min.mjs') で参照する。
                    { from: 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', to: 'pdf.worker.min.mjs' },
                    // 一部PDFの正しい描画に必要な CMap / 標準フォント（オンデマンド読込）。
                    { from: 'node_modules/pdfjs-dist/cmaps', to: 'cmaps' },
                    { from: 'node_modules/pdfjs-dist/standard_fonts', to: 'standard_fonts' },
                ],
            }),
        ],
        optimization: {
            splitChunks: false,
        },
        devtool: 'source-map',
    };
}

// =====================================================================
// Web アプリビルド（GitHub Pages: docs/app/ へ出力）
// =====================================================================
function buildWebConfig(argv) {
    const isProduction = argv.mode === 'production';
    const webClientId = process.env.WEB_OAUTH_CLIENT_ID?.trim();
    const pickerApiKey = process.env.PICKER_API_KEY?.trim();
    const gcpProjectNumber = process.env.GCP_PROJECT_NUMBER?.trim();
    if (isProduction && !webClientId) {
        throw new Error('WEB_OAUTH_CLIENT_ID が未設定です。.env に Web アプリ用 OAuth クライアントIDを設定してください。');
    }
    if (isProduction && !pickerApiKey) {
        throw new Error('PICKER_API_KEY が未設定です。.env に Google Picker API key を設定してください。');
    }
    if (isProduction && !gcpProjectNumber) {
        throw new Error('GCP_PROJECT_NUMBER が未設定です。.env に GCP プロジェクト番号を設定してください。');
    }
    if (!webClientId) {
        console.warn('[webpack] WEB_OAUTH_CLIENT_ID が未設定です（dev ビルド）。Google認証は動作しません。');
    }
    if (!pickerApiKey || !gcpProjectNumber) {
        console.warn('[webpack] PICKER_API_KEY または GCP_PROJECT_NUMBER が未設定です（dev ビルド）。Pickerページは動作しません。');
    }
    return {
        entry: { app: './src/webapp/index.ts', picker: './src/webapp/picker.ts' },
        output: {
            path: path.resolve(__dirname, 'docs/app'),
            filename: '[name].js',
            // docs/app はビルド成果物専用ディレクトリとして全消去してよい。
            clean: true,
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    test: /\.mjs$/,
                    include: /node_modules/,
                    type: 'javascript/auto',
                    resolve: { fullySpecified: false },
                },
            ],
        },
        resolve: {
            extensions: ['.ts', '.js', '.mjs'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        plugins: [
            new webpack.DefinePlugin({
                __WEB_OAUTH_CLIENT_ID__: JSON.stringify(webClientId ?? ''),
                __PICKER_API_KEY__: JSON.stringify(pickerApiKey ?? ''),
                __GCP_PROJECT_NUMBER__: JSON.stringify(gcpProjectNumber ?? ''),
                __PICKER_PAGE_URL__: JSON.stringify(resolvePickerPageUrlOverride(isProduction)),
                __APP_VERSION__: JSON.stringify(packageJson.version),
            }),
            new CopyPlugin({
                patterns: [
                    {
                        from: 'src/sidepanel/sidepanel.html',
                        to: 'index.html',
                        transform: transformSidepanelHtml,
                    },
                    { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel.css' },
                    { from: 'src/sidepanel/styles', to: 'styles' },
                    { from: 'src/webapp/webapp.css', to: 'webapp.css' },
                    { from: 'src/webapp/picker.html', to: 'picker.html' },
                    { from: 'src/icons/icon128.png', to: 'icon128.png' }, // favicon 用
                ],
            }),
        ],
        optimization: { splitChunks: false },
        devtool: isProduction ? false : 'source-map',
    };
}

/**
 * 拡張用 sidepanel.html を Web 用 index.html へ機械変換する。
 * HTML に新機能が追加されたとき Web 版へ自動反映させるため、複製ではなく変換で生成する。
 * 変換対象の行が将来書き換わって見つからなくなった場合は、古い形式のまま出力されるのを
 * 防ぐために例外を投げる。
 */
function transformSidepanelHtml(content) {
    let html = content.toString('utf8');

    const replaceOrThrow = (search, replacement, label) => {
        if (!html.includes(search)) {
            throw new Error(`[webpack] Web用HTML変換に失敗: "${label}" が sidepanel.html に見つかりません。変換ルールの更新が必要です。`);
        }
        html = html.replace(search, replacement);
    };

    // viewport: 既存の meta を置換（モバイル + セーフエリア対応）
    replaceOrThrow(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        'viewport meta'
    );
    // CSS: webapp.css と favicon を追加
    replaceOrThrow(
        '<link rel="stylesheet" href="sidepanel.css">',
        '<link rel="stylesheet" href="sidepanel.css">\n    <link rel="stylesheet" href="webapp.css">\n    <link rel="icon" href="icon128.png">',
        'stylesheet link'
    );
    // script: 拡張用 sidepanel.js を GIS + Web エントリ app.js に置換
    replaceOrThrow(
        '<script src="sidepanel.js"></script>',
        '<script src="https://accounts.google.com/gsi/client" async defer></script>\n    <script src="app.js"></script>',
        'entry script'
    );
    // body: FOUC 防止のため web-app クラスを付与（JS 側でも付与するが二重で問題ない）
    replaceOrThrow('<body>', '<body class="web-app">', 'body tag');

    return html;
}
