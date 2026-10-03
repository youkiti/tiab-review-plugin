import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodePlatform } from '../src/platform/node';

function adapter() {
    return createNodePlatform({
        getAccessToken: async () => '固定値', forceReauth: async () => '再取得', clearAuth: async () => {},
        messages: { greeting: { message: 'こんにちは $name$', placeholders: { name: { content: '$1' } } } },
        fallbackMessages: { fallback: { message: '代替 $1' } }, version: 'cli-test',
    });
}

test('文言の置換・代替・未定義キーを解決する', () => {
    const p = adapter();
    assert.equal(p.getMessage('greeting', ['世界']), 'こんにちは 世界');
    assert.equal(p.getMessage('fallback', ['文言']), '代替 文言');
    assert.equal(p.getMessage('missing'), '');
});

test('保存・取得・削除・全消去をプロセス内で行う', async () => {
    const p = adapter();
    await p.storageSet({ a: 1, b: undefined, c: '値' });
    assert.deepEqual(await p.storageGet(['a', 'b', 'missing']), { a: 1, b: undefined });
    await p.storageRemove('a');
    await p.storageRemove(['b']);
    assert.deepEqual(await p.storageGet(['a', 'b', 'c']), { c: '値' });
    assert.deepEqual(await adapter().storageGet(['c']), {});
    await p.storageClear();
    assert.deepEqual(await p.storageGet(['c']), {});
});

test('認証・通知・バージョン・機能フラグを接続する', async () => {
    const p = adapter();
    assert.equal(await p.getAuthToken(), '固定値');
    assert.equal(await p.forceReauth(), '再取得');
    await p.clearAuth();
    const received: unknown[] = [];
    p.onMessage(message => received.push(message));
    p.emitMessage({ value: 1 });
    assert.deepEqual(received, [{ value: 1 }]);
    assert.equal(p.getVersionString(), 'cli-test');
    assert.deepEqual(p.capabilities, { llm: false, ml: false, fulltext: false, importExport: true, createProject: true });
});
