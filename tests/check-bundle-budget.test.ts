import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CommonJSのテストからNodeのESMローダーを直接使う。
const loadModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const modulePromise = loadModule(pathToFileURL(path.resolve('scripts/check-bundle-budget.mjs')).href);

test('統計の対象JS量だけを読み、map・合計量・別エントリを混ぜない', async () => {
    const { readMeasurements } = await modulePromise;
    assert.deepEqual(readMeasurements({ reports: [
        { label: '拡張版 (extension)', entrypoints: { 'sidepanel/sidepanel': { jsBytes: 100, totalBytes: 1000, mapBytesExcluded: 900 }, 'fulltext/fulltext': { jsBytes: 400 }, other: { jsBytes: 300 } }, asyncChunks: [{ names: ['pdf-image-only'], size: 500 }] },
        { label: 'Web版 (web)', entrypoints: { app: { jsBytes: 200 } } },
    ] }), { 'sidepanel/sidepanel': 100, app: 200, 'fulltext/fulltext': 400, 'pdf-image-only': 500 });
    assert.throws(() => readMeasurements({ reports: [] }), /初期JSバイト数が不正/);
    assert.throws(() => readMeasurements({}), /reports/);
});

function chunkStats(asyncChunks?: { names: string[]; size?: unknown; jsBytes?: number }[]) {
    return { reports: [
        { label: '拡張版 (extension)', entrypoints: { 'sidepanel/sidepanel': { jsBytes: 100 }, 'fulltext/fulltext': { jsBytes: 400 }, 'pdf-image-only': { jsBytes: 999 } }, asyncChunks },
        { label: 'Web版 (web)', entrypoints: { app: { jsBytes: 200 } }, asyncChunks: [{ names: ['pdf-image-only'], size: 888 }] },
    ] };
}

test('遅延チャンクは名前を含むasyncChunksのsizeを読み、同名エントリやWeb版と取り違えない', async () => {
    const { readMeasurements } = await modulePromise;
    const stats = chunkStats([
        { names: ['other'], size: 700 },
        { names: ['alias', 'pdf-image-only'], size: 500, jsBytes: 600 },
    ]);
    assert.equal(readMeasurements(stats)['pdf-image-only'], 500);
});

test('遅延チャンクが無い、または複数ある統計を拒否する', async () => {
    const { readMeasurements } = await modulePromise;
    for (const chunks of [undefined, [], [{ names: ['other'], size: 500 }], [
        { names: ['pdf-image-only'], size: 500 },
        { names: ['pdf-image-only'], size: 600 },
    ]]) {
        assert.throws(() => readMeasurements(chunkStats(chunks)), /遅延チャンクJSバイト数が不正です: 拡張版 \(extension\) \/ pdf-image-only/);
    }
});

test('遅延チャンクのsizeが正の安全な整数でなければ拒否する', async () => {
    const { readMeasurements } = await modulePromise;
    for (const size of [undefined, null, 0, -1, 1.5, '500', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => readMeasurements(chunkStats([{ names: ['pdf-image-only'], size }])), /遅延チャンクJSバイト数が不正/);
    }
});

test('予算の整数切り上げ・1バイト超過・3%改善の境界を検査する', async () => {
    const { createBudget, compareBudget } = await modulePromise;
    assert.equal(createBudget({ app: 101 }).entries.app.maxBytes, 103);
    const budget = { version: 1, entries: { app: { maxBytes: 1000 } } };
    assert.equal(compareBudget({ app: 1000 }, budget)[0].failed, false);
    assert.equal(compareBudget({ app: 1001 }, budget)[0].failed, true);
    assert.equal(compareBudget({ app: 970 }, budget)[0].improved, true);
    assert.equal(compareBudget({ app: 971 }, budget)[0].improved, false);
    assert.throws(() => compareBudget({ other: 100 }, budget), /予算が不正/);
});
