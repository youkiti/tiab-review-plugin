#!/usr/bin/env node
// Playwright 計測ランナー（Issue #151（#150 工程0）チャンク3a・チャンク3b）
//
// デモビルド（dist-demo/）を実ブラウザで動かし、src/lib/perf.ts の performance.measure と
// src/demo/fetch-mock.ts の通信集計（__tiabDemoNet）を収集して、同一入力で再実行できる形で
// ベースラインを出力する。バンドル統計・webpack出力先の変更は別スクリプト
// （scripts/bench/bundle-stats.mjs、チャンク3b）の担当のためここでは扱わない。
//
// 使い方:
//   npm run bench -- [オプション]
//   npm run bench -- --size 1000 --size 10000 --repeat 100
//
// 前提: `scripts/doc-screenshots/capture.mjs` と同じ方式（chromium.launchPersistentContext +
// --disable-extensions-except / --load-extension、service worker から拡張機能IDを取る、
// chrome.storage.local.set({ demo_signed_in: true }) でログイン状態を仕込む、
// `#recent-sheets` からデモプロジェクトへ接続する）を踏襲している。
//
// オプション（すべて省略可）:
//   --size <n>        合成文献数（?benchSize=）。複数指定可（--size 1000 --size 10000）。
//                      サイズごとに1回ずつシナリオ1〜7を計測する。既定 [1000]
//   --pdf <id>         シナリオ8（PDF表示・根拠ジャンプ）で使うPDFフィクスチャ（?benchPdf=）。
//                       demo|20p|57p。複数指定可（--pdf 20p --pdf 57p）。PDFごとに1回ずつ
//                       シナリオ8を実行する。既定 [demo]
//   --key-opened       ?benchKeyOpened=1（キー開封後の条件）。既定 off（Blind）
//   --net-delay <ms>   ?netDelay=（通信の人工遅延）。既定 0
//   --repeat <n>       判定・前後移動の反復回数。既定 100
//   --out <dir>        出力先ディレクトリ。既定 .tmp/bench
//   --dev-build        production デモビルドではなく development デモビルド（npm run build:demo）を使う
//   --skip-build       ビルドを行わず既存の dist-demo/ を使う
//   --headed/--headless 既定は headed（拡張機能のロードに必要。--headless は自己責任）
//   --help / -h        このヘルプを表示
//
// 出力（--out 配下）:
//   bench-<ISO日時>.json  環境メタ＋全シナリオの集計＋生の measure 一覧
//   summary.md            人が読む表（日本語）
//
// p95 の定義（コード内でもこの定義を守ること。定義が違うと後から数字を比較できない）:
//   値を昇順ソートし、Math.ceil(n * 0.95) - 1 番目（0始まり）の値を p95 とする。
//
// データ契約（親Issue #150）: 認証情報・文献本文・レビュアーのメールは一切収集・出力しない。
// デモの固定メール（demo-reviewer@example.com 等）も出力に書かない。performance.measure() の
// detail は件数などの数値のみのはずだが、出力前に sanitizeDetailValue() で文字列値を必ず落とす。
// 実データは一切使わず、合成データ（src/demo/bench-fixtures.ts）とデモビルド同梱のPDFフィクスチャ
// （video/fixtures/、出所表示は video/fixtures/NOTICE.md）のみを使う。

import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_DEMO_DIR = path.join(REPO_ROOT, 'dist-demo');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.tmp/bench');

// サイドパネルの実寸に近い縦長ビューポート（scripts/doc-screenshots/capture.mjs と同じ値）。
const VIEWPORT = { width: 500, height: 1000 };

// デモ固定値。scripts/ 配下は webpack を通さない素の Node ESM のため、src/demo/constants.ts
// の TypeScript 定数を直接 import できず、ここでは値を複製している
// （src/demo/constants.ts の DEMO_SPREADSHEET_ID と同じ値。変更したら追従させること）。
const DEMO_SPREADSHEET_ID = 'demo-spreadsheet-001';

// PDF表示・根拠ジャンプシナリオで使う ref_id（Issue #151（#150 工程0）チャンク3b）。
// 出典: BENCH_FULLTEXT_CACHED_REF_ID (src/demo/bench-fixtures.ts)。同ファイルの
// FULLTEXT_CACHED_REFERENCE_SIZE=1000 のときに「先頭付近の通常論文行」1件へ
// fulltext_status='cached' とフルテキストAI判定（根拠3件）を付与したものの ref_id を
// そのまま複製している（run.mjs は plain Node ESM のためその TypeScript 定数を import
// できない）。この値がズレたら根拠カードが描画されず tiab:pdf.evidenceJump が0件になるので
// 気づける。既定デモプロファイル（demo-ref-001）はAI判定根拠を持たないため使わない。
const PDF_SCENARIO_REF_ID = 'bench-ref-000031';

// シナリオ8（PDF表示と根拠ジャンプ）の反復回数。ブリーフの固定値（--repeat の対象外）。
const PDF_SCENARIO_ITERATIONS = 5;

// ?benchPdf= で選べるPDFフィクスチャの pageCount・ファイル名。
// 出典: DEMO_PDF_FIXTURES (src/demo/constants.ts)。scripts/ 配下は webpack を通さない素の
// Node ESM のためその TypeScript 定数を直接 import できず、ここでは値を複製している
// （DEMO_SPREADSHEET_ID 等と同じ理由）。値がズレたら summary.md のページ数表記が食い違うので
// 気づける。driveFileId は run.mjs 側では使わないため複製しない。
const BENCH_PDF_FIXTURES = {
    demo: { pageCount: 4, fileName: 'demo-paper.pdf' },
    '20p': { pageCount: 20, fileName: 'bench-paper-20p.pdf' },
    '57p': { pageCount: 57, fileName: 'bench-paper-57p.pdf' },
};

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ============================================================
// 引数パース
// ============================================================

function printHelp() {
    console.log(`Playwright 計測ランナー（Issue #151（#150 工程0）チャンク3a）

使い方:
  npm run bench -- [オプション]

オプション（すべて省略可。既定値は括弧内）:
  --size <n>          合成文献数（?benchSize=）。複数指定可。サイズごとに1回ずつ計測する（既定 1000）
  --pdf <id>          シナリオ8で使うPDFフィクスチャ（?benchPdf=）。demo|20p|57p。複数指定可。
                      PDFごとに1回ずつシナリオ8を計測する（既定 demo）
  --key-opened        ?benchKeyOpened=1（キー開封後の条件）。指定なしは Blind（既定 off）
  --net-delay <ms>    ?netDelay=（通信の人工遅延）（既定 0）
  --repeat <n>        判定・前後移動の反復回数（既定 100）
  --out <dir>         出力先ディレクトリ（既定 .tmp/bench）
  --dev-build         production デモビルドではなく development デモビルドを使う（既定 off）
  --skip-build        ビルドを行わず既存の dist-demo/ を使う（既定 off）
  --headed/--headless 拡張機能のロードに --headed が必要（既定 headed）
  --help, -h          このヘルプを表示
`);
}

function parseArgs(argv) {
    const options = {
        sizes: [],
        pdfs: [],
        keyOpened: false,
        netDelayMs: 0,
        repeat: 100,
        outDir: DEFAULT_OUT_DIR,
        devBuild: false,
        skipBuild: false,
        headless: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
                break;
            case '--size': {
                const value = argv[++i];
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error(`--size には正の数値を指定してください: ${value}`);
                }
                options.sizes.push(Math.floor(n));
                break;
            }
            case '--pdf': {
                const value = argv[++i];
                if (!Object.prototype.hasOwnProperty.call(BENCH_PDF_FIXTURES, value)) {
                    throw new Error(`--pdf には demo|20p|57p のいずれかを指定してください: ${value}`);
                }
                options.pdfs.push(value);
                break;
            }
            case '--key-opened':
                options.keyOpened = true;
                break;
            case '--net-delay': {
                const value = argv[++i];
                const n = Number(value);
                if (!Number.isFinite(n) || n < 0) {
                    throw new Error(`--net-delay には0以上の数値を指定してください: ${value}`);
                }
                options.netDelayMs = Math.floor(n);
                break;
            }
            case '--repeat': {
                const value = argv[++i];
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) {
                    throw new Error(`--repeat には正の数値を指定してください: ${value}`);
                }
                options.repeat = Math.floor(n);
                break;
            }
            case '--out': {
                const value = argv[++i];
                if (!value) throw new Error('--out には出力ディレクトリを指定してください');
                options.outDir = path.resolve(value);
                break;
            }
            case '--dev-build':
                options.devBuild = true;
                break;
            case '--skip-build':
                options.skipBuild = true;
                break;
            case '--headed':
                options.headless = false;
                break;
            case '--headless':
                options.headless = true;
                break;
            default:
                throw new Error(`不明な引数です: ${arg}（--help でヘルプを表示）`);
        }
    }
    if (options.sizes.length === 0) options.sizes.push(1000);
    if (options.pdfs.length === 0) options.pdfs.push('demo');
    return options;
}

// ============================================================
// ビルド
// ============================================================

function buildDemo(options) {
    if (options.skipBuild) {
        if (!existsSync(DIST_DEMO_DIR)) {
            throw new Error(`--skip-build 指定ですが dist-demo/ がありません: ${DIST_DEMO_DIR}`);
        }
        console.log('[bench] --skip-build 指定のため既存の dist-demo/ をそのまま使います。');
        return;
    }
    // webpack.config.js の isDemo 分岐は isProduction より先に評価され、demo ビルドは
    // production/development どちらでも key を保持し出力先は dist-demo/ のまま
    // （webpack.config.js L65, L96, L174-180 で確認済み）。
    const script = options.devBuild ? 'build:demo' : 'build:demo:prod';
    console.log(`[bench] npm run ${script} を実行します...`);
    // Node 18.20/20.12 以降は CVE-2024-27980 対応により、shell を介さずに .cmd/.bat を
    // spawn することを拒否する（Windows の npm.cmd 実行時に ENOENT/EINVAL になる）。
    // 引数は固定リテラル（script は上の三項演算子の2値のみ）でシェル経由でも安全なため、
    // Windows では shell: true を渡して回避する。
    execFileSync(npmCmd, ['run', script], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
}

// ============================================================
// 集計ユーティリティ
// ============================================================

/** p95 の定義: 昇順ソート済み配列に対し Math.ceil(n * 0.95) - 1 番目（0始まり）の値。 */
function percentile95(sortedAsc) {
    if (sortedAsc.length === 0) return null;
    const idx = Math.ceil(sortedAsc.length * 0.95) - 1;
    return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)];
}

function median(sortedAsc) {
    const n = sortedAsc.length;
    if (n === 0) return null;
    const mid = Math.floor(n / 2);
    return n % 2 === 0 ? (sortedAsc[mid - 1] + sortedAsc[mid]) / 2 : sortedAsc[mid];
}

/** measure 名ごとに 件数・中央値・p95・最小・最大 を集計する。 */
function aggregateByName(entries) {
    const byName = new Map();
    for (const e of entries) {
        if (!byName.has(e.name)) byName.set(e.name, []);
        byName.get(e.name).push(e.duration);
    }
    const result = {};
    for (const [name, durations] of byName) {
        const sorted = durations.slice().sort((a, b) => a - b);
        result[name] = {
            count: sorted.length,
            medianMs: median(sorted),
            p95Ms: percentile95(sorted),
            minMs: sorted[0],
            maxMs: sorted[sorted.length - 1],
        };
    }
    return result;
}

/**
 * performance.measure() の detail から文字列値を再帰的に落とす（親Issue #150のデータ契約:
 * 認証情報・文献本文・レビュアーのメールを出力しないため。detail は件数などの数値のみの
 * はずだが、念のため出力直前にこのフィルタを必ず通す）。
 */
function sanitizeDetailValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return undefined;
    if (Array.isArray(value)) {
        return value.map(sanitizeDetailValue).filter((v) => v !== undefined);
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const sanitized = sanitizeDetailValue(v);
            if (sanitized !== undefined) out[k] = sanitized;
        }
        return out;
    }
    return undefined;
}

function extractNumber(text) {
    if (!text) return null;
    const match = String(text).match(/\d+/);
    return match ? Number(match[0]) : null;
}

// ============================================================
// 環境メタ
// ============================================================

function safeGit(args) {
    try {
        return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function extractChromeVersion(userAgent) {
    if (!userAgent) return null;
    const match = userAgent.match(/Chrome\/([0-9.]+)/);
    return match ? match[1] : null;
}

function collectEnvMeta(options, userAgent) {
    const cpus = os.cpus();
    const statusPorcelain = safeGit(['status', '--porcelain']);
    return {
        startedAt: new Date().toISOString(),
        git: {
            commitSha: safeGit(['rev-parse', 'HEAD']),
            branch: safeGit(['rev-parse', '--abbrev-ref', 'HEAD']),
            workingTreeClean: statusPorcelain === null ? null : statusPorcelain.length === 0,
        },
        node: process.version,
        chromeUserAgent: userAgent ?? null,
        chromeVersion: extractChromeVersion(userAgent),
        os: {
            type: os.type(),
            release: os.release(),
            platform: os.platform(),
            arch: os.arch(),
        },
        cpu: {
            model: cpus[0]?.model ?? 'unknown',
            cores: cpus.length,
        },
        totalMemBytes: os.totalmem(),
        buildMode: options.devBuild ? 'development' : 'production',
        runOptions: {
            sizes: options.sizes,
            pdfs: options.pdfs,
            keyOpened: options.keyOpened,
            netDelayMs: options.netDelayMs,
            repeat: options.repeat,
            skipBuild: options.skipBuild,
            headless: options.headless,
        },
    };
}

// ============================================================
// ページ操作ヘルパー
// ============================================================

const consoleMessages = [];
// コンソールイベントは page.on() 登録時点でラベルを確定できない（どのシナリオ実行中に
// 発生したログかは非同期に決まる）ため、現在実行中の文脈ラベルを共有オブジェクトに
// 持たせ、イベント発火時にその時点の値を読む。
const contextRef = { label: 'boot' };

function attachConsoleCapture(page) {
    page.on('console', (msg) => {
        const type = msg.type();
        if (type !== 'error' && type !== 'warning') return;
        const entry = { level: type, text: msg.text(), context: contextRef.label };
        consoleMessages.push(entry);
        console.warn(`[bench][console:${type}][${contextRef.label}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
        const text = err && err.stack ? String(err.stack) : String(err);
        consoleMessages.push({ level: 'pageerror', text, context: contextRef.label });
        console.error(`[bench][pageerror][${contextRef.label}] ${text}`);
    });
    // 判定完了後などに出るネイティブ confirm()/alert() で自動化が止まらないようにする
    // （scripts/doc-screenshots/capture.mjs と同じ防御）。
    page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });
}

function buildBenchQuery(size, options) {
    const params = new URLSearchParams();
    params.set('perf', '1');
    params.set('demoProfile', 'bench');
    params.set('benchSize', String(size));
    if (options.keyOpened) params.set('benchKeyOpened', '1');
    if (options.netDelayMs > 0) params.set('netDelay', String(options.netDelayMs));
    return params.toString();
}

/** performance.getEntriesByType('measure') のうち tiab: で始まるものだけを拾う。 */
async function collectTiabMeasures(page) {
    return page.evaluate(() => performance.getEntriesByType('measure')
        .filter((m) => m.name.startsWith('tiab:'))
        .map((m) => ({ name: m.name, duration: m.duration, detail: m.detail ?? null })));
}

async function netSnapshot(page) {
    return page.evaluate(() => (globalThis.__tiabDemoNet ? globalThis.__tiabDemoNet.snapshot() : null));
}

/** シナリオ境界で計測値を切り分けるための clear。シナリオ1（起動直後）には使わない
 *  （tiab:boot は goto() が返るより前に発火し得るため、ここで clear すると消えてしまう。
 *  シナリオ1は新規ナビゲーション自体が「まっさらな状態」を保証する）。 */
async function clearMeasuresAndNet(page) {
    await page.evaluate(() => {
        performance.clearMeasures();
        if (globalThis.__tiabDemoNet) globalThis.__tiabDemoNet.reset();
    });
}

/**
 * 指定 measure 名の件数が expectedCount に達するまで（またはタイムアウトまで）待つ。
 * tiab:decision.save 等は handleDecision の呼び出し元からは fire-and-forget のため、
 * クリックの反復ループが終わった直後にはまだ保存が完了していないことがある。
 */
async function waitForMeasureCount(page, name, expectedCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const count = await page.evaluate(
            (n) => performance.getEntriesByType('measure').filter((m) => m.name === n).length,
            name
        );
        if (count >= expectedCount || Date.now() >= deadline) return count;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

/**
 * 「クリック直前から画面にそのフレームの描画が反映されるまで」の実時間をページ内で測る。
 * Node<->ブラウザ間のIPC往復を計測に含めないよう、click() 呼び出しと計測開始・終了を
 * すべて1本の page.evaluate() 内（ブラウザ側の performance.now()）で完結させる。
 *
 * requestAnimationFrame のコールバックは、そのフレームのスタイル計算・レイアウト・描画より
 * 前に走る（ブラウザは rAF コールバック群を実行し終えてからスタイル/レイアウト/ペイントを
 * 行う）。そのため rAF のコールバック時点で計測を止めると、実際に画面へ出るまでの時間を
 * 1フレーム分過少に見積もる。`setTimeout(..., 0)` を rAF コールバックの中でスケジュールすると
 * そのマクロタスクは次のフレームの描画が終わった後に実行される（rAF→スタイル/レイアウト/
 * ペイント→他のマクロタスク、という順序のため）ので、ここで計測を止めれば該当フレームの
 * 描画完了後の時間になる。
 */
async function clickToFrame(page, selector) {
    return page.evaluate((sel) => new Promise((resolve, reject) => {
        const el = document.querySelector(sel);
        if (!el) { reject(new Error(`selector not found: ${sel}`)); return; }
        const start = performance.now();
        el.click();
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
    }), selector);
}

async function readFilterResultCount(page) {
    const text = await page.locator('#filter-result-count').textContent().catch(() => null);
    return extractNumber(text);
}

// ============================================================
// シナリオ 1〜7（bench プロファイル、サイズ・keyOpened・netDelay 依存）
// ============================================================

/** シナリオ1: 起動とプロジェクト読み込み。 */
async function scenarioBootAndLoad(page, extId, query) {
    const url = `chrome-extension://${extId}/sidepanel/sidepanel.html?${query}`;
    await page.goto(url);
    await page.locator('#recent-sheets').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#recent-sheets').selectOption({ index: 1 });
    // サイズが大きいと取得・描画に時間がかかるため長めのタイムアウトを取る。
    await page.locator('#btn-include').waitFor({ state: 'visible', timeout: 180000 });
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures, net };
}

/** シナリオ2: 判定を連続変更（include/maybe/exclude を順に repeat 回）。 */
async function scenarioDecisions(page, repeat, netDelayMs) {
    await clearMeasuresAndNet(page);
    const kinds = ['include', 'maybe', 'exclude'];
    const click2frame = [];
    for (let i = 0; i < repeat; i += 1) {
        const kind = kinds[i % kinds.length];
        const duration = await clickToFrame(page, `#btn-${kind}`);
        click2frame.push({ name: 'runner:decision.click2frame', duration, detail: null });
    }
    await waitForMeasureCount(page, 'tiab:decision.save', repeat, Math.max(3000, netDelayMs * 2 + 3000));
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures: [...measures, ...click2frame], net };
}

/** シナリオ3: メモを入れてから前後移動を repeat 回。 */
async function scenarioNoteNavigate(page, repeat, netDelayMs) {
    await clearMeasuresAndNet(page);
    const click2frame = [];
    for (let i = 0; i < repeat; i += 1) {
        // 直前の内容と必ず変える（persistDisplayedNote は値が変わっていないと保存をスキップするため）。
        await page.locator('#note').fill(`Issue #151 チャンク3a bench note ${i}`);
        const direction = i % 2 === 0 ? 'next' : 'prev';
        const duration = await clickToFrame(page, `#btn-${direction}`);
        click2frame.push({ name: 'runner:navigate.click2frame', duration, detail: null });
    }
    await waitForMeasureCount(page, 'tiab:screening.navigate', repeat, Math.max(3000, netDelayMs * 2 + 3000));
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures: [...measures, ...click2frame], net };
}

// 検索フィルターに20回投入する語（bench-fixtures.ts の英語語彙プールと重なるかどうかは
// 問わない。目的は tiab:screening.filter/counts/render を毎回異なる入力で反復させること）。
const SEARCH_TERMS = [
    'diabetes', 'asthma', 'pain', 'surgery', 'training',
    'review', 'trial', 'elderly', 'infection', 'ventilation',
    'therapy', 'insulin', 'cohort', 'protocol', 'placebo',
    'pediatric', 'cardiac', 'fracture', 'depression', 'vaccine',
];

/** シナリオ4: 検索語を20回入れ替え、ステータスフィルターも数回変更する。 */
async function scenarioSearchFilter(page) {
    await clearMeasuresAndNet(page);
    for (const term of SEARCH_TERMS) {
        await page.locator('#search-input').fill(term);
    }
    await page.locator('#search-input').fill('');
    for (const value of ['all', 'include', 'exclude', 'pending']) {
        await page.locator('#status-filter').selectOption(value);
    }
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures, net };
}

/** シナリオ5: 未判定一覧から、判定した文献が消えることを10回確認する。 */
async function scenarioPendingRemoval(page) {
    await clearMeasuresAndNet(page);
    await page.locator('#status-filter').selectOption('pending');
    const kinds = ['include', 'exclude', 'maybe'];
    const removalChecks = [];
    for (let i = 0; i < 10; i += 1) {
        const before = await readFilterResultCount(page);
        if (before === 0) {
            removalChecks.push({ index: i, skipped: true, reason: '未判定の残数が0件のため判定できなかった' });
            break;
        }
        await page.locator(`#btn-${kinds[i % kinds.length]}`).click();
        // フィルタ再計算・再描画は同期的だが、DOM反映の完了を明示的に待つ。
        await page.waitForTimeout(30);
        const after = await readFilterResultCount(page);
        removalChecks.push({ index: i, before, after, removedOne: before !== null && after !== null && after === before - 1 });
    }
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures, net, removalChecks };
}

/** シナリオ6: 設定画面の表示/非表示を10回繰り返す。 */
async function scenarioSettings(page) {
    await clearMeasuresAndNet(page);
    for (let i = 0; i < 10; i += 1) {
        await page.locator('#settings-btn-screening').click();
        await page.locator('#settings-section').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#close-settings-btn').click();
        await page.locator('#settings-section').waitFor({ state: 'hidden', timeout: 5000 });
    }
    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures, net };
}

/** シナリオ7: 保存失敗モードで判定→未送信キューに溜まる→解除→再送されて0件になることを確認する。 */
async function scenarioOfflineQueue(page) {
    await clearMeasuresAndNet(page);
    await page.evaluate(() => { if (globalThis.__tiabDemoNet) globalThis.__tiabDemoNet.setFailureMode('save'); });

    await page.locator('#btn-include').click();
    await page.locator('#unsent-queue-badge').waitFor({ state: 'visible', timeout: 10000 });
    const queuedCountAtFailure = extractNumber(await page.locator('#unsent-queue-badge').textContent().catch(() => null));

    await page.evaluate(() => { if (globalThis.__tiabDemoNet) globalThis.__tiabDemoNet.setFailureMode('none'); });
    await page.locator('#unsent-queue-badge').click();
    await page.locator('#unsent-queue-badge').waitFor({ state: 'hidden', timeout: 10000 });

    const measures = await collectTiabMeasures(page);
    const net = await netSnapshot(page);
    return { measures, net, queuedCountAtFailure };
}

// ============================================================
// シナリオ8（PDF表示と根拠ジャンプ。ベンチプロファイル、--size のうち最小のサイズを使う）
// ============================================================

async function scenarioPdf(context, extId, netDelayMs, benchSize, pdfId) {
    const page = await context.newPage();
    attachConsoleCapture(page);
    const netDelayQuery = netDelayMs > 0 ? `&netDelay=${netDelayMs}` : '';
    const measures = [];
    const netSnapshots = [];
    const skipped = [];
    let evidenceJumpTried = false;

    try {
        for (let i = 0; i < PDF_SCENARIO_ITERATIONS; i += 1) {
            // fulltext.ts は chrome.storage.local から spreadsheetId を読む（サイドパネルの
            // 接続フローが platform().storageSet 経由で書き込むのと同じキー）。fulltext.html は
            // chrome-extension:// オリジンでないと chrome.* API が使えないため、いったん
            // popup.html を経由してから書き込む（scripts/doc-screenshots/capture.mjs の
            // demo_signed_in と同じ手順）。
            await page.goto(`chrome-extension://${extId}/popup/popup.html`);
            await page.evaluate((sid) => chrome.storage.local.set({ spreadsheetId: sid }), DEMO_SPREADSHEET_ID);

            // fulltext.html は自身の URL クエリから resolveDemoProfile()/resolveBenchOptions()
            // 経由で独立に seedDemoStore() を呼び直す（src/demo/fulltext-entry.ts）ため、
            // サイドパネルで既に seed 済みのプロファイルとは無関係に、ここで明示的に
            // demoProfile=bench・benchSize=・benchPdf= を指定する必要がある（既定デモプロファイル
            // には フルテキストAI判定の根拠が無いため tiab:pdf.evidenceJump を計測できない。
            // Issue #151（#150 工程0）チャンク3b。benchPdf= は Issue #156（#150 工程5）着手前の準備）。
            const query = `perf=1&ref_id=${PDF_SCENARIO_REF_ID}&demoProfile=bench&benchSize=${benchSize}&benchPdf=${pdfId}${netDelayQuery}`;
            await page.goto(`chrome-extension://${extId}/fulltext/fulltext.html?${query}`);
            await page.waitForFunction(
                () => performance.getEntriesByType('measure').some((m) => m.name === 'tiab:pdf.allPages'),
                null,
                { timeout: 30000 }
            );
            // allPages 完了直後の同期的な後続処理（highlight 等）が確実に終わるまでの猶予。
            await page.waitForTimeout(300);

            const cards = page.locator('.ft-annotation-card[data-hl-id]');
            const cardCount = await cards.count();
            if (cardCount > 0) {
                evidenceJumpTried = true;
                await cards.first().click();
            }

            measures.push(...await collectTiabMeasures(page));
            netSnapshots.push(await netSnapshot(page));
        }
    } finally {
        await page.close().catch(() => {});
    }

    if (!evidenceJumpTried) {
        const fixtureFileName = BENCH_PDF_FIXTURES[pdfId]?.fileName ?? pdfId;
        skipped.push({
            scenario: `pdf.evidenceJump (pdf=${pdfId})`,
            reason: `${PDF_SCENARIO_REF_ID}（ベンチプロファイル, benchSize=${benchSize}, benchPdf=${pdfId}）` +
                'の根拠カード（.ft-annotation-card）が描画されず、根拠ジャンプの実UI操作を実行できなかった。' +
                'tiab:pdf.evidenceJump は0件のまま出力される。考えられる原因: (1) このsizeでは' +
                'PDF_SCENARIO_REF_ID が通常論文行の範囲に入らない（src/demo/bench-fixtures.ts の' +
                'FULLTEXT_CACHED_INDEX のガード参照）、(2) evidence の quote が' +
                `video/fixtures/${fixtureFileName} のテキストと一致せずハイライトが解決できない、` +
                '(3) Config.fulltext_ai_active_round がフルテキストAI判定の reviewer_id と' +
                '一致していない、のいずれか。',
        });
    }

    return { measures, netSnapshots, skipped };
}

// ============================================================
// 出力
// ============================================================

function finalizeScenarioResult({ measures, net, ...extra }) {
    return {
        aggregated: aggregateByName(measures),
        net: net ?? null,
        raw: measures.map((m) => ({
            name: m.name,
            durationMs: m.duration,
            detail: sanitizeDetailValue(m.detail ?? null),
        })),
        ...extra,
    };
}

function round2(n) {
    return typeof n === 'number' ? Math.round(n * 100) / 100 : n;
}

function measureTableRows(aggregated) {
    return Object.entries(aggregated)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, s]) => `| ${name} | ${s.count} | ${round2(s.medianMs)} | ${round2(s.p95Ms)} | ${round2(s.minMs)} | ${round2(s.maxMs)} |`)
        .join('\n');
}

function netTableRows(net) {
    if (!net) return '(通信集計なし)';
    const rows = Object.entries(net.byEndpoint)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, stat]) => `| ${label} | ${stat.count} | ${stat.bytes} |`)
        .join('\n');
    return `合計リクエスト数: ${net.totalRequests} / 合計応答バイト数: ${net.totalResponseBytes}\n\n| endpoint | count | bytes |\n|---|---|---|\n${rows}`;
}

const SCENARIO_LABELS = {
    bootAndLoad: '1. 起動とプロジェクト読み込み',
    decisions: '2. 判定を連続変更',
    noteNavigate: '3. メモ付きで前後移動',
    searchFilter: '4. 検索・フィルター変更',
    pendingRemoval: '5. 未判定一覧からの除去',
    settings: '6. 設定表示',
    offlineQueue: '7. オフライン保存と再送',
};

function buildSummaryMarkdown(report) {
    const lines = [];
    lines.push('# ベンチマーク結果サマリ（Issue #151（#150 工程0）チャンク3a）');
    lines.push('');
    lines.push(`生成日時: ${report.meta.startedAt}`);
    lines.push(`コミット: ${report.meta.git.commitSha ?? '不明'} (${report.meta.git.branch ?? '不明'})` +
        (report.meta.git.workingTreeClean === false ? ' ※作業ツリーに未コミットの変更あり' : ''));
    lines.push(`ビルドモード: ${report.meta.buildMode}`);
    lines.push(`Node: ${report.meta.node} / Chrome: ${report.meta.chromeVersion ?? '不明'} / OS: ${report.meta.os.type} ${report.meta.os.release} (${report.meta.os.platform}/${report.meta.os.arch})`);
    lines.push(`CPU: ${report.meta.cpu.model}（${report.meta.cpu.cores}コア） / 総RAM: ${Math.round(report.meta.totalMemBytes / 1024 / 1024 / 1024)}GB`);
    lines.push('');
    lines.push('## 実行条件');
    lines.push('');
    lines.push(`- サイズ: ${report.meta.runOptions.sizes.join(', ')}`);
    lines.push(`- PDF: ${report.meta.runOptions.pdfs.join(', ')}`);
    lines.push(`- keyOpened: ${report.meta.runOptions.keyOpened}`);
    lines.push(`- netDelay: ${report.meta.runOptions.netDelayMs}ms`);
    lines.push(`- repeat: ${report.meta.runOptions.repeat}`);
    lines.push('');
    lines.push('p95 の定義: 値を昇順ソートし、`Math.ceil(n * 0.95) - 1` 番目（0始まり）の値。');
    lines.push('');

    for (const sizeReport of report.sizes) {
        lines.push(`## size=${sizeReport.size}（keyOpened=${sizeReport.keyOpened}）`);
        lines.push('');
        for (const [key, label] of Object.entries(SCENARIO_LABELS)) {
            const scenario = sizeReport.scenarios[key];
            lines.push(`### ${label}`);
            lines.push('');
            if (!scenario) {
                lines.push('(スキップ。下記「スキップ/失敗したシナリオ」参照)');
                lines.push('');
                continue;
            }
            lines.push('| measure | count | median(ms) | p95(ms) | min(ms) | max(ms) |');
            lines.push('|---|---|---|---|---|---|');
            lines.push(measureTableRows(scenario.aggregated) || '(measureなし)');
            lines.push('');
            if (scenario.net) {
                lines.push('通信集計:');
                lines.push('');
                lines.push(netTableRows(scenario.net));
                lines.push('');
            }
            if (scenario.removalChecks) {
                const removedCount = scenario.removalChecks.filter((c) => c.removedOne).length;
                lines.push(`未判定一覧からの除去: ${removedCount}/${scenario.removalChecks.length} 件で確認`);
                lines.push('');
            }
            if (scenario.queuedCountAtFailure !== undefined) {
                lines.push(`保存失敗時の未送信件数: ${scenario.queuedCountAtFailure}`);
                lines.push('');
            }
        }
    }

    lines.push('## PDF表示と根拠ジャンプ（ベンチプロファイル）');
    lines.push('');
    if (report.fulltextPdf.length === 0) {
        lines.push('(実行できませんでした。下記「スキップ/失敗したシナリオ」参照)');
        lines.push('');
    } else {
        for (const pdfReport of report.fulltextPdf) {
            lines.push(`### benchPdf=${pdfReport.pdfId}（${pdfReport.pageCount}ページ, ref_id=${pdfReport.refId}, benchSize=${pdfReport.benchSize}）`);
            lines.push('');
            lines.push('| measure | count | median(ms) | p95(ms) | min(ms) | max(ms) |');
            lines.push('|---|---|---|---|---|---|');
            lines.push(measureTableRows(pdfReport.aggregated) || '(measureなし)');
            lines.push('');
        }
    }

    lines.push('## スキップ/失敗したシナリオ');
    lines.push('');
    if (report.skipped.length === 0) {
        lines.push('なし');
    } else {
        for (const s of report.skipped) {
            lines.push(`- ${s.scenario}${s.size !== undefined ? ` (size=${s.size})` : ''}: ${String(s.reason).split('\n')[0]}`);
        }
    }
    lines.push('');

    lines.push('## コンソールエラー/警告');
    lines.push('');
    if (report.consoleMessages.length === 0) {
        lines.push('なし');
    } else {
        for (const m of report.consoleMessages) {
            lines.push(`- [${m.level}][${m.context}] ${m.text}`);
        }
    }
    lines.push('');

    return lines.join('\n');
}

function writeOutputs(report, outDir) {
    mkdirSync(outDir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(outDir, `bench-${iso}.json`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[bench] 結果を書き出しました: ${jsonPath}`);

    const summaryPath = path.join(outDir, 'summary.md');
    writeFileSync(summaryPath, buildSummaryMarkdown(report), 'utf8');
    console.log(`[bench] サマリを書き出しました: ${summaryPath}`);

    if (report.skipped.length > 0) {
        console.log(`\n[bench] スキップ/失敗したシナリオ (${report.skipped.length}件):`);
        for (const s of report.skipped) {
            console.log(`  - ${s.scenario}${s.size !== undefined ? ` (size=${s.size})` : ''}: ${String(s.reason).split('\n')[0]}`);
        }
    }
    return { jsonPath, summaryPath };
}

// ============================================================
// メイン
// ============================================================

async function main() {
    const options = parseArgs(process.argv.slice(2));
    mkdirSync(options.outDir, { recursive: true });
    buildDemo(options);

    const report = {
        meta: null,
        sizes: [],
        // PDFフィクスチャごとの結果を区別できるよう配列にする（Issue #156（#150 工程5）着手前の
        // 準備。各要素は pdfId・pageCount に加え従来の aggregated/raw/netSnapshots 等を持つ）。
        fulltextPdf: [],
        skipped: [],
        consoleMessages,
    };

    let context = null;
    let exitCode = 0;

    try {
        const profileDir = mkdtempSync(path.join(os.tmpdir(), 'tiab-bench-'));
        context = await chromium.launchPersistentContext(profileDir, {
            headless: options.headless,
            viewport: VIEWPORT,
            args: [
                `--disable-extensions-except=${DIST_DEMO_DIR}`,
                `--load-extension=${DIST_DEMO_DIR}`,
            ],
        });

        let sw = context.serviceWorkers()[0];
        if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
        const extId = new URL(sw.url()).host;
        console.log(`[bench] 拡張機能ID: ${extId}`);

        const page = context.pages()[0] ?? await context.newPage();
        attachConsoleCapture(page);

        contextRef.label = 'boot:demo_signed_in';
        await page.goto(`chrome-extension://${extId}/popup/popup.html`);
        await page.evaluate(() => chrome.storage.local.set({ demo_signed_in: true }));
        const userAgent = await page.evaluate(() => navigator.userAgent);
        report.meta = collectEnvMeta(options, userAgent);

        for (const size of options.sizes) {
            contextRef.label = `size=${size}`;
            console.log(`\n=== size=${size} の計測を開始します ===`);
            const sizeReport = { size, keyOpened: options.keyOpened, scenarios: {} };
            const scenarioDefs = [
                ['bootAndLoad', () => scenarioBootAndLoad(page, extId, buildBenchQuery(size, options))],
                ['decisions', () => scenarioDecisions(page, options.repeat, options.netDelayMs)],
                ['noteNavigate', () => scenarioNoteNavigate(page, options.repeat, options.netDelayMs)],
                ['searchFilter', () => scenarioSearchFilter(page)],
                ['pendingRemoval', () => scenarioPendingRemoval(page)],
                ['settings', () => scenarioSettings(page)],
                ['offlineQueue', () => scenarioOfflineQueue(page)],
            ];

            let priorFailed = false;
            for (const [name, run] of scenarioDefs) {
                contextRef.label = `size=${size}/${name}`;
                if (priorFailed) {
                    report.skipped.push({
                        scenario: name,
                        size,
                        reason: '起動とプロジェクト読み込み（bootAndLoad）が失敗したため、以降の同サイズのシナリオをスキップしました。',
                    });
                    continue;
                }
                try {
                    console.log(`[bench] size=${size} シナリオ実行: ${name}`);
                    const result = await run();
                    sizeReport.scenarios[name] = finalizeScenarioResult(result);
                } catch (err) {
                    const reason = err && err.stack ? String(err.stack) : String(err);
                    console.error(`[bench] size=${size} シナリオ失敗: ${name}\n${reason}`);
                    report.skipped.push({ scenario: name, size, reason });
                    if (name === 'bootAndLoad') priorFailed = true;
                }
            }
            report.sizes.push(sizeReport);
        }

        // シナリオ8はベンチプロファイル・「--size のうち最小のサイズ」で実行する
        // （Issue #151（#150 工程0）チャンク3b。PDF_SCENARIO_REF_ID のコメント参照）。
        // --pdf で複数指定された場合は、指定された各PDFについて1回ずつ実行する
        // （Issue #156（#150 工程5）着手前の準備）。
        const pdfBenchSize = Math.min(...options.sizes);
        for (const pdfId of options.pdfs) {
            contextRef.label = `pdf:${pdfId}`;
            try {
                console.log(`\n[bench] シナリオ実行: pdf（ベンチプロファイル, benchSize=${pdfBenchSize}, benchPdf=${pdfId}）`);
                const pdfResult = await scenarioPdf(context, extId, options.netDelayMs, pdfBenchSize, pdfId);
                report.fulltextPdf.push({
                    pdfId,
                    // 出典: DEMO_PDF_FIXTURES (src/demo/constants.ts)。BENCH_PDF_FIXTURES の複製元。
                    pageCount: BENCH_PDF_FIXTURES[pdfId].pageCount,
                    aggregated: aggregateByName(pdfResult.measures),
                    raw: pdfResult.measures.map((m) => ({
                        name: m.name,
                        durationMs: m.duration,
                        detail: sanitizeDetailValue(m.detail ?? null),
                    })),
                    netSnapshots: pdfResult.netSnapshots,
                    iterations: PDF_SCENARIO_ITERATIONS,
                    benchSize: pdfBenchSize,
                    refId: PDF_SCENARIO_REF_ID,
                });
                for (const s of pdfResult.skipped) {
                    report.skipped.push(s);
                    console.log(`[bench] 部分的にスキップ: ${s.scenario}: ${s.reason.split('\n')[0]}`);
                }
            } catch (err) {
                const reason = err && err.stack ? String(err.stack) : String(err);
                console.error(`[bench] シナリオ失敗: pdf (pdf=${pdfId})\n${reason}`);
                report.skipped.push({ scenario: `pdf (pdf=${pdfId})`, reason });
            }
        }
    } catch (fatalErr) {
        exitCode = 1;
        const reason = fatalErr && fatalErr.stack ? String(fatalErr.stack) : String(fatalErr);
        console.error(`[bench] 致命的エラー: ${reason}`);
        report.skipped.push({ scenario: 'fatal', reason });
    } finally {
        if (context) {
            await context.close().catch(() => {});
        }
        if (!report.meta) {
            report.meta = collectEnvMeta(options, null);
        }
        // どこかのシナリオが失敗しても、ここまでの結果を必ずファイルへ書いてから終了する。
        writeOutputs(report, options.outDir);
    }

    if (report.skipped.length > 0 && exitCode === 0) exitCode = 1;
    process.exit(exitCode);
}

main().catch((err) => {
    console.error('[bench] 予期しないエラーで終了しました:', err);
    process.exit(1);
});
