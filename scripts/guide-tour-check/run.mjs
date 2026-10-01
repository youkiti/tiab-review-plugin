#!/usr/bin/env node
// 案内ツアーの通し検証（デモビルドを Playwright で操作し、最初から最後まで進める）
//
// 使い方:
//   npm run build:demo
//   npm run check:tours -- [--only <シナリオ名>] [--lang ja|en] [--size 幅x高さ]
//
//   --only    scenarios/<名前>.mjs の名前を指定して、そのシナリオだけ実行する（省略時は defaultRun が真のものを全部実行）
//   --lang    ブラウザとUIの言語（既定 ja）
//   --size    ビューポート（既定 500x1000。狭い画面は 400x700 など）
//
// 構成:
//   run.mjs            起動・引数・結果の集計だけ。scenarios/ を読んで順に実行する
//   lib/               共通の道具（拡張機能の読み込み、サインイン、待ち、スクリーンショット、配置の確認など）。
//                      シナリオのファイルの書き方は lib/scenario.mjs のコメント
//   scenarios/<名前>.mjs  シナリオ1本ぶん。ツアーを足すときは、ここに1本足すだけでよい
//
// CI には入れていない。headed の Chrome で拡張機能を読み込むため、ブラウザの動く環境が要る。
// 拡張機能のロード方式は scripts/doc-screenshots/capture.mjs と同じ
// （launchPersistentContext + --load-extension で dist-demo/ を読む）。
// 実データ・実アカウントは使わない。シナリオごとに新しい一時プロファイルで起動し、終了時に必ず消す。
//
// 各手順で `#guide-tour-card` の `data-guide-step` が期待する手順 ID になるのを待ってから操作し、
// 手順が進むたびに .tmp/guide-tour-check/<シナリオ名>-<連番>-<手順ID>.png を保存する
// （fullPage は付けない。リサイズで吹き出しが閉じるため）。
// 1つでも失敗したら exit 1。失敗時は「どのシナリオの、どの手順で、何を待っていたか」を出す。

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DIST_DEMO_DIR, OUT_DIR, REPO_ROOT, config } from './lib/constants.mjs';
import { withFreshBrowser } from './lib/browser.mjs';

const SCENARIOS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scenarios');

function parseArgs(argv) {
    const args = { only: null, lang: 'ja', size: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--only') {
            const value = argv[++i];
            if (!value) throw new Error('--only にはシナリオ名を指定してください');
            args.only = value;
        } else if (argv[i] === '--size') {
            const match = /^(\d+)x(\d+)$/.exec(argv[++i] ?? '');
            if (!match) throw new Error('--size には 400x700 のような形式で指定してください');
            args.size = { width: Number(match[1]), height: Number(match[2]) };
        } else if (argv[i] === '--lang') {
            const value = argv[++i];
            if (value !== 'ja' && value !== 'en') throw new Error('--lang には ja または en を指定してください');
            args.lang = value;
        } else {
            throw new Error(`不明な引数: ${argv[i]}`);
        }
    }
    return args;
}

/** scenarios/*.mjs を名前順に読み込む。ファイル名と定義の name が違えば例外にする。 */
async function loadScenarios() {
    const files = readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.mjs')).sort();
    const scenarios = [];
    for (const file of files) {
        const module = await import(pathToFileURL(path.join(SCENARIOS_DIR, file)).href);
        const scenario = module.default;
        if (!scenario) throw new Error(`scenarios/${file} に default export（defineScenario の戻り値）がありません`);
        if (`${scenario.name}.mjs` !== file) {
            throw new Error(`scenarios/${file} の name が "${scenario.name}" です（ファイル名と同じにしてください）`);
        }
        scenarios.push(scenario);
    }
    return scenarios;
}

async function main() {
    const { only, lang, size } = parseArgs(process.argv.slice(2));
    if (size) config.viewport = size;
    if (!existsSync(DIST_DEMO_DIR) || readdirSync(DIST_DEMO_DIR).length === 0) {
        throw new Error(`dist-demo/ がありません。先に \`npm run build:demo\` を実行してください: ${DIST_DEMO_DIR}`);
    }
    const all = await loadScenarios();
    const selected = only === null
        ? all.filter((s) => s.defaultRun)
        : all.filter((s) => s.name === only);
    if (selected.length === 0) {
        throw new Error(only === null
            ? '既定で実行するシナリオがありません'
            : `シナリオ "${only}" がありません。あるのは: ${all.map((s) => s.name).join(', ')}`);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    // 古い実行のスクリーンショットが混ざらないよう、この検証の出力だけを掃除する
    for (const f of readdirSync(OUT_DIR)) {
        if (f.endsWith('.png')) rmSync(path.join(OUT_DIR, f), { force: true });
    }

    const results = [];
    const allShots = [];
    for (const s of selected) {
        console.log(`\n=== ${s.title} ===`);
        try {
            const run = await withFreshBrowser(s.name, lang, s.run);
            allShots.push(...run.shots);
            results.push({ ...s, ok: true });
        } catch (err) {
            if (err.run) allShots.push(...err.run.shots);
            console.error(`  失敗: ${err.message}`);
            results.push({ ...s, ok: false });
        }
    }

    console.log('\n=== 結果 ===');
    for (const r of results) console.log(`${r.ok ? '合格' : '不合格'}  ${r.title}`);
    console.log(`\nスクリーンショット（${allShots.length} 枚、${path.relative(REPO_ROOT, OUT_DIR)}）:`);
    for (const f of allShots) console.log(`  ${f}`);

    if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
    console.error('検証スクリプトが異常終了しました:', err);
    process.exit(1);
});
