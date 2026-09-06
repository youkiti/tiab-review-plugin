import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CommonJSのテストからNodeのESMローダーを直接使う。
const loadModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const modulePromise = loadModule(pathToFileURL(path.resolve('scripts/check-bundle-budget.mjs')).href);

test('統計の初期JS量だけを読み、map・合計量・別エントリを混ぜない', async () => {
    const { readMeasurements } = await modulePromise;
    assert.deepEqual(readMeasurements({ reports: [
        { label: '拡張版 (extension)', entrypoints: { 'sidepanel/sidepanel': { jsBytes: 100, totalBytes: 1000, mapBytesExcluded: 900 }, other: { jsBytes: 300 } } },
        { label: 'Web版 (web)', entrypoints: { app: { jsBytes: 200 } } },
    ] }), { 'sidepanel/sidepanel': 100, app: 200 });
    assert.throws(() => readMeasurements({ reports: [] }), /初期JSバイト数が不正/);
    assert.throws(() => readMeasurements({}), /reports/);
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
