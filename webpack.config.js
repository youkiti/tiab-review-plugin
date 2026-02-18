const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const dotenv = require('dotenv');

dotenv.config();

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';
    const oauthClientIdFromEnv = process.env.OAUTH_CLIENT_ID?.trim();

    if (isProduction && !oauthClientIdFromEnv) {
        throw new Error('OAUTH_CLIENT_ID が未設定です。.env に OAUTH_CLIENT_ID を設定してから本番ビルドを実行してください。');
    }

    return {
        entry: {
            'background/service-worker': './src/background/service-worker.ts',
            'popup/popup': './src/popup/popup.ts',
            'sidepanel/sidepanel': './src/sidepanel/sidepanel.ts',
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
            ],
        },
        resolve: {
            extensions: ['.ts', '.js'],
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
                            }
                            return JSON.stringify(manifest, null, 4);
                        },
                    },
                    { from: 'src/popup/popup.html', to: 'popup/popup.html' },
                    { from: 'src/popup/popup.css', to: 'popup/popup.css' },
                    { from: 'src/sidepanel/sidepanel.html', to: 'sidepanel/sidepanel.html' },
                    { from: 'src/sidepanel/sidepanel.css', to: 'sidepanel/sidepanel.css' },
                    { from: 'src/sidepanel/styles', to: 'sidepanel/styles' },
                    { from: 'src/icons', to: 'icons' },
                ],
            }),
        ],
        optimization: {
            splitChunks: false,
        },
        devtool: 'source-map',
    };
};
