import test from 'node:test';
import assert from 'node:assert/strict';
import {
    filterModelsByConfiguredProviders,
    type LlmProviderId,
} from '../src/lib/llm-provider';

const models = [
    { id: 'gemini-3.1-flash-lite', provider: 'gemini' as LlmProviderId },
    { id: 'gemini-3-flash-preview', provider: 'gemini' as LlmProviderId },
    { id: 'qwen/qwen3-235b-a22b-2507', provider: 'openrouter' as LlmProviderId },
    { id: 'deepseek/deepseek-v4-flash', provider: 'openrouter' as LlmProviderId },
];

test('filterModelsByConfiguredProviders: Gemini鍵のみ設定済み → Geminiモデルのみ残る', () => {
    const result = filterModelsByConfiguredProviders(models, new Set<LlmProviderId>(['gemini']));
    assert.deepEqual(result.map(m => m.id), [
        'gemini-3.1-flash-lite',
        'gemini-3-flash-preview',
    ]);
});

test('filterModelsByConfiguredProviders: OpenRouter鍵のみ設定済み → OpenRouterモデルのみ残る', () => {
    const result = filterModelsByConfiguredProviders(models, new Set<LlmProviderId>(['openrouter']));
    assert.deepEqual(result.map(m => m.id), [
        'qwen/qwen3-235b-a22b-2507',
        'deepseek/deepseek-v4-flash',
    ]);
});

test('filterModelsByConfiguredProviders: 両方設定済み → 全モデルが残る', () => {
    const result = filterModelsByConfiguredProviders(
        models,
        new Set<LlmProviderId>(['gemini', 'openrouter'])
    );
    assert.equal(result.length, models.length);
});

test('filterModelsByConfiguredProviders: 両方未設定 → 空配列', () => {
    const result = filterModelsByConfiguredProviders(models, new Set<LlmProviderId>());
    assert.deepEqual(result, []);
});

test('filterModelsByConfiguredProviders: 元配列を変更しない（純関数）', () => {
    const snapshot = [...models];
    filterModelsByConfiguredProviders(models, new Set<LlmProviderId>(['gemini']));
    assert.deepEqual(models, snapshot);
});
