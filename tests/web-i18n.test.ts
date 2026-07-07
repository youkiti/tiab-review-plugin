import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMessage, type Messages } from '../src/platform/web/i18n-core';

test('単純なメッセージ参照ができる', () => {
    const lang: Messages = { hello: { message: 'こんにちは' } };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'hello'), 'こんにちは');
});

test('数値プレースホルダ $1 を substitutions で置換できる', () => {
    const lang: Messages = {
        count_msg: {
            message: '件数: $count$',
            placeholders: { count: { content: '$1' } },
        },
    };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'count_msg', ['42']), '件数: 42');
});

test('プレースホルダ名は大文字小文字を区別しない（メッセージ側が大文字でも解決できる）', () => {
    const lang: Messages = {
        count_msg: {
            message: '件数: $COUNT$',
            placeholders: { count: { content: '$1' } },
        },
    };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'count_msg', ['7']), '件数: 7');
});

test('lang にキーが無い場合は fallback を参照する', () => {
    const lang: Messages = {};
    const fallback: Messages = { hello: { message: 'Hello' } };
    assert.equal(resolveMessage(lang, fallback, 'hello'), 'Hello');
});

test('lang にも fallback にもキーが無い場合は空文字を返す', () => {
    const lang: Messages = {};
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'missing'), '');
});
