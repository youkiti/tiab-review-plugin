import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// CommonJSへの変換で import() が require() にならないよう、Node自身のESMローダーで読む
// （tests/check-bundle-budget.test.ts と同じ手法）。
const loadModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const modulePromise = loadModule(pathToFileURL(path.resolve('scripts/webpack/strip-locale-keys.cjs')).href);

test('接頭辞に一致するキーが除かれる', async () => {
    const { stripLocaleKeys } = await modulePromise;
    const result = stripLocaleKeys({ ftPage_a: '1', fulltext_b: '2', ftPage_c: '3' }, ['ftPage_']);
    assert.deepEqual(result, { fulltext_b: '2' });
});

test('一致しないキーは値ごと残り、キー順が保たれる', async () => {
    const { stripLocaleKeys } = await modulePromise;
    const input = { z: 'first', a: 'second', m: 'third' };
    const result = stripLocaleKeys(input, ['ftPage_']);
    assert.deepEqual(Object.keys(result), ['z', 'a', 'm']);
    assert.deepEqual(result, { z: 'first', a: 'second', m: 'third' });
});

test('入力オブジェクトは変更されない', async () => {
    const { stripLocaleKeys } = await modulePromise;
    const input = { ftPage_a: '1', fulltext_b: '2' };
    const before = JSON.stringify(input);
    stripLocaleKeys(input, ['ftPage_']);
    assert.equal(JSON.stringify(input), before);
});

test('実際の en/messages.json では ftPage_ が全て消え、fulltext_ は同数残る（Web版のTiAb画面を誤って落とさない担保）', async () => {
    const { stripLocaleKeys, WEB_EXCLUDED_KEY_PREFIXES } = await modulePromise;
    assert.deepEqual(WEB_EXCLUDED_KEY_PREFIXES, ['ftPage_']);

    const messages = JSON.parse(
        require('node:fs').readFileSync(path.resolve('src/_locales/en/messages.json'), 'utf8')
    );
    const beforeFulltextCount = Object.keys(messages).filter((k) => k.startsWith('fulltext_')).length;

    const result = stripLocaleKeys(messages);

    assert.equal(Object.keys(result).filter((k) => k.startsWith('ftPage_')).length, 0);
    const afterFulltextCount = Object.keys(result).filter((k) => k.startsWith('fulltext_')).length;
    assert.equal(afterFulltextCount, beforeFulltextCount);
    assert.ok(afterFulltextCount > 0);
});
