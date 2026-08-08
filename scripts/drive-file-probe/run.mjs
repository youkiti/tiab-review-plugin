#!/usr/bin/env node
// Drive File Probe: Playwright ランナー
//
// drive.file スコープの付与挙動を実機で測定するシナリオを実行する。
// 付与は不可逆なので、「測定の順序を間違える」「ベースラインを測り忘れる」といった
// 事故を防ぐため、シナリオ本体（scenarios/*.mjs）はこのランナーが提供する ctx 経由でのみ
// ブラウザを操作する構成にしてある。
//
// 使い方:
//   node scripts/drive-file-probe/run.mjs --list
//   node scripts/drive-file-probe/run.mjs --scenario folder-cascade --profile owner --input folderId=XXX --input fileId=YYY
//
// オプション:
//   --list          scenarios/*.mjs の一覧（id / title / 必要な --input）を表示して終了。
//                    .env が無くても動作する（ローカルサーバを起動しないため）。
//   --scenario <id> 実行するシナリオ（scenarios/<id>.mjs）
//   --profile <name> 永続プロファイルディレクトリ profile/<name>/（既定 default）
//   --input k=v     シナリオへ渡す入力値。複数指定可
//   --output-dir <dir> 出力先（既定 output/<timestamp>/）
//   --keep-open     終了時にブラウザ・サーバを閉じずに残す
//
// ctx（シナリオへ渡すコンテキスト）の詳細は README.md を参照。

import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { startServer } from './serve.mjs';

// playwright は --list では不要なため、実際にブラウザを起動する分岐でのみ動的 import する
// （--list は .env はもちろん playwright のインストール状態にも依存せず動作できるようにするため）。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const PROFILE_ROOT = path.join(__dirname, 'profile');
const OUTPUT_ROOT = path.join(__dirname, 'output');
const BASE_URL = 'http://localhost:8080';

/**
 * ctx.fail() が投げる「意図した中断」を表すエラー。
 * 予期しないバグ（実装ミス・ネットワークエラー等）とは区別し、
 * report.md には「[中断] <理由>」として静かに記録して処理を止める。
 */
class ScenarioAbort extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScenarioAbort';
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ISO文字列の ':' 等、Windowsのパスに使えない文字をファイル名向けに置換する */
function sanitizeTimestamp(date) {
    return date.toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

function parseArgs(argv) {
    const opts = { list: false, scenario: null, profile: 'default', inputs: {}, outputDir: null, keepOpen: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--list':
                opts.list = true;
                break;
            case '--scenario':
                opts.scenario = argv[(i += 1)];
                break;
            case '--profile':
                opts.profile = argv[(i += 1)];
                break;
            case '--input': {
                const kv = argv[(i += 1)];
                if (!kv || !kv.includes('=')) {
                    throw new Error(`--input は key=value 形式で指定してください: ${kv ?? '(値なし)'}`);
                }
                const eq = kv.indexOf('=');
                opts.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
                break;
            }
            case '--output-dir':
                opts.outputDir = argv[(i += 1)];
                break;
            case '--keep-open':
                opts.keepOpen = true;
                break;
            default:
                throw new Error(
                    `不明な引数です: ${arg}` +
                    '（--list / --scenario / --profile / --input / --output-dir / --keep-open のいずれかを指定してください）'
                );
        }
    }
    return opts;
}

async function loadScenarioModule(file) {
    const full = path.join(SCENARIOS_DIR, file);
    const mod = await import(pathToFileURL(full).href);
    return mod.default;
}

function listSceneFiles() {
    if (!existsSync(SCENARIOS_DIR)) return [];
    return readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.mjs'));
}

async function listScenarios() {
    const files = listSceneFiles();
    if (files.length === 0) {
        console.log('シナリオがありません（scripts/drive-file-probe/scenarios/ 配下に *.mjs を追加してください）。');
        return;
    }
    console.log('利用可能なシナリオ:\n');
    for (const file of files) {
        const scene = await loadScenarioModule(file);
        console.log(`- ${scene.id}: ${scene.title}`);
        if (scene.inputs?.length) {
            console.log(`    必要な --input: ${scene.inputs.map((k) => `${k}=<値>`).join(' ')}`);
        }
    }
}

async function loadScenario(id) {
    const file = `${id}.mjs`;
    if (!existsSync(path.join(SCENARIOS_DIR, file))) {
        throw new Error(
            `シナリオが見つかりません: ${id}（scripts/drive-file-probe/scenarios/${file} を確認してください。--list で一覧を確認できます）`
        );
    }
    return loadScenarioModule(file);
}

/**
 * シナリオへ渡す ctx を組み立てる。ここに実装されているメソッドが
 * scenarios/*.mjs から呼べる唯一のブラウザ操作手段になる。
 */
function buildCtx({ page, inputs, log }) {
    async function waitForPageCondition(fn, timeoutMs, description) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const ok = await page.evaluate(fn);
            if (ok) return;
            await sleep(1000);
        }
        throw new Error(`${description} がタイムアウトしました（${Math.round(timeoutMs / 1000)}秒待機）`);
    }

    return {
        input: inputs,

        /**
         * #signin を page.click() でクリックしてサインインを開始する。
         * page.evaluate() から直接 requestAccessToken() を呼ぶと、ユーザージェスチャ起点で
         * ないためポップアップがブロックされる（このハーネスで一番踏みやすい落とし穴）。
         */
        async signIn() {
            console.log('\n=== サインイン ===');
            await waitForPageCondition(() => window.__probe?.state?.ready === true, 30000, 'ページの初期化');
            console.log(
                'ブラウザの「サインイン」ボタンをクリックしてください。' +
                '初回はGoogleアカウント選択・スコープ同意が必要です（最大5分待機します）。'
            );
            await page.click('#signin');
            await waitForPageCondition(
                () => window.__probe.state.signedIn === true || !!window.__probe.state.lastError,
                5 * 60 * 1000,
                'サインイン'
            );
            const lastError = await page.evaluate(() => window.__probe.state.lastError);
            if (lastError) {
                throw new Error(`サインインに失敗しました: ${lastError}`);
            }
            const email = await page.evaluate(() => window.__probe.state.email);
            console.log(`サインイン完了: ${email}`);
            log.push({ type: 'signin', email, at: new Date().toISOString() });
            return email;
        },

        /** window.__probe.measure(targets) をページ内で実行し、結果を記録・表示する */
        async measure(label, targets) {
            const results = await page.evaluate((t) => window.__probe.measure(t), targets);
            console.log(`\n=== 測定: ${label} ===`);
            console.table(
                results.map((r) => ({ label: r.label, kind: r.kind, id: r.id, status: r.status, ok: r.ok, summary: r.summary }))
            );
            log.push({ type: 'measure', label, targets, results, at: new Date().toISOString() });
            return results;
        },

        /**
         * window.__probe.uploadFile({ folderId, name, content }) をページ内で実行し、
         * 結果を記録・表示する。measure() と同じ「1引数のオブジェクトを渡す」書式に揃える。
         */
        async upload(label, { folderId, name, content }) {
            const result = await page.evaluate((t) => window.__probe.uploadFile(t), { folderId, name, content });
            console.log(`\n=== アップロード: ${label} ===`);
            console.table([
                {
                    label,
                    folderId,
                    name,
                    status: result.status,
                    ok: result.ok,
                    summary: result.ok
                        ? `id=${result.body?.id}, name=${result.body?.name}`
                        : JSON.stringify(result.body),
                },
            ]);
            log.push({
                type: 'upload',
                label,
                params: { folderId, name, content },
                result,
                at: new Date().toISOString(),
            });
            return result;
        },

        /**
         * window.__probe.copyFile({ sourceFileId, folderId, name, appProperties }) をページ内で
         * 実行し、結果を記録・表示する。upload() と同じ「1引数のオブジェクトを渡す」書式に揃える。
         */
        async copy(label, { sourceFileId, folderId, name, appProperties }) {
            const result = await page.evaluate(
                (t) => window.__probe.copyFile(t),
                { sourceFileId, folderId, name, appProperties }
            );
            console.log(`\n=== 複製: ${label} ===`);
            console.table([
                {
                    label,
                    sourceFileId,
                    folderId,
                    name,
                    status: result.status,
                    ok: result.ok,
                    summary: result.ok
                        ? `id=${result.body?.id}, name=${result.body?.name}, parents=${JSON.stringify(result.body?.parents)}`
                        : JSON.stringify(result.body),
                },
            ]);
            log.push({
                type: 'copy',
                label,
                params: { sourceFileId, folderId, name, appProperties },
                result,
                at: new Date().toISOString(),
            });
            return result;
        },

        /**
         * #open-picker を page.click() で開く。Picker は docs.google.com の
         * クロスオリジン iframe なので、中身をセレクタで自動操作しようとせず、
         * 人間がクリックする前提で待つだけの設計にしてある。
         */
        async pick(options, instruction) {
            console.log('\n=== Picker 操作が必要です ===');
            console.log(instruction);
            console.log('（最大5分待機します）');
            await page.evaluate((opts) => {
                window.__probe.pickOptions = opts;
                window.__probe.state.pickResult = null;
            }, options);
            await page.click('#open-picker');
            await waitForPageCondition(() => !!window.__probe.state.pickResult, 5 * 60 * 1000, 'Picker 操作');
            const result = await page.evaluate(() => window.__probe.state.pickResult);
            log.push({ type: 'pick', options, instruction, result, at: new Date().toISOString() });
            if (result && result.cancelled) {
                throw new Error('Picker がキャンセルされました。');
            }
            return result;
        },

        /** ターミナルから人間に一行入力させる */
        async ask(question) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            let answer;
            try {
                answer = (await rl.question(`\n${question}\n> `)).trim();
            } finally {
                rl.close();
            }
            log.push({ type: 'ask', question, answer, at: new Date().toISOString() });
            return answer;
        },

        /** report.md へ地の文として追記する */
        note(text) {
            console.log(`\n[メモ] ${text}`);
            log.push({ type: 'note', text, at: new Date().toISOString() });
        },

        /**
         * 前提が崩れたときに測定を中断する。ScenarioAbort を投げて scenario.run() を
         * 抜けるが、main() 側でバグ由来の例外とは区別して扱い、report.md には
         * 「[中断] <message>」として静かに記録する（クラッシュとしては扱わない）。
         */
        fail(message) {
            throw new ScenarioAbort(message);
        },
    };
}

function renderResultsTable(results) {
    const header = '| label | kind | id | status | ok | summary |';
    const sep = '|---|---|---|---|---|---|';
    const rows = results.map(
        (r) => `| ${r.label} | ${r.kind} | ${r.id} | ${r.status} | ${r.ok ? '○' : '×'} | ${r.summary ?? ''} |`
    );
    return [header, sep, ...rows].join('\n');
}

function renderReport({ scenario, opts, log, aborted, abortMessage, startedAt, finishedAt }) {
    const lines = [];
    lines.push(`# ${scenario.title}`);
    lines.push('');
    lines.push(`- シナリオID: ${scenario.id}`);
    lines.push(`- 実行開始: ${startedAt}`);
    lines.push(`- 実行終了: ${finishedAt}`);
    lines.push(`- プロファイル: ${opts.profile}`);
    lines.push(`- 入力: ${Object.entries(opts.inputs).map(([k, v]) => `${k}=${v}`).join(', ') || '(なし)'}`);
    lines.push('');

    for (const entry of log) {
        switch (entry.type) {
            case 'signin':
                lines.push('## サインイン');
                lines.push('');
                lines.push(`- メールアドレス: ${entry.email}`);
                lines.push('');
                break;
            case 'measure':
                lines.push(`## 測定: ${entry.label}`);
                lines.push('');
                lines.push(renderResultsTable(entry.results));
                lines.push('');
                break;
            case 'pick':
                lines.push('## Picker 操作');
                lines.push('');
                lines.push(`- 案内文: ${entry.instruction}`);
                lines.push(`- 選択結果: \`${JSON.stringify(entry.result)}\``);
                lines.push('');
                break;
            case 'upload':
                lines.push(`## アップロード: ${entry.label}`);
                lines.push('');
                lines.push(`- フォルダID: ${entry.params.folderId}`);
                lines.push(`- ファイル名: ${entry.params.name}`);
                lines.push(`- 結果: status=${entry.result.status}, ok=${entry.result.ok ? '○' : '×'}`);
                if (entry.result.ok) {
                    lines.push(`- 作成されたファイル: id=${entry.result.body?.id}, name=${entry.result.body?.name}`);
                } else {
                    lines.push(`- レスポンス本文: \`${JSON.stringify(entry.result.body)}\``);
                }
                lines.push('');
                break;
            case 'copy':
                lines.push(`## 複製: ${entry.label}`);
                lines.push('');
                lines.push(`- コピー元ファイルID: ${entry.params.sourceFileId}`);
                lines.push(`- コピー先フォルダID: ${entry.params.folderId}`);
                lines.push(`- ファイル名: ${entry.params.name}`);
                lines.push(`- 結果: status=${entry.result.status}, ok=${entry.result.ok ? '○' : '×'}`);
                if (entry.result.ok) {
                    lines.push(
                        `- 作成されたファイル: id=${entry.result.body?.id}, name=${entry.result.body?.name}, ` +
                        `parents=${JSON.stringify(entry.result.body?.parents)}`
                    );
                } else {
                    lines.push(`- レスポンス本文: \`${JSON.stringify(entry.result.body)}\``);
                }
                lines.push('');
                break;
            case 'ask':
                lines.push('## 質問');
                lines.push('');
                lines.push(`- Q: ${entry.question}`);
                lines.push(`- A: ${entry.answer}`);
                lines.push('');
                break;
            case 'note':
                lines.push(entry.text);
                lines.push('');
                break;
            default:
                break;
        }
    }

    if (aborted) {
        lines.push('## 中断');
        lines.push('');
        lines.push(`[中断] ${abortMessage}`);
        lines.push('');
    }

    return lines.join('\n');
}

function closeServer(server) {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.list) {
        // .env が無くてもここまでで完結させる（ローカルサーバは起動しない）。
        await listScenarios();
        return;
    }

    if (!opts.scenario) {
        throw new Error('--scenario <id> を指定してください（一覧は --list で確認できます）');
    }

    const scenario = await loadScenario(opts.scenario);
    for (const key of scenario.inputs || []) {
        if (!(key in opts.inputs)) {
            throw new Error(`シナリオ「${opts.scenario}」には --input ${key}=<値> が必要です（--list で確認できます）`);
        }
    }

    const startedAt = new Date();
    const outputDir = opts.outputDir || path.join(OUTPUT_ROOT, sanitizeTimestamp(startedAt));
    mkdirSync(outputDir, { recursive: true });

    console.log(`ローカルサーバを起動しています (${BASE_URL}) ...`);
    const server = await startServer();
    console.log('サーバを起動しました。');

    const profileDir = path.join(PROFILE_ROOT, opts.profile);
    mkdirSync(profileDir, { recursive: true });

    let browserContext;
    try {
        // channel: 'chrome' で実 Chrome を使う。Playwright 同梱の Chromium は
        // Google のサインインで弾かれやすいため、意図的にフォールバックしない。
        const { chromium } = await import('playwright');
        browserContext = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless: false,
            args: ['--disable-blink-features=AutomationControlled'],
        });
    } catch (err) {
        await closeServer(server);
        throw new Error(
            '実 Chrome (channel: "chrome") の起動に失敗しました。playwright がインストール済みで、かつ ' +
            'Google Chrome がインストールされていることを確認してください。\n' +
            'Playwright 同梱の Chromium は Google のサインインで弾かれやすいため、意図的にフォールバックしません。\n' +
            `元のエラー: ${err.message}`
        );
    }

    let aborted = false;
    let abortMessage = '';
    const log = [];

    try {
        const page = browserContext.pages()[0] ?? await browserContext.newPage();
        await page.goto(`${BASE_URL}/probe.html`);

        const ctx = buildCtx({ page, inputs: opts.inputs, log });

        try {
            await scenario.run(ctx);
        } catch (err) {
            if (err instanceof ScenarioAbort) {
                aborted = true;
                abortMessage = err.message;
                console.log(`\n[中断] ${err.message}`);
            } else {
                throw err;
            }
        }
    } finally {
        const finishedAt = new Date();
        const reportPath = path.join(outputDir, 'report.md');
        const rawPath = path.join(outputDir, 'raw.json');

        writeFileSync(
            rawPath,
            JSON.stringify(
                {
                    scenarioId: scenario.id,
                    title: scenario.title,
                    inputs: opts.inputs,
                    profile: opts.profile,
                    startedAt: startedAt.toISOString(),
                    finishedAt: finishedAt.toISOString(),
                    aborted,
                    abortMessage,
                    log,
                },
                null,
                2
            )
        );
        writeFileSync(
            reportPath,
            renderReport({
                scenario,
                opts,
                log,
                aborted,
                abortMessage,
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
            })
        );
        console.log('\nレポートを書き出しました:');
        console.log(`  ${reportPath}`);
        console.log(`  ${rawPath}`);

        if (opts.keepOpen) {
            console.log('\n--keep-open が指定されたため、ブラウザとサーバは終了せず残します（手動で閉じてください）。');
        } else {
            await browserContext.close().catch(() => {});
            await closeServer(server);
        }
    }
}

main().catch((err) => {
    console.error('\nエラーが発生しました:', err.message || err);
    process.exit(1);
});
