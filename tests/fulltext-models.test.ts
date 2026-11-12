// 全文モデルの対象と表示順を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS } from '../src/lib/gemini-api';
import { filterFulltextGeminiModels } from '../src/lib/gemini-decision-model';
import { filterFulltextModels, isFulltextTypeSafeModel } from '../src/lib/fulltext-models';

test('Gemini の後ろに直 API の固定版 Jev だけを加える', () => {
    const models = filterFulltextModels(AVAILABLE_MODELS);
    assert.deepEqual(models.slice(0, -1), filterFulltextGeminiModels(AVAILABLE_MODELS));
    assert.equal(models[models.length - 1]?.id, 'jev-1.14.0');
    assert.equal(models[models.length - 1]?.provider, 'typesafe');
    assert.equal(models.some(model => ['gemini-decision-1', 'typesafe/jev-1.14'].includes(model.id)), false);
    assert.equal(isFulltextTypeSafeModel('jev-1.14.0'), true);
    assert.equal(isFulltextTypeSafeModel('typesafe/jev-1.14'), false);
    assert.deepEqual(filterFulltextModels([{ id: 'jev-1.14.0', provider: 'openrouter' }]), []);
});
