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

test('placeholders 定義が無い素の $1/$2 も substitutions で置換できる（chrome.i18n 互換）', () => {
    const lang: Messages = {
        progress: { message: '$1 / $2件（残り$3件）' },
    };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'progress', ['5', '10', '5']), '5 / 10件（残り5件）');
});

test('substitutions が足りない素の $n は空文字になる', () => {
    const lang: Messages = { msg: { message: 'A: $1, B: $2' } };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'msg', ['x']), 'A: x, B: ');
});

test('$$ はリテラルの $ として出力される', () => {
    const lang: Messages = { price: { message: '価格: $$$1' } };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'price', ['100']), '価格: $100');
});

test('置換値に $ を含んでも特殊解釈されない', () => {
    const lang: Messages = {
        count_msg: {
            message: '件数: $count$',
            placeholders: { count: { content: '$1' } },
        },
    };
    const fallback: Messages = {};
    assert.equal(resolveMessage(lang, fallback, 'count_msg', ['$&や$1を含む値']), '件数: $&や$1を含む値');
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
