const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const dotenv = require('dotenv');

dotenv.config();

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';
    // 開発モード: LOCAL_OAUTH_CLIENT_ID → OAUTH_CLIENT_ID の順にフォールバック
    // 本番モード: OAUTH_CLIENT_ID（ストア用）を使用
    const oauthClientIdFromEnv = isProduction
        ? process.env.OAUTH_CLIENT_ID?.trim()
        : (process.env.LOCAL_OAUTH_CLIENT_ID?.trim() || process.env.OAUTH_CLIENT_ID?.trim());

    if (isProduction && !oauthClientIdFromEnv) {
        throw new Error('OAUTH_CLIENT_ID が未設定です。.env に OAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。');
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

                            if (isProduction) {
                                delete manifest.key;
                            } else {
                                // 開発ビルドは Chrome 設定画面・ツールバーで本番版と区別できるよう
                                // 拡張機能名とツールチップ末尾に " (dev)" を付与する。
                                // name は __MSG_extName__ プレースホルダを含むが、Chrome i18n は
                                // 文字列中のプレースホルダを置換するため後ろに連結しても問題ない。
                                manifest.name = `${manifest.name} (dev)`;
                                if (manifest.action?.default_title) {
                                    manifest.action.default_title = `${manifest.action.default_title} (dev)`;
                                }
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
};
