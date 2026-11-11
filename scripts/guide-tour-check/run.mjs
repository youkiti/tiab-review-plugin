#!/usr/bin/env node
// 案内ツアーの通し検証（デモビルドを Playwright で操作し、最初から最後まで進める）
//
// 使い方:
//   npm run build:demo
//   npm run check:tours -- [--only <シナリオ名>] [--lang ja|en] [--size 幅x高さ] [--retry-failed <回数>]
//
//   --only    scenarios/<名前>.mjs の名前を指定して、そのシナリオだけ実行する（省略時は defaultRun が真のものを全部実行）
//   --lang    ブラウザとUIの言語（既定 ja）
//   --size    ビューポート（既定 500x1000。狭い画面は 400x700 など）
//   --retry-failed  全シナリオを1巡した後、不合格のものだけを指定回数まで再実行する（既定 0）。再試行で合格したものは合格に数え、最後に名前を並べる
//             Linux の Chromium は画面の言語を環境変数 LANGUAGE から決める（--lang は効かない）ので、日本語の文言を前提にするシナリオは LANGUAGE=ja を付けて実行する
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
    const args = { only: null, lang: 'ja', size: null, retryFailed: 0 };
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
        } else if (argv[i] === '--retry-failed') {
            const raw = argv[++i] ?? '';
            if (!/^\d+$/.test(raw)) throw new Error('--retry-failed には 0 以上の整数を指定してください');
            args.retryFailed = Number(raw);
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
    const { only, lang, size, retryFailed } = parseArgs(process.argv.slice(2));
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

    const allShots = [];
    /** 1本を実行して合否を返す。スクリーンショットの一覧には実行のたびに足す。 */
    const runOne = async (s) => {
        try {
            const run = await withFreshBrowser(s.name, lang, s.run);
            allShots.push(...run.shots);
            return true;
        } catch (err) {
            if (err.run) allShots.push(...err.run.shots);
            console.error(`  失敗: ${err.message}`);
            return false;
        }
    };

    const results = [];
    for (const s of selected) {
        console.log(`\n=== ${s.title} ===`);
        results.push({ ...s, ok: await runOne(s), retried: false });
    }
    // 不合格のものだけを、同じ条件（新しい一時プロファイル）で回数まで再実行する
    for (const r of results) {
        for (let attempt = 1; !r.ok && attempt <= retryFailed; attempt += 1) {
            console.log(`\n=== ${r.title}（再試行 ${attempt}/${retryFailed}）===`);
            r.ok = await runOne(r);
            if (r.ok) r.retried = true;
        }
    }

    console.log('\n=== 結果 ===');
    for (const r of results) console.log(`${r.ok ? (r.retried ? '合格（再試行で合格）' : '合格') : '不合格'}  ${r.title}`);
    const flaky = results.filter((r) => r.retried);
    if (flaky.length > 0) {
        console.log('\n再試行で合格したもの（不安定の疑い）:');
        for (const r of flaky) console.log(`  ${r.name}`);
    }
    console.log(`\nスクリーンショット（${allShots.length} 枚、${path.relative(REPO_ROOT, OUT_DIR)}）:`);
    for (const f of allShots) console.log(`  ${f}`);

    if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
    console.error('検証スクリプトが異常終了しました:', err);
    process.exit(1);
});
