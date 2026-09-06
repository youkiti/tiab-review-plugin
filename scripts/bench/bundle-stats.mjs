#!/usr/bin/env node
// バンドル統計スクリプト（Issue #151（#150 工程0）チャンク3b）
//
// webpack の Node API を直接呼び、拡張版・Web版のproduction バンドルを隔離した出力先
// （.tmp/bench/bundle/…）へ一時的にビルドして stats を取得する。webpack.config.js の
// `--env outDir=` 上書き機構（本チャンクで追加）を使うため、通常の `dist/` `docs/app/`
// （配布物）には一切書き込まない。
//
// production ビルドは `.env` が無い環境（git worktree 等）だと WEBAUTH_CLIENT_ID 等の
// 未設定で fail-fast するため、AGENTS.md「`.env` が無い環境で production ビルドを検証する」
// と同じプレースホルダー環境変数を渡す。バンドル統計は計測専用で配布物を作らないため、
// 実際の `.env` が存在する環境でも常にプレースホルダーで上書きする
// （本物のクライアントIDが計測用ビルドに混入する事故を構造的に防ぐため）。
//
// **出力にソース本文は一切含めない**（stats.toJson({ source: false }) を必ず通す。
// 親Issue #150 の明示要求）。出すのは:
//   - エントリポイント別の初期ロード資産（アセット名・バイト数、JSのみの合計と全体の合計）
//   - 遅延（非初期）チャンクの一覧とサイズ
//   - サイズ上位20モジュール（モジュール名＝パスとサイズのみ）
//   - pdfjs-dist 由来モジュールの合計サイズと、それがどのエントリポイントの初期ロードに
//     入っているか（工程4 #155 の判断材料）
//   - .map ファイルは初期JS量の集計から除外し、別枠で合計だけ出す
//
// 使い方:
//   npm run bench:bundle
//   npm run bench:bundle -- --out <dir>   # 既定 .tmp/bench

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.tmp/bench');
const BUNDLE_TMP_DIR = path.join(REPO_ROOT, '.tmp/bench/bundle');

// AGENTS.md「`.env` が無い環境（git worktree 等）で production ビルドを検証する」節のとおり、
// これらは webpack DefinePlugin の文字列置換にしか使われないためプレースホルダーで良い。
// 上記コメントのとおり、既存の .env を上書きしてでも常にプレースホルダーを使う。
process.env.WEBAUTH_CLIENT_ID = 'placeholder';
process.env.WEB_OAUTH_CLIENT_ID = 'placeholder';
process.env.PICKER_API_KEY = 'placeholder';
process.env.GCP_PROJECT_NUMBER = '000000000000';

const webpack = require('webpack');
// webpack.config.js は `(env, argv) => config` を export する CommonJS。.mjs からは
// createRequire 経由で読み込む（scripts/bench/run.mjs が package.json を読むのと同じ手法）。
const webpackConfigFactory = require(path.join(REPO_ROOT, 'webpack.config.js'));

// ============================================================
// 引数パース
// ============================================================

function printHelp() {
    console.log(`バンドル統計スクリプト（Issue #151（#150 工程0）チャンク3b）

使い方:
  npm run bench:bundle -- [オプション]

オプション（すべて省略可）:
  --out <dir>   出力先ディレクトリ（既定 .tmp/bench）
  --help, -h    このヘルプを表示
`);
}

function parseArgs(argv) {
    const options = { outDir: DEFAULT_OUT_DIR };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            case '--out': {
                const value = argv[++i];
                if (!value) throw new Error('--out には出力ディレクトリを指定してください');
                options.outDir = path.resolve(value);
                break;
            }
            default:
                throw new Error(`不明な引数です: ${arg}（--help でヘルプを表示）`);
        }
    }
    return options;
}

// ============================================================
// webpack 実行
// ============================================================

/** 1回分の webpack ビルドを実行し、ソース本文を含まない stats JSON を返す。 */
function runBuild(config) {
    return new Promise((resolve, reject) => {
        webpack(config, (err, stats) => {
            if (err) {
                reject(err);
                return;
            }
            const json = stats.toJson({
                all: false,
                // ids:false（all:falseの既定）だとチャンク/モジュールの id が出ず、
                // entrypoints[name].chunks やモジュールの .chunks が undefined のまま
                // エントリ⇔モジュールの対応が一切取れなくなる（実際にこれで
                // summarizePdfjsDist() が常に「初期ロードに含まれるエントリ: なし」を
                // 返す不具合を踏んだ）。id の出力を明示的に有効にする。
                ids: true,
                assets: true,
                // .map ファイルは通常の assets 一覧には現れない（webpackはソースマップを
                // 対応するJSアセットの「関連アセット」として扱い、既定では独立集計しない。
                // 実測で確認済み: `stats.toJson('verbose')` でも .map は出てこない）。
                // relatedAssets を有効にすると各JSアセットの `.related`（type:'sourceMap' 等）
                // からサイズを取得できる。
                relatedAssets: true,
                chunks: true,
                modules: true,
                // Issue #155: 永続キャッシュ再利用時も依存一覧から既存モジュールを落とさない。
                cachedModules: true,
                // webpack の既定プリセットは concatenateModules（production既定）でまとまった
                // モジュールの内訳や、モジュール一覧そのものを既定の上限（15件程度）で打ち切り
                // 「filteredChildren」付きの集約エントリ（type: "orphan modules" 等。名前もサイズも
                // 個別には出ない）に丸めてしまう。pdfjs-dist 等の実体を個別に拾うには、内訳の
                // 展開（nestedModules）と上限の解除（*Space: Infinity）、"orphan"扱いのモジュールを
                // 集約せず個別に出す（orphanModules）の3つが必要。
                nestedModules: true,
                modulesSpace: Infinity,
                nestedModulesSpace: Infinity,
                orphanModules: true,
                entrypoints: true,
                errors: true,
                errorDetails: true,
                warnings: true,
                source: false, // 親Issue #150 の明示要求: ソース本文は絶対に含めない
            });
            if (stats.hasErrors()) {
                const messages = (json.errors || []).map((e) => (e && e.message) || String(e));
                reject(new Error(`webpack ビルドに失敗しました:\n${messages.join('\n')}`));
                return;
            }
            resolve(json);
        });
    });
}

// ============================================================
// 集計
// ============================================================

/**
 * モジュール一覧を実モジュール（葉）だけに平坦化し、各葉へ実際に含まれるチャンクID
 * （`.chunks`）を解決して持たせる。
 *
 * production の既定（concatenateModules）でまとまった「./src/x.ts + N modules」のような
 * 集約エントリは `.modules` に元の個々のモジュールを内包するため、集約エントリ自身は
 * 含めず内包分だけを展開する（集約側とその内訳側の両方を数えるとサイズが二重計上される
 * ため）。加えて、集約エントリに内包された葉モジュール自身の `.chunks`/`.id` は常に空
 * （実測で確認済み。id/chunks を持つのは集約エントリ側だけ）なので、祖先（集約エントリ）の
 * `.chunks` を継承させる。継承後も `.chunks` が空のままの葉は、コンパイル過程で作られたが
 * 実際にはどのチャンク（＝出力される最終アセット）にも含まれていないモジュール
 * （"orphan modules"。toJson({ orphanModules: true }) で個別に出てくる）であり、
 * 実際のバンドルサイズには寄与しないため、呼び出し側で除外すること。
 */
function flattenModules(modules, inheritedChunks = [], out = []) {
    for (const m of modules || []) {
        const chunks = Array.isArray(m.chunks) && m.chunks.length > 0 ? m.chunks : inheritedChunks;
        if (Array.isArray(m.modules) && m.modules.length > 0) {
            flattenModules(m.modules, chunks, out);
        } else {
            out.push({ ...m, chunks });
        }
    }
    return out;
}

/** 実際にどこかのチャンク（＝出力される最終アセット）に含まれる、実モジュールのみ。 */
function shippedModules(json) {
    return flattenModules(json.modules).filter((m) => m.type === 'module' && m.chunks.length > 0);
}

function isPdfjsModule(nameOrIdentifier) {
    return typeof nameOrIdentifier === 'string' && nameOrIdentifier.includes('pdfjs-dist');
}

/**
 * チャンクID → そのチャンクを初期チャンクに持つエントリポイント名の集合、の対応表を作る。
 * モジュールが「どのエントリポイントの初期ロードに入っているか」を人が読める名前
 * （webpack.config.js の entry オブジェクトのキー。例: 'sidepanel/sidepanel'）で示すために使う。
 */
function buildChunkIdToEntryNames(json) {
    const map = new Map();
    for (const [name, entry] of Object.entries(json.entrypoints || {})) {
        for (const chunkId of entry.chunks || []) {
            const key = String(chunkId);
            if (!map.has(key)) map.set(key, new Set());
            map.get(key).add(name);
        }
    }
    return map;
}

function resolveEntryNamesForChunks(chunkIds, chunkIdToEntryNames) {
    const names = new Set();
    for (const chunkId of chunkIds) {
        for (const name of chunkIdToEntryNames.get(String(chunkId)) || []) names.add(name);
    }
    return names;
}

/**
 * node_modules 配下のモジュール名を「node_modules/」以降だけに短縮する（このリポジトリの
 * 依存は junction 経由のため、素の名前だと
 * `../../../../../../../../codes/tiab-review-plugin/node_modules/pdfjs-dist/...` のような
 * 長い相対パスになり読みにくい）。node_modules を含まないパス（src/ 配下等）はそのまま返す。
 * ネストした node_modules（依存の依存）がある場合は最も内側（末尾に近い方）を残す。
 * 表示専用のヘルパーで、集約のキーには使わない（生の名前を使う）。
 */
function shortenModuleName(name) {
    if (typeof name !== 'string') return name;
    const idx = name.lastIndexOf('node_modules/');
    return idx === -1 ? name : name.slice(idx);
}

/**
 * モジュール一覧をモジュール名で集約する（1モジュール1行にするため）。
 *
 * `optimization.splitChunks: false` かつ production 既定の concatenateModules
 * （ModuleConcatenationPlugin）により、同じモジュール（例: pdfjs-dist/legacy/build/pdf.mjs）を
 * 複数エントリ（sidepanel/fulltext 等）が import すると、エントリごとに別々の連結モジュール
 * インスタンスとして stats に現れる（実測で確認済み: 同名・同サイズのモジュールが
 * チャンクの数だけ複製されて出てくる）。そのまま「サイズ上位20モジュール」に載せると
 * 同じモジュールが2行以上を占めて枠を浪費し、合計サイズも二重計上になる。
 * ここで名前をキーに束ね、そのモジュールが実際に含まれる全チャンクからエントリポイント名を
 * 解決する。同名モジュールがインスタンスごとに異なるサイズを報告してきた場合は
 * （通常は同一のはずだが）大きい方を採用し、sizeVaries フラグを立てて呼び出し側が
 * 気づけるようにする。
 */
function aggregateModulesByName(json) {
    const chunkIdToEntryNames = buildChunkIdToEntryNames(json);
    const byName = new Map();
    for (const m of shippedModules(json)) {
        if (typeof m.size !== 'number') continue;
        const name = m.name || m.identifier || '(不明なモジュール)';
        if (!byName.has(name)) {
            byName.set(name, { name, size: m.size, chunkIds: new Set(m.chunks.map(String)), sizeVaries: false });
        } else {
            const existing = byName.get(name);
            if (m.size !== existing.size) {
                existing.sizeVaries = true;
                existing.size = Math.max(existing.size, m.size);
            }
            for (const chunkId of m.chunks) existing.chunkIds.add(String(chunkId));
        }
    }
    return [...byName.values()].map((v) => ({
        name: v.name,
        size: v.size,
        sizeVaries: v.sizeVaries,
        entryPoints: [...resolveEntryNamesForChunks(v.chunkIds, chunkIdToEntryNames)].sort(),
    }));
}

/**
 * エントリポイント別の初期ロード資産を集計する（.map は除外し、別枠で合計だけ出す）。
 *
 * `entrypoints[name].assets` には .map ファイルが含まれない（webpackはソースマップを
 * 対応するJSアセットの「関連アセット」として扱い、通常のアセット一覧には出さない。
 * `stats.toJson('verbose')` でも同様に出てこないことを実測で確認済み）。`.map` のサイズは
 * `relatedAssets: true` を付けたときの各JSアセットの `.related`（type:'sourceMap'）から取る。
 */
function summarizeEntrypoints(json) {
    const assetByName = new Map((json.assets || []).map((a) => [a.name, a]));
    const result = {};
    for (const [name, entry] of Object.entries(json.entrypoints || {})) {
        // 念のため .map を除外するガードは残すが、実測では entry.assets に .map は現れない
        // （上記コメント参照）ため、下の mapBytesExcluded（.related 経由）が実質的な集計元。
        const assets = (entry.assets || []).filter((a) => !a.name.endsWith('.map'));
        const jsAssets = assets.filter((a) => a.name.endsWith('.js'));
        const mapBytesExcluded = jsAssets.reduce((sum, a) => {
            const related = assetByName.get(a.name)?.related || [];
            const sourceMap = related.find((r) => r.type === 'sourceMap');
            return sum + (sourceMap?.size || 0);
        }, 0);
        result[name] = {
            assets: assets.map((a) => ({ name: a.name, size: a.size })),
            totalBytes: assets.reduce((sum, a) => sum + a.size, 0),
            jsBytes: jsAssets.reduce((sum, a) => sum + a.size, 0),
            mapBytesExcluded,
        };
    }
    return result;
}

/** 遅延（非初期）チャンクの一覧とサイズ（サイズ降順）。 */
function summarizeAsyncChunks(json) {
    return (json.chunks || [])
        .filter((c) => c.initial === false)
        .map((c) => ({
            id: c.id,
            names: c.names || [],
            files: c.files || [],
            size: typeof c.size === 'number' ? c.size : 0,
        }))
        .sort((a, b) => b.size - a.size);
}

/** サイズ上位 limit 件のモジュール（1モジュール1行に集約済み。ソース本文は含めない）。 */
function topModules(aggregatedModules, limit = 20) {
    return aggregatedModules
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, limit);
}

/**
 * pdfjs-dist 由来モジュールの合計サイズと、どのエントリポイントの初期ロードに
 * 入っているかを調べる（工程4 #155 の判断材料。この工程での対応は行わない）。
 *
 * totalBytes は aggregateModulesByName() で名前ごとに1つに束ねた後のユニークな合計サイズ
 * （同じモジュールが複数エントリに含まれていても1回だけ数える）。参考値として、束ねる前の
 * 「延べ（エントリ横断の合計。重複を含む）」サイズも grossBytes として別に出す
 * （このリポジトリは `optimization.splitChunks: false` のため、複数エントリが同じ依存を
 * import すると共有チャンクへ切り出されず、重複してバンドルされる）。
 */
function summarizePdfjsDist(json, aggregatedModules) {
    const pdfjsAggregated = aggregatedModules.filter((m) => isPdfjsModule(m.name));
    const totalBytes = pdfjsAggregated.reduce((sum, m) => sum + m.size, 0);
    const includedInInitialLoadOf = [...new Set(pdfjsAggregated.flatMap((m) => m.entryPoints))].sort();
    const sizeVaries = pdfjsAggregated.some((m) => m.sizeVaries);

    const grossBytes = shippedModules(json)
        .filter((m) => typeof m.size === 'number' && (isPdfjsModule(m.name) || isPdfjsModule(m.identifier)))
        .reduce((sum, m) => sum + m.size, 0);

    return {
        totalBytes,
        grossBytes,
        moduleCount: pdfjsAggregated.length,
        includedInInitialLoadOf,
        sizeVaries,
    };
}

function buildReport(label, json) {
    const aggregatedModules = aggregateModulesByName(json);
    return {
        label,
        entrypoints: summarizeEntrypoints(json),
        asyncChunks: summarizeAsyncChunks(json),
        topModules: topModules(aggregatedModules),
        // 初期ロードへ戻る迂回importの確認用。ソース本文は含めない。
        modules: aggregatedModules,
        pdfjsDist: summarizePdfjsDist(json, aggregatedModules),
        warnings: (json.warnings || []).map((w) => (w && w.message) || String(w)),
    };
}

// ============================================================
// 出力
// ============================================================

function fmtKb(bytes) {
    return `${(bytes / 1024).toFixed(1)}KB`;
}

function buildSummaryMarkdown(reports) {
    const lines = [];
    lines.push('# バンドル統計サマリ（Issue #151（#150 工程0）チャンク3b）');
    lines.push('');
    lines.push(`生成日時: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('**計測専用ビルドです。** `.tmp/bench/bundle/`（`.gitignore` 済み）へ出力し、');
    lines.push('`dist/` `docs/app/` は一切変更しません。認証環境変数はプレースホルダーのため');
    lines.push('ここでビルドした成果物は配布・アップロードしないでください。');
    lines.push('');

    for (const report of reports) {
        lines.push(`## ${report.label}`);
        lines.push('');
        lines.push('### エントリポイント別 初期ロード資産');
        lines.push('');
        lines.push('| entry | JS初期ロード | 全体(JS+その他) | .map除外分 | 資産内訳 |');
        lines.push('|---|---|---|---|---|');
        for (const [name, e] of Object.entries(report.entrypoints)) {
            const assetList = e.assets.map((a) => `${a.name}(${fmtKb(a.size)})`).join(', ');
            lines.push(`| ${name} | ${fmtKb(e.jsBytes)} | ${fmtKb(e.totalBytes)} | ${fmtKb(e.mapBytesExcluded)} | ${assetList} |`);
        }
        lines.push('');

        lines.push('### 遅延（非初期）チャンク');
        lines.push('');
        if (report.asyncChunks.length === 0) {
            lines.push('なし');
        } else {
            lines.push('| chunk | files | size |');
            lines.push('|---|---|---|');
            for (const c of report.asyncChunks) {
                lines.push(`| ${c.names.join(', ') || c.id} | ${c.files.join(', ')} | ${fmtKb(c.size)} |`);
            }
        }
        lines.push('');

        lines.push('### サイズ上位20モジュール');
        lines.push('');
        lines.push('モジュール名で集約済み（1モジュール1行）。同じモジュールが複数エントリポイントの');
        lines.push('チャンクに含まれる場合、size はユニークなサイズ（1回分）、entrypoints はそれを含む');
        lines.push('全エントリポイントの列挙。');
        lines.push('');
        lines.push('| module | size | entrypoints |');
        lines.push('|---|---|---|');
        for (const m of report.topModules) {
            const sizeLabel = m.sizeVaries ? `${fmtKb(m.size)} †` : fmtKb(m.size);
            lines.push(`| ${shortenModuleName(m.name)} | ${sizeLabel} | ${m.entryPoints.join(', ') || '(不明)'} |`);
        }
        if (report.topModules.some((m) => m.sizeVaries)) {
            lines.push('');
            lines.push('† 同名モジュールがチャンクごとに異なるサイズを報告したため、最大値を採用。');
        }
        lines.push('');

        lines.push('### 重い依存の内訳: pdfjs-dist');
        lines.push('');
        lines.push(`合計サイズ（ユニーク）: ${fmtKb(report.pdfjsDist.totalBytes)}（${report.pdfjsDist.moduleCount}モジュール）` +
            (report.pdfjsDist.sizeVaries ? ' †' : ''));
        lines.push(`延べサイズ（エントリ横断の合計。重複を含む参考値）: ${fmtKb(report.pdfjsDist.grossBytes)}`);
        lines.push(`初期ロードに含まれるエントリポイント: ${report.pdfjsDist.includedInInitialLoadOf.join(', ') || 'なし'}`);
        if (report.pdfjsDist.sizeVaries) {
            lines.push('');
            lines.push('† 同名モジュールがチャンクごとに異なるサイズを報告したため、最大値を採用。');
        }
        lines.push('');

        if (report.warnings.length > 0) {
            lines.push('### webpack警告');
            lines.push('');
            for (const w of report.warnings) {
                lines.push(`- ${String(w).split('\n')[0]}`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

// ============================================================
// メイン
// ============================================================

async function main() {
    const options = parseArgs(process.argv.slice(2));
    mkdirSync(options.outDir, { recursive: true });

    const extensionOutDir = path.join(BUNDLE_TMP_DIR, 'extension');
    const webOutDir = path.join(BUNDLE_TMP_DIR, 'web');

    console.log('[bundle-stats] 拡張版 production ビルドの統計を取得します...');
    const extensionConfig = webpackConfigFactory({ outDir: extensionOutDir }, { mode: 'production' });
    const extensionJson = await runBuild(extensionConfig);

    console.log('[bundle-stats] Web版 production ビルドの統計を取得します...');
    const webConfig = webpackConfigFactory({ target: 'web', outDir: webOutDir }, { mode: 'production' });
    const webJson = await runBuild(webConfig);

    const reports = [
        buildReport('拡張版 (extension)', extensionJson),
        buildReport('Web版 (web)', webJson),
    ];

    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(options.outDir, `bundle-stats-${iso}.json`);
    writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2), 'utf8');
    console.log(`[bundle-stats] 結果を書き出しました: ${jsonPath}`);

    const summaryPath = path.join(options.outDir, 'bundle-summary.md');
    writeFileSync(summaryPath, buildSummaryMarkdown(reports), 'utf8');
    console.log(`[bundle-stats] サマリを書き出しました: ${summaryPath}`);
}

main().catch((err) => {
    console.error('[bundle-stats] エラーで終了しました:', err);
    process.exit(1);
});
