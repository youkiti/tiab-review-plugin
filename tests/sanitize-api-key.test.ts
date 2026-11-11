/**
 * sanitizeApiKey のテスト（全プロバイダ共通の API キー整形）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeApiKey } from '../src/lib/providers/sanitize-api-key';

test('sanitizeApiKey: 通常ASCII キーはそのまま通る', () => {
    const key = 'sk-or-v1-abc123XYZ_-=';
    assert.equal(sanitizeApiKey(key, 'OpenRouter'), key);
});

test('sanitizeApiKey: 前後空白を除去', () => {
    assert.equal(sanitizeApiKey('  sk-or-v1-abc  ', 'OpenRouter'), 'sk-or-v1-abc');
});

test('sanitizeApiKey: ZWSP / BOM / NBSP を除去', () => {
    const dirty = '​sk‌-or‍-v1⁠-﻿abc ';
    assert.equal(sanitizeApiKey(dirty, 'OpenRouter'), 'sk-or-v1-abc');
});

test('sanitizeApiKey: ISO-8859-1 範囲外（全角文字）は例外', () => {
    assert.throws(() => sanitizeApiKey('sk-or-v1-ｘｘｘ', 'OpenRouter'), /ISO-8859-1/);
});

test('sanitizeApiKey: 日本語が混入したキーも例外', () => {
    assert.throws(() => sanitizeApiKey('sk-or-v1-あいう', 'OpenRouter'), /ISO-8859-1/);
});

test('sanitizeApiKey: 例外文はプロバイダ名で始まる', () => {
    for (const label of ['OpenAI', 'Anthropic', 'TypeSafe']) {
        assert.throws(
            () => sanitizeApiKey('key-あ', label),
            (err: unknown) => err instanceof Error && err.message.startsWith(`${label} APIキーに ISO-8859-1 範囲外の文字が含まれています。`),
        );
    }
});
