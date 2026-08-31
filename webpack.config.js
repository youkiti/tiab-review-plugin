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

// dev ビルドで OAuth 系の必須環境変数が未設定のときに fail-fast する既定を、
// 明示的にオプトインしたときだけ警告のみへ格下げするための環境変数。
// CI（.env が無い環境）はこれを立てて typecheck/lint/test 相当のビルド疎通確認だけ行う。
// 本番ビルドの throw はこの変数の影響を受けない（配布物にクライアントID欠落が
// 混入する事故を防ぐための最終防衛ラインのため、常に有効）。
const ALLOW_NO_AUTH = process.env.ALLOW_NO_AUTH === '1';

/**
 * dev ビルド用の必須環境変数チェック。未設定なら既定で例外を投げてビルドを止める
 * （クライアントID欠落のまま配布し、side-load 先のログイン時に初めて壊れているのが
 * 発覚する事故を防ぐため）。ALLOW_NO_AUTH=1 のときだけ警告に格下げして続行する。
 * 本番ビルドの throw は呼び出し元が別途行っており、この関数を経由しない。
 */
function requireEnvForDevOrWarn(message) {
    if (ALLOW_NO_AUTH) {
        console.warn(`[webpack] ${message}（ALLOW_NO_AUTH=1 指定のため警告のみで続行）`);
        return;
    }
    throw new Error(
        `${message}\n` +
        '認証を使わないローカル作業やCIでは環境変数 ALLOW_NO_AUTH=1 を指定すると警告のみで続行できます' +
        '（本番ビルドでは ALLOW_NO_AUTH を指定してもこのチェックは無効化されません）。'
    );
}

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
    // dev ビルドも既定で fail-fast する。未設定のまま zip 等で配布すると、ビルド元では
    // 何のエラーも出ないまま、side-load 先でのログイン時に初めて
    // 「Invalid OAuth2 Client ID.」として発覚する（Issue #76）。デモビルドは実認証を
    // 一切行わないため対象外。
    if (!webauthClientId && !isDemo) {
        requireEnvForDevOrWarn(
            'WEBAUTH_CLIENT_ID が未設定です。.env に WEBAUTH_CLIENT_ID を設定してください。' +
            '未設定のままビルドして配布すると、side-load 先でのログイン時に初めて' +
            '「Invalid OAuth2 Client ID.」エラーとして発覚します。'
        );
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
                    // デモビルドのみ: 全文デモ用の固定PDF（src/demo/fetch-mock.ts が
                    // chrome.runtime.getURL() 経由で読み込み、Drive files.get?alt=media の
                    // モック応答として返す）。生成手順は video/fixtures/demo-paper.pdf 内コメント参照。
                    ...(isDemo
                        ? [{ from: 'video/fixtures/demo-paper.pdf', to: 'fixtures/demo-paper.pdf' }]
                        : []),
                ],
            }),
        ],
        optimization: {
            splitChunks: false,
        },
        // 本番ビルドは 'hidden-source-map' にする（Issue #126）。変わらないのは
        // development ビルド（npm run dev / npm run watch）の方で、こちらは
        // devtool: 'source-map' のままで `//# sourceMappingURL=` も出るため、従来どおり
        // TypeScript のソースにマップされる（デバッグは通常こちらで行う）。
        // 一方、本番ビルドの dist/ は変わる: .map ファイル自体は出力され続けるが
        // sourceMappingURL コメントを出さないため、DevTools は dist/ に置かれた .map を
        // 自動では読み込まない（必要なら手動で "Add source map…" する）。
        // これにより scripts/pack-release.ps1 が dist.zip から .map を除いても、DevTools が
        // 参照先を探して 404 警告を出すことはない。本番でも .map を生成し続けるのは、
        // pack-release.ps1 が「0件なら devtool 設定が壊れている」と検知するカナリアに
        // 使うのと、手動 attach 用に残すため。
        devtool: isProduction ? 'hidden-source-map' : 'source-map',
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
    // dev ビルドも既定で fail-fast する（拡張版と同じ理由。Issue #76）。
    if (!webClientId) {
        requireEnvForDevOrWarn(
            'WEB_OAUTH_CLIENT_ID が未設定です。.env に Web アプリ用 OAuth クライアントIDを設定してください。' +
            '未設定のまま配信すると、Web版のログイン時に初めて認証エラーとして発覚します。'
        );
    }
    if (!pickerApiKey || !gcpProjectNumber) {
        requireEnvForDevOrWarn(
            'PICKER_API_KEY または GCP_PROJECT_NUMBER が未設定です。.env に両方を設定してください。' +
            '未設定のままだと Picker ページ利用時に初めてエラーとして発覚します。'
        );
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

    // タイトル: ブラウザ版であることが分かるよう「(ブラウザ版)」を明示する
    replaceOrThrow(
        '<title>TiAb Review - Screening</title>',
        '<title data-i18n="webapp_pageTitle">TiAb Review (ブラウザ版) - Screening</title>',
        'page title'
    );
    // ヘッダー見出し: 同様に「(ブラウザ版)」ラベルを付与する（拡張版の sidepanel.html 自体は変更しない）
    replaceOrThrow(
        '<h1>TiAb Review</h1>',
        '<h1>TiAb Review <span class="app-edition" data-i18n="webapp_editionLabel"></span></h1>',
        'header h1'
    );

    return html;
}
