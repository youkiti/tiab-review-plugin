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

// =====================================================================
// 拡張機能ビルド（既存設定。挙動は一切変更しない）
// =====================================================================
function buildExtensionConfig(env, argv) {
    const isProduction = argv.mode === 'production';
    // OAuth クライアントIDの選択（クライアントは拡張機能IDごとに登録が必要）:
    //   - dev ビルド        : LOCAL_OAUTH_CLIENT_ID（ID: ifnejji… に登録、無ければ OAUTH_CLIENT_ID にフォールバック）
    //   - zip 配布(keepKey) : ZIP_OAUTH_CLIENT_ID（ID: ifnejji… に登録した専用クライアント）
    //   - 本番/ストア提出    : OAUTH_CLIENT_ID（ストアID: alejln… に登録）
    // zip 配布は key を保持するため ID が ifnejji… に固定される。ストア用 OAUTH_CLIENT_ID は
    // alejln… に紐づくので使えず、ifnejji… 用の ZIP_OAUTH_CLIENT_ID が必要。
    let oauthClientIdFromEnv;
    if (isProduction && env.keepKey) {
        oauthClientIdFromEnv = process.env.ZIP_OAUTH_CLIENT_ID?.trim();
        if (!oauthClientIdFromEnv) {
            throw new Error('ZIP_OAUTH_CLIENT_ID が未設定です。zip 配布版（拡張機能ID: ifnejjicfekmighagknaacliiiliodgf）用の OAuth クライアントIDを .env に設定してください。');
        }
    } else if (isProduction) {
        oauthClientIdFromEnv = process.env.OAUTH_CLIENT_ID?.trim();
        if (!oauthClientIdFromEnv) {
            throw new Error('OAUTH_CLIENT_ID が未設定です。.env に OAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。');
        }
    } else {
        oauthClientIdFromEnv = process.env.LOCAL_OAUTH_CLIENT_ID?.trim() || process.env.OAUTH_CLIENT_ID?.trim();
    }

    return {
        entry: {
            'background/service-worker': './src/background/service-worker.ts',
            'popup/popup': './src/popup/popup.ts',
            'sidepanel/sidepanel': './src/sidepanel/sidepanel.ts',
            'fulltext/fulltext': './src/fulltext/fulltext.ts',
        },
        output: {
            path: path.resolve(__dirname, 'dist'),
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
            ],
        },
        resolve: {
            extensions: ['.ts', '.js', '.mjs'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        plugins: [
            new CopyPlugin({
                patterns: [
                    {
                        from: 'src/manifest.json',
                        to: 'manifest.json',
                        transform(content) {
                            const manifest = JSON.parse(content.toString('utf8'));

                            if (manifest.oauth2 && oauthClientIdFromEnv) {
                                manifest.oauth2.client_id = oauthClientIdFromEnv;
                            }

                            const oauthClientId = manifest.oauth2?.client_id;
                            if (!oauthClientId || oauthClientId === '__OAUTH_CLIENT_ID__') {
                                console.warn('[webpack] OAUTH_CLIENT_ID が未設定です。Google認証は動作しません。');
                            }

                            // 本番ビルドは原則 key を削除する（ストア提出ではストア側が ID を付与するため）。
                            // ただし zip 配布（テスター向け, --env keepKey）では src/manifest.json の key を
                            // 保持し、全テスターが同じ固定の拡張機能ID (ifnejjicfekmighagknaacliiiliodgf) になる
                            // ようにする。key を消すとインストール先ごとにランダムIDになり、OAuthクライアントの
                            // 登録IDと一致せず "bad client id" で失敗する。この ID 用の OAuth クライアントは
                            // ZIP_OAUTH_CLIENT_ID（上で選択済み）を使う。
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

                            if (isProduction && env.keepKey) {
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
    if (isProduction && !webClientId) {
        throw new Error('WEB_OAUTH_CLIENT_ID が未設定です。.env に Web アプリ用 OAuth クライアントIDを設定してください。');
    }
    if (!webClientId) {
        console.warn('[webpack] WEB_OAUTH_CLIENT_ID が未設定です（dev ビルド）。Google認証は動作しません。');
    }
    return {
        entry: { app: './src/webapp/index.ts' },
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
