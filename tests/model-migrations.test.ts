import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLlmConfig } from '../src/lib/sheets/config-schema';

test('保存済みの TypeSafe 直 API の旧固定版を後継版へ移行する', () => {
    assert.equal(parseLlmConfig([['llm_model', 'jev-1.13.0']]).llm_model, 'jev-1.14.0');
});

test('保存済みの OpenRouter 経由の TypeSafe 旧固定版を後継版へ移行する', () => {
    assert.equal(parseLlmConfig([['llm_model', 'typesafe/jev-1.13']]).llm_model, 'typesafe/jev-1.14');
});

test('移行表にない保存済みモデル ID はそのまま維持する', () => {
    assert.equal(parseLlmConfig([['llm_model', 'gemini-3.1-flash-lite']]).llm_model, 'gemini-3.1-flash-lite');
});
