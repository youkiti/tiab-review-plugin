#!/usr/bin/env node
// ドキュメント用スクリーンショット撮影（docs/help.html の Gemini APIキー設定FAQ 向け）
//
// 使い方:
//   npm run build:demo
//   node scripts/doc-screenshots/capture.mjs [--out <出力ディレクトリ>] [--lang ja|en]
//
// 実データ・実アカウント・実APIキーを一切使わず、デモビルド（dist-demo/）を
// Playwright で開いて撮る。拡張機能のロード方式は video/scripts/record.mjs と同じ
// （launchPersistentContext + --load-extension）。
//
// 撮影対象はサイドパネル相当の縦長ビューポートで、原則「カード単位」で切り出す。
// 全景が要る画面（一括実行の進捗など）だけページ全体を撮る。

import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST_DEMO_DIR = path.join(REPO_ROOT, 'dist-demo');

// サイドパネルの実寸に近い縦長ビューポート。等倍だと docs 上で粗いので 2x で撮る。
// 幅は横スクロールバーが出ない最小値（460 では出る）に合わせている。
const VIEWPORT = { width: 500, height: 1000 };
const DEVICE_SCALE_FACTOR = 2;

// デモビルドの Gemini モックが受け付けるダミーキー（実キーではない）
const DEMO_API_KEY = 'AIzaDemoKey1234567890';

function parseArgs(argv) {
    const args = { out: path.join(REPO_ROOT, 'docs/images/faq-gemini'), lang: 'ja' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
        else if (argv[i] === '--lang') args.lang = argv[++i];
        else throw new Error(`不明な引数: ${argv[i]}`);
    }
    return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const { out: outDir, lang } = parseArgs(process.argv.slice(2));
    if (!existsSync(DIST_DEMO_DIR)) {
        throw new Error(`dist-demo/ がありません。先に \`npm run build:demo\` を実行してください: ${DIST_DEMO_DIR}`);
    }
    mkdirSync(outDir, { recursive: true });

    const profileDir = mkdtempSync(path.join(os.tmpdir(), 'tiab-docshot-'));
    const context = await chromium.launchPersistentContext(profileDir, {
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

    let shotIndex = 0;
    const shot = async (name, target) => {
        shotIndex += 1;
        const file = path.join(outDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`);
        await target.screenshot({ path: file });
        console.log(`撮影: ${path.relative(REPO_ROOT, file)}`);
    };

    /** collapsible カードが畳まれていれば開く */
    const expandCard = async (card) => {
        const collapsed = await card.evaluate((el) => el.classList.contains('collapsed'));
        if (collapsed) {
            await card.locator('.collapsible-header').click();
            await sleep(300);
        }
        await card.scrollIntoViewIfNeeded();
        await sleep(200);
    };

    try {
        let sw = context.serviceWorkers()[0];
        if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
        const extId = new URL(sw.url()).host;
        console.log(`拡張機能ID: ${extId}`);

        const page = context.pages()[0] ?? await context.newPage();

        // サインイン済み状態を仕込む（デモビルドは実認証を行わない）
        await page.goto(`chrome-extension://${extId}/popup/popup.html`);
        await page.evaluate(() => chrome.storage.local.set({ demo_signed_in: true }));

        // 判定完了後に出るネイティブ confirm() で撮影が止まらないようにする
        page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}); });

        await page.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);

        // デモプロジェクトへ接続（#recent-sheets の index 1）
        await page.locator('#recent-sheets').waitFor({ state: 'visible', timeout: 15000 });
        await page.locator('#recent-sheets').selectOption({ index: 1 });
        await page.locator('#btn-include').waitFor({ state: 'visible', timeout: 15000 });

        // --- AIタブへ ---
        await page.locator('#tab-llm').click();
        const apiKeyCard = page.locator('#api-key-card');
        await apiKeyCard.waitFor({ state: 'visible', timeout: 10000 });
        await sleep(500);

        // 01: AIタブの全景（どこにAPIキーカードがあるか）
        await shot('ai-tab-overview', page);

        // 02: APIキーカード（未入力）
        await expandCard(apiKeyCard);
        await shot('api-key-card-empty', apiKeyCard);

        // 03: キー入力後（検証OK + プラン表示）
        await page.locator('#gemini-api-key').fill(DEMO_API_KEY);
        await page.locator('#gemini-api-key').dispatchEvent('change');
        await page.locator('#api-key-status').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await sleep(1200);
        await shot('api-key-card-verified', apiKeyCard);

        // 04: 詳細設定（モデル選択）
        const detailCard = page.locator('.llm-card.collapsible', { has: page.locator('#llm-model-select') });
        await expandCard(detailCard);
        await shot('model-select', detailCard);

        // --- 一括実行 ---
        await page.locator('#start-batch-btn').scrollIntoViewIfNeeded();
        await page.locator('#start-batch-btn').click();
        await page.locator('#batch-progress:not(.hidden)').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await sleep(800);

        // 05: 実行中の進捗
        await page.locator('#batch-progress').scrollIntoViewIfNeeded();
        await shot('batch-progress', page.locator('#batch-progress'));

        // 06: 閾値確認セクション（ここを確定しないと pending のまま）
        const thresholdSection = page.locator('#threshold-section');
        await page.locator('#threshold-section:not(.hidden)').waitFor({ state: 'visible', timeout: 120000 });
        await sleep(800);
        await thresholdSection.scrollIntoViewIfNeeded();
        await shot('threshold-section', thresholdSection);

        // 07: 履歴の Run カード（閾値を確定する前 = 「未確定」表示）
        const historyCard = page.locator('.llm-card.collapsible', { has: page.locator('#execution-history') });
        await expandCard(historyCard);
        await sleep(500);
        await shot('history-run-pending', historyCard);

        // 08: 閾値を確定したあとの履歴（確定済み表示との対比用）
        const confirmBtn = page.locator('#confirm-threshold-btn');
        if (await confirmBtn.isVisible().catch(() => false)) {
            await confirmBtn.click();
            await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
            await sleep(2500); // confirm() ダイアログの dismiss と履歴再読込を待つ
            await expandCard(historyCard);
            await shot('history-run-confirmed', historyCard);
        } else {
            console.warn('確定ボタンが見つからないため 08 はスキップしました');
        }

        console.log(`\n完了: ${shotIndex} 枚を ${path.relative(REPO_ROOT, outDir)} に出力しました`);
    } finally {
        await context.close().catch(() => {});
        rmSync(profileDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error('撮影に失敗しました:', err);
    process.exit(1);
});
