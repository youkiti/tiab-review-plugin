// 新しい一時プロファイルで拡張機能（デモビルド）を読み込んで、シナリオを1本実行する。

import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { DIST_DEMO_DIR, DEVICE_SCALE_FACTOR, config } from './constants.mjs';
import { Run } from './run.mjs';

/** 新しい一時プロファイルで拡張機能を読み込み、fn(run) を実行して結果を返す。終了時は必ず閉じて消す。 */
export async function withFreshBrowser(name, lang, fn) {
    const profileDir = mkdtempSync(path.join(os.tmpdir(), `tiab-tourcheck-${name}-`));
    let context;
    try {
        context = await chromium.launchPersistentContext(profileDir, {
            headless: false,
            viewport: config.viewport,
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
