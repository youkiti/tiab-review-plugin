#!/usr/bin/env node
// 案内ツアー2本の通し検証（デモビルドを Playwright で操作し、最初から最後まで進める）
//
// 使い方:
//   npm run build:demo
//   npm run check:tours -- [--only 1|2] [--lang ja|en]
//
//   --only 1  ツアー1（first-project）だけ実行する
//   --only 2  ツアー2（join-project, ?demoPickerRequired=1）だけ実行する
//   --lang    ブラウザとUIの言語（既定 ja）
//
// CI には入れていない。headed の Chrome で拡張機能を読み込むため、ブラウザの動く環境が要る。
// 拡張機能のロード方式は scripts/doc-screenshots/capture.mjs と同じ
// （launchPersistentContext + --load-extension で dist-demo/ を読む）。
// 実データ・実アカウントは使わない。シナリオごとに新しい一時プロファイルで起動し、終了時に必ず消す。
//
// 各手順で `#guide-tour-card` の `data-guide-step` が期待する手順 ID になるのを待ってから操作し、
// 手順が進むたびに .tmp/guide-tour-check/<シナリオ>-<連番>-<手順ID>.png を保存する
// （fullPage は付けない。リサイズで吹き出しが閉じるため）。
// 1つでも失敗したら exit 1。失敗時は「どのシナリオの、どの手順で、何を待っていたか」を出す。

import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_DEMO_DIR = path.join(REPO_ROOT, 'dist-demo');
const OUT_DIR = path.join(REPO_ROOT, '.tmp', 'guide-tour-check');
const NBIB_FILE = path.join(REPO_ROOT, 'sample', 'pubmed-srws-psgad-set.nbib');

// src/demo/constants.ts の DEMO_SPREADSHEET_ID と同じ値（TS は import できないため手で写している）
const DEMO_SPREADSHEET_ID = 'demo-spreadsheet-001';
const DEMO_SHEET_URL = `https://docs.google.com/spreadsheets/d/${DEMO_SPREADSHEET_ID}/edit`;

// サイドパネルの実寸に近い縦長ビューポート（capture.mjs と同じ）
const VIEWPORT = { width: 500, height: 1000 };
const DEVICE_SCALE_FACTOR = 1;

const STEP_TIMEOUT = 20000; // 手順が切り替わるまでの待ち
const POLL_STEP_TIMEOUT = 40000; // Picker 許可後の自動再接続（3秒ポーリング）を待つ手順
const ACTION_TIMEOUT = 10000; // 要素が押せるようになるまでの待ち
const NEGATIVE_WAIT = 4000; // 「現れないこと」を確かめる待ち

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
    const args = { only: null, lang: 'ja' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--only') {
            const value = argv[++i];
            if (value !== '1' && value !== '2') throw new Error('--only には 1 または 2 を指定してください');
            args.only = Number(value);
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

/** シナリオ1回ぶんの実行状態（ブラウザ・ページ・スクリーンショット連番）を持つ。 */
class Run {
    constructor(name, page, extId, lang) {
        this.name = name;
        this.page = page;
        this.extId = extId;
        this.lang = lang;
        this.shotCount = 0;
        this.shots = [];
    }

    log(message) {
        console.log(`  [${this.name}] ${message}`);
    }

    async shot(label) {
        this.shotCount += 1;
        const file = path.join(OUT_DIR, `${this.name}-${String(this.shotCount).padStart(2, '0')}-${label}.png`);
        await this.page.screenshot({ path: file }).catch(() => {});
        this.shots.push(path.relative(REPO_ROOT, file));
        return file;
    }

    /** 待ちが切れたとき、シナリオ名・手順・待っていたもの・カードの属性・スクリーンショットを出して例外にする。 */
    async fail(stepLabel, waiting, cause) {
        const card = await this.cardAttrs();
        const file = await this.shot(`FAIL-${stepLabel}`);
        const detail = cause ? `\n    原因: ${cause instanceof Error ? cause.message.split('\n')[0] : cause}` : '';
        throw new Error(
            `シナリオ ${this.name} / 手順 ${stepLabel} で待ちが切れました: ${waiting}\n` +
            `    カードの属性: ${card}\n    スクリーンショット: ${path.relative(REPO_ROOT, file)}${detail}`,
        );
    }

    async cardAttrs() {
        try {
            return await this.page.evaluate(() => {
                const card = document.getElementById('guide-tour-card');
                if (!card) return '(#guide-tour-card なし)';
                return JSON.stringify(Object.fromEntries(Array.from(card.attributes).map((a) => [a.name, a.value])));
            });
        } catch {
            return '(取得失敗)';
        }
    }

    /** 開いているアプリ内モーダルがあれば閉じる（取り込み後の確認や案内など）。 */
    async closeModal() {
        const open = await this.page.locator('#modal-backdrop:not(.hidden)').count().catch(() => 0);
        if (open > 0) {
            await this.page.locator('#modal-close-btn').click({ timeout: 3000 }).catch(() => {});
            await sleep(200);
        }
    }

    /** カードの手順 ID が expected（文字列または配列）のどれかになるのを待ち、実際の ID を返す。 */
    async waitStep(tourId, expected, timeout = STEP_TIMEOUT) {
        const ids = Array.isArray(expected) ? expected : [expected];
        const label = ids.join('|');
        try {
            await this.page.waitForFunction(
                ({ tour, steps }) => {
                    const card = document.getElementById('guide-tour-card');
                    if (!card) return false;
                    return card.getAttribute('data-guide-tour') === tour && steps.includes(card.getAttribute('data-guide-step'));
                },
                { tour: tourId, steps: ids },
                { timeout },
            );
        } catch (err) {
            await this.fail(label, `#guide-tour-card が data-guide-tour="${tourId}" data-guide-step="${label}" になること`, err);
        }
        const actual = await this.page.locator('#guide-tour-card').getAttribute('data-guide-step');
        this.log(`手順 ${actual} に到達`);
        await sleep(300); // 吹き出しの描画と強調枠の位置合わせを待つ
        await this.shot(actual);
        return actual;
    }

    /** 要素が押せる状態になるのを待って押す。押せなければ失敗。 */
    async click(selector, stepLabel, what) {
        await this.closeModal();
        try {
            await this.page.locator(selector).first().click({ timeout: ACTION_TIMEOUT });
        } catch (err) {
            await this.fail(stepLabel, `${what}（${selector}）を押せること`, err);
        }
    }

    /** カードの「次へ」（最後の手順では「完了」）を押す。 */
    async clickNext(stepLabel) {
        await this.click('#guide-tour-card [data-guide-action="next"]', stepLabel, 'カードの「次へ」');
    }

    async waitVisible(selector, stepLabel, what, timeout = STEP_TIMEOUT) {
        try {
            await this.page.locator(selector).first().waitFor({ state: 'visible', timeout });
        } catch (err) {
            await this.fail(stepLabel, `${what}（${selector}）が表示されること`, err);
        }
    }

    /** セレクタに合う要素が timeout の間ずっと現れないこと。現れたら失敗。 */
    async expectAbsent(selector, stepLabel, what, timeout = NEGATIVE_WAIT) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (await this.page.locator(selector).first().isVisible().catch(() => false)) {
                await this.fail(stepLabel, `${what}（${selector}）が現れないこと（現れてしまった）`);
            }
            await sleep(250);
        }
    }

    async waitCardGone(stepLabel) {
        try {
            await this.page.waitForFunction(() => {
                const card = document.getElementById('guide-tour-card');
                if (!card) return true;
                const style = getComputedStyle(card);
                return card.hidden || style.display === 'none' || style.visibility === 'hidden';
            }, null, { timeout: STEP_TIMEOUT });
        } catch (err) {
            await this.fail(stepLabel, '#guide-tour-card が消えること', err);
        }
    }

    async readProgress() {
        return this.page.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get('guide_progress', (items) => resolve(items.guide_progress ?? null));
        }));
    }

    /** guide_progress の tours[tourId].status が expected になるのを待つ。 */
    async waitTourStatus(tourId, expected, stepLabel) {
        const deadline = Date.now() + STEP_TIMEOUT;
        let last = null;
        while (Date.now() < deadline) {
            last = await this.readProgress().catch(() => null);
            if (last?.tours?.[tourId]?.status === expected) return;
            await sleep(300);
        }
        await this.fail(stepLabel, `guide_progress.tours["${tourId}"].status が "${expected}" になること（実際: ${JSON.stringify(last)}）`);
    }

    sidepanelUrl(query = '') {
        return `chrome-extension://${this.extId}/sidepanel/sidepanel.html${query}`;
    }

    /** 未サインインで開き、ダイアログを一括処理する設定を入れてから、ログインボタンでサインインする。 */
    async openAndLogin(query = '') {
        // prompt（プロジェクト名）・confirm・alert はすべて承諾する
        this.page.on('dialog', (dialog) => {
            const accept = dialog.type() === 'prompt' ? dialog.accept('ツアー検証用プロジェクト') : dialog.accept();
            accept.catch(() => {});
        });
        await this.page.goto(this.sidepanelUrl(query));
        await this.waitVisible('#login-btn', 'login', 'ログインボタン');
        await this.click('#login-btn', 'login', 'ログインボタン');
        await this.waitVisible('#project-section', 'login', 'プロジェクト選択画面');
    }

    /** 自動提案バナーが出て、指定のボタンで始められることを確かめて押す。 */
    async startFromBanner(action) {
        await this.waitVisible('#guide-suggest-banner', 'banner', '自動提案のバナー');
        await this.shot('banner');
        await this.click(`#guide-suggest-banner [data-guide-action="${action}"]`, 'banner', `バナーの ${action}`);
    }
}

/** 新しい一時プロファイルで拡張機能を読み込み、fn(run) を実行して結果を返す。終了時は必ず閉じて消す。 */
async function withFreshBrowser(name, lang, fn) {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), `tiab-tourcheck-${name}-`));
    let context;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            viewport: VIEWPORT,
            deviceScaleFactor: DEVICE_SCALE_FACTOR,
            locale: lang,
            args: [
                `--disable-extensions-except=${DIST_DEMO_DIR}`,
                `--load-extension=${DIST_DEMO_DIR}`,
                `--lang=${lang}`,
            ],
        });
        let sw = context.serviceWorkers()[0];
        if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
        const extId = new URL(sw.url()).host;
        const page = context.pages()[0] ?? await context.newPage();
        const run = new Run(name, page, extId, lang);
        try {
            await fn(run);
        } catch (err) {
            // 想定外の例外（要素が見つからない等）も、スクリーンショットだけは残す
            if (!String(err?.message ?? '').includes(`シナリオ ${name} /`)) await run.shot('ERROR').catch(() => {});
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { run });
        }
        return run;
    } finally {
        if (context) await context.close().catch(() => {});
        try {
            rmSync(profileDir, { recursive: true, force: true });
        } catch (err) {
            console.warn(`一時プロファイルを消せませんでした: ${profileDir} (${err.message})`);
        }
    }
}

/** 🧭 の一覧を開き、tourId の行が済みになっていることを確かめて閉じる。 */
async function expectTourListDone(run, tourId) {
    // 表示中の 🧭 ボタンを選ぶ（プロジェクト選択画面とスクリーニング画面に1つずつある）
    await run.click('[data-tour="tour-list"]:visible', 'tour-list', '🧭 ツアー一覧ボタン');
    await run.waitVisible('#guide-tour-list', 'tour-list', 'ツアー一覧パネル');
    try {
        await run.page.locator(`[data-guide-tour-item="${tourId}"][data-guide-done="true"]`).waitFor({ state: 'attached', timeout: ACTION_TIMEOUT });
    } catch (err) {
        await run.fail('tour-list', `一覧の ${tourId} の行に data-guide-done="true" が付くこと`, err);
    }
    await run.shot('tour-list-done');
    await run.click('#guide-tour-list [data-guide-action="close-list"]', 'tour-list', '一覧を閉じるボタン');
}

// ---------------------------------------------------------------------------
// シナリオ1: ツアー1（first-project）
// ---------------------------------------------------------------------------
async function scenario1(run) {
    const T = 'first-project';
    await run.openAndLogin();
    await run.startFromBanner('start-first-project');

    // 作成（prompt は dialog ハンドラが承諾する）
    await run.waitStep(T, 'project-create');
    await run.click('#create-btn', 'project-create', '新規作成ボタン');

    // 取り込み
    await run.waitStep(T, 'import');
    if (!existsSync(NBIB_FILE)) throw new Error(`取り込み用ファイルがありません: ${NBIB_FILE}`);
    await run.page.locator('#ris-file').setInputFiles(NBIB_FILE);

    await run.waitStep(T, 'read');
    const dialogShown = await expectDialogWaiting(run, 'read'); // 取り込み後のダイアログが開いている間は「ダイアログ待ち」
    if (dialogShown) await expectDialogButtonClickableInLowViewport(run, 'read');
    await run.closeModal(); // 取り込み後の確認・案内が出ていれば閉じる
    await expectDialogWaitingEnded(run, 'read');
    await run.clickNext('read');

    // 判定 → ここで1回リロードし、同じ手順から再開することを確かめる
    await run.waitStep(T, 'decide');
    await expectCardStaysInViewportWhileScrolling(run, 'decide');
    await reloadAndExpectResume(run, T, 'decide');
    await run.click('#btn-include', 'decide', '判定ボタン（Include）');

    // 前へ → 判定し直し
    await run.waitStep(T, 'go-back');
    await run.click('[data-tour="prev"]', 'go-back', '「前へ」ボタン');
    await run.waitStep(T, 'redecide');
    await run.click('#btn-exclude', 'redecide', '判定ボタン（Exclude）');

    // Blind: スイッチが押せないこと
    await run.waitStep(T, 'blind');
    await expectBlindSwitchBlocked(run);
    await run.clickNext('blind');

    // 完了
    await run.waitStep(T, 'finish');
    await run.clickNext('finish');
    await run.waitCardGone('finish');
    await run.waitTourStatus(T, 'done', 'finish');
    run.log('guide_progress: first-project が done');

    // プロジェクト選択画面へ戻ってもバナーが出ない
    await run.click('#back-btn', 'after-finish', '戻るボタン');
    await run.waitVisible('#project-section', 'after-finish', 'プロジェクト選択画面');
    await run.expectAbsent('#guide-suggest-banner', 'after-finish', '自動提案のバナー');
    await run.shot('project-no-banner');

    await expectTourListDone(run, T);
}

/** ページを再読み込みし、同じ手順（stepId）のカードから再開することを確かめる。 */
/**
 * 取り込み後に開くダイアログ（担当セットの作成など）の間は、カードが data-guide-waiting-reason="modal" で出て
 * 「次へ」が隠れていること。ダイアログが出なかったときは、その旨をログに出して先へ進む（失敗にしない）。
 */
async function expectDialogWaiting(run, stepLabel) {
    const opened = await run.page.locator('#modal-backdrop:not(.hidden)')
        .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    if (!opened) {
        run.log('取り込み後にダイアログは開かなかったため、ダイアログ待ちの確認を省略');
        return false;
    }
    try {
        await run.page.waitForFunction(() => {
            const card = document.getElementById('guide-tour-card');
            if (!card) return false;
            const next = card.querySelector('[data-guide-action="next"]');
            return card.getAttribute('data-guide-waiting-reason') === 'modal'
                && card.getAttribute('data-guide-waiting') === 'true'
                && next !== null && getComputedStyle(next).display === 'none';
        }, null, { timeout: 5000 });
    } catch (err) {
        await run.fail(stepLabel, 'ダイアログが開いている間、カードが data-guide-waiting-reason="modal" で「次へ」が隠れていること', err);
    }
    await sleep(300);
    await run.shot(`${stepLabel}-modal`);
    run.log('ダイアログ待ちの表示を確認');
    return true;
}

/**
 * 画面が低くてカードがダイアログの上下に収まらないときは、カードが小さい表示（data-guide-compact）になり、
 * ダイアログのフッターのボタンを実際に押せること。確認のため画面を一時的に低くし、終わったら元に戻す
 * （この確認でダイアログは閉じる）。
 */
async function expectDialogButtonClickableInLowViewport(run, stepLabel) {
    const original = run.page.viewportSize();
    await run.page.setViewportSize({ width: 400, height: 480 });
    try {
        const compact = await run.page.waitForFunction(
            () => document.getElementById('guide-tour-card')?.getAttribute('data-guide-compact') === 'true',
            null, { timeout: 4000 },
        ).then(() => true, () => false);
        run.log(compact ? '低い画面: カードが小さい表示になった' : '低い画面でもカードは通常表示のまま（ダイアログの上下に収まった）');
        await sleep(300);
        await run.shot(`${stepLabel}-modal-low`);
        try {
            await run.page.locator('#modal-footer button').first().click({ timeout: 3000 });
        } catch (err) {
            await run.fail(stepLabel, '低い画面で、ダイアログのフッターのボタンがカードに覆われず押せること', err);
        }
        await run.page.locator('#modal-backdrop.hidden').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
        run.log('低い画面でダイアログのボタンを押せた');
    } finally {
        if (original) await run.page.setViewportSize(original);
    }
}

/** ページをスクロールしても、カードと「ツアーを終える」ボタンが常に画面内にあること。 */
async function expectCardStaysInViewportWhileScrolling(run, stepLabel) {
    for (const y of [0, 600, 2000, 100000, 0]) {
        await run.page.evaluate((top) => window.scrollTo(0, top), y);
        await sleep(700); // 位置合わせ（400ms 間隔の補助を含む）を待つ
        const check = await run.page.evaluate(() => {
            const card = document.getElementById('guide-tour-card');
            const end = card?.querySelector('[data-guide-action="end"]');
            if (!card || !end) return { ok: false, reason: 'カードまたは「ツアーを終える」が無い' };
            const vw = document.documentElement.clientWidth;
            const vh = window.innerHeight;
            const inside = (r) => r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
            const c = card.getBoundingClientRect();
            const e = end.getBoundingClientRect();
            return { ok: inside(c) && inside(e), reason: `card=${JSON.stringify(c)} viewport=${vw}x${vh}` };
        });
        if (!check.ok) {
            await run.shot(`${stepLabel}-scroll-${y}`);
            await run.fail(stepLabel, `スクロール位置 ${y} でカードと「ツアーを終える」が画面内にあること（${check.reason}）`);
        }
    }
    await run.shot(`${stepLabel}-scrolled`);
    run.log('スクロールしてもカードが画面内にあることを確認');
}

/** ダイアログを閉じたあと、カードが通常の表示（待機の印なし・「次へ」あり）に戻ること。 */
async function expectDialogWaitingEnded(run, stepLabel) {
    try {
        await run.page.waitForFunction(() => {
            const card = document.getElementById('guide-tour-card');
            if (!card) return false;
            const next = card.querySelector('[data-guide-action="next"]');
            return card.getAttribute('data-guide-waiting-reason') === null
                && card.getAttribute('data-guide-waiting') === null
                && next !== null && getComputedStyle(next).display !== 'none';
        }, null, { timeout: 5000 });
    } catch (err) {
        await run.fail(stepLabel, 'ダイアログを閉じると、カードが通常の表示（待機の印なし・「次へ」あり）に戻ること', err);
    }
}

async function reloadAndExpectResume(run, tourId, stepId) {
    run.log(`手順 ${stepId} でページを再読み込みします`);
    await run.page.reload();
    // 再読み込み後にプロジェクト選択画面へ戻る実装なら、最近のシートから入り直す（ベストエフォート）
    const onScreening = await run.page.locator('#btn-include').waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
    if (!onScreening) {
        const hasRecent = await run.page.locator('#recent-sheets option').count().catch(() => 0);
        if (hasRecent > 1) {
            run.log('再読み込み後にプロジェクト選択画面へ戻ったため、#recent-sheets の index 1 で接続し直します');
            await run.page.locator('#recent-sheets').selectOption({ index: 1 });
        }
    }
    await run.waitStep(tourId, stepId);
    run.log(`再読み込み後も手順 ${stepId} から再開しました`);
}

/** Blind の手順: #key-section のスイッチを押しても checked が変わらない。覆いに遮られて押せない場合も合格。 */
async function expectBlindSwitchBlocked(run) {
    await run.waitVisible('#key-section', 'blind', 'Blind のスイッチ領域');
    const readChecked = () => run.page.locator('#key-toggle-input').isChecked();
    const before = await readChecked();
    let verdict;
    try {
        await run.page.locator('#key-section .slider').click({ timeout: 3000 });
        verdict = 'クリックは通ったが状態を確かめる';
    } catch {
        verdict = 'クリックが覆いに遮られて押せなかった';
    }
    await sleep(500);
    const after = await readChecked();
    if (after !== before) {
        await run.fail('blind', `Blind のスイッチの checked が変わらないこと（${before} -> ${after}。${verdict}）`);
    }
    run.log(`Blind のスイッチは変わらず（${verdict}、checked=${after}）`);
    await run.shot('blind-switch-blocked');
}

// ---------------------------------------------------------------------------
// シナリオ2: ツアー2（join-project, ?demoPickerRequired=1）
// ---------------------------------------------------------------------------
async function scenario2(run) {
    const T = 'join-project';
    await run.openAndLogin('?demoPickerRequired=1');
    await run.startFromBanner('start-join-project');

    // URL 欄に貼り付け
    await run.waitStep(T, 'paste-url');
    await run.page.locator('#spreadsheet-input').fill(DEMO_SHEET_URL);

    // 接続（Picker の許可が要るので、案内が出る）
    await run.waitStep(T, 'connect');
    await run.click('#connect-btn', 'connect', '接続ボタン');

    // 許可
    await run.waitStep(T, 'allow');
    await run.click('[data-tour="picker-open"]', 'allow', 'Picker 案内の「Googleで許可する」ボタン');

    // 3秒ごとのポーリングで自動的に接続し直す。担当の手順は出ても飛ばされてもよい。
    const reached = await run.waitStep(T, ['assignment', 'decide'], POLL_STEP_TIMEOUT);
    if (reached === 'assignment') {
        run.log('assignment の手順が出ました（「次へ」で進めます）');
        await run.clickNext('assignment');
        await run.waitStep(T, 'decide');
    } else {
        run.log('assignment の手順は飛ばされました（担当セットが無い）');
    }

    await run.click('#btn-include', 'decide', '判定ボタン（Include）');

    await run.waitStep(T, 'finish');
    await run.clickNext('finish');
    await run.waitCardGone('finish');
    await run.waitTourStatus(T, 'done', 'finish');
    run.log('guide_progress: join-project が done');
}

// ---------------------------------------------------------------------------

async function main() {
    const { only, lang } = parseArgs(process.argv.slice(2));
    if (!existsSync(DIST_DEMO_DIR) || readdirSync(DIST_DEMO_DIR).length === 0) {
        throw new Error(`dist-demo/ がありません。先に \`npm run build:demo\` を実行してください: ${DIST_DEMO_DIR}`);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    // 古い実行のスクリーンショットが混ざらないよう、この検証の出力だけを掃除する
    for (const f of readdirSync(OUT_DIR)) {
        if (f.endsWith('.png')) rmSync(path.join(OUT_DIR, f), { force: true });
    }

    const scenarios = [
        { no: 1, name: 'scenario1', title: 'ツアー1 first-project', fn: scenario1 },
        { no: 2, name: 'scenario2', title: 'ツアー2 join-project', fn: scenario2 },
    ].filter((s) => only === null || s.no === only);

    const results = [];
    const allShots = [];
    for (const s of scenarios) {
        console.log(`\n=== ${s.title} ===`);
        try {
            const run = await withFreshBrowser(s.name, lang, s.fn);
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
