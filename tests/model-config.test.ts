import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS, findModelConfig, getModelConfig, UnknownModelError } from '../src/lib/gemini-api';

test('既知のモデルIDは登録済みの設定を返す', () => {
    for (const option of AVAILABLE_MODELS) {
        const expected = { model: option.id, ...option.config };
        assert.deepEqual(findModelConfig(option.id), expected);
        assert.deepEqual(getModelConfig(option.id), expected);
    }
});

test('未登録でもスラッシュを含むモデルIDは温度0の設定を返す', () => {
    const modelId = 'custom-provider/custom-model';
    assert.equal(AVAILABLE_MODELS.some(option => option.id === modelId), false);
    const expected = { model: modelId, temperature: 0 };
    assert.deepEqual(findModelConfig(modelId), expected);
    assert.deepEqual(getModelConfig(modelId), expected);
});

test('未知のモデルIDはnullまたはモデルIDを保持する専用エラーになる', () => {
    for (const modelId of ['unknown-model', '']) {
        assert.equal(findModelConfig(modelId), null);
        assert.throws(() => getModelConfig(modelId), (error: unknown) => {
            assert.ok(error instanceof UnknownModelError);
            assert.equal(error.name, 'UnknownModelError');
            assert.equal(error.modelId, modelId);
            assert.ok(error.message.includes(modelId));
            return true;
        });
    }
});
