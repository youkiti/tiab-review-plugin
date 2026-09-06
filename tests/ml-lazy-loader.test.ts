import test from 'node:test';
import assert from 'node:assert/strict';
import { createMlFeatureLoader } from '../src/lib/ml-lazy-loader';

test('MLローダー: 並行呼び出しは同じPromiseに合流し、読み込み完了を待つ', async () => {
    let calls = 0;
    let resolve!: (value: object) => void;
    const imported = new Promise<object>(done => { resolve = done; });
    const load = createMlFeatureLoader(() => {
        calls++;
        return imported;
    });
    const first = load();
    const second = load();
    assert.equal(first, second);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(settled, false);
    const feature = {};
    resolve(feature);
    assert.deepEqual(await Promise.all([first, second]), [feature, feature]);
});

test('MLローダー: 失敗は呼び出し元へ返し、次の操作で再試行する', async () => {
    let calls = 0;
    const failure = new Error('チャンク読込失敗');
    const feature = {};
    const load = createMlFeatureLoader(async () => {
        if (++calls === 1) throw failure;
        return feature;
    });
    const first = load();
    const second = load();
    assert.equal(first, second);
    await Promise.all([assert.rejects(first, failure), assert.rejects(second, failure)]);
    assert.equal(await load(), feature);
    assert.equal(calls, 2);
});

test('MLローダー: 成功後は同じPromiseとモジュールをキャッシュする', async () => {
    let calls = 0;
    const feature = {};
    const load = createMlFeatureLoader(async () => {
        calls++;
        return feature;
    });
    const first = load();
    assert.equal(await first, feature);
    assert.equal(load(), first);
    assert.equal(await load(), feature);
    assert.equal(calls, 1);
});

test('MLローダー: importerの同期例外も再試行できる', async () => {
    let calls = 0;
    const load = createMlFeatureLoader(() => {
        if (++calls === 1) throw new Error('初期化失敗');
        return Promise.resolve('成功');
    });
    await assert.rejects(load(), /初期化失敗/);
    assert.equal(await load(), '成功');
    assert.equal(calls, 2);
});
