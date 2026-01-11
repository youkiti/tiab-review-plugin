const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

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
