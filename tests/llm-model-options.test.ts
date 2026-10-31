import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS, type ModelOption } from '../src/lib/gemini-api';
import { buildModelGroups, filterModelGroupsByProvider, pickProviderModel, type ModelGroup } from '../src/lib/llm-model-options';

const custom: ModelOption = {
    id: 'vendor/custom',
    name: '登録モデル',
    provider: 'openrouter',
    custom: true,
    config: { temperature: 0 },
};

test('選択プロバイダだけを残し、元のグループを変更しない', () => {
    const groups = buildModelGroups(AVAILABLE_MODELS, [custom], []);
    const original = structuredClone(groups);
    for (const provider of ['gemini', 'openrouter', 'openai', 'anthropic', 'typesafe'] as const) {
        const filtered = filterModelGroupsByProvider(groups, provider);
        assert.ok(filtered.length > 0);
        assert.deepEqual(filtered.flatMap(group => group.models), groups.flatMap(group => group.models).filter(model => model.provider === provider));
        assert.ok(filtered.every(group => group.models.length > 0));
    }
    assert.deepEqual(groups, original);
});

test('OpenRouter の同梱・登録・取得モデルをグループごと残す', () => {
    const groups = buildModelGroups(AVAILABLE_MODELS, [custom], [{ id: 'vendor/fetched', name: '取得モデル' }]);
    const filtered = filterModelGroupsByProvider(groups, 'openrouter');
    assert.equal(filtered.length, 2);
    assert.ok(filtered[0].models.some(model => model.id === custom.id));
    assert.equal(filtered[1].labelKey, 'llm_fetchedModels');
    assert.deepEqual(filtered[1].models.map(model => model.id), ['vendor/fetched']);
    assert.equal(filterModelGroupsByProvider(groups, 'gemini').some(group => group.labelKey === 'llm_fetchedModels'), false);
});

test('混在グループでもモデル単位で絞り込み、空グループを除く', () => {
    const groups: ModelGroup[] = [{ label: '混在', models: [AVAILABLE_MODELS[0], custom] }];
    assert.deepEqual(filterModelGroupsByProvider(groups, 'openrouter'), [{ label: '混在', models: [custom] }]);
    assert.deepEqual(filterModelGroupsByProvider(groups, 'anthropic'), []);
    assert.deepEqual(filterModelGroupsByProvider([], 'openrouter'), []);
});

test('切替先の直近モデル、先頭モデル、空欄の順に選択する', () => {
    const groups = filterModelGroupsByProvider(buildModelGroups(AVAILABLE_MODELS, [custom], []), 'openrouter');
    assert.equal(pickProviderModel(groups, custom.id), custom.id);
    assert.equal(pickProviderModel(groups), groups[0].models[0].id);
    assert.equal(pickProviderModel(groups, ''), groups[0].models[0].id);
    assert.equal(pickProviderModel([]), '');
    assert.equal(pickProviderModel([], custom.id), '');
    assert.equal(pickProviderModel(groups, 'vendor/deleted'), groups[0].models[0].id);
});
