import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABLE_MODELS, TIER_PROBE_MODEL } from '../src/lib/gemini-api';
import { MODEL_ID_MIGRATIONS } from '../src/lib/model-migrations';
import { CONSULT_MODELS } from '../src/lib/help-consult/model';
import { listModelsToCheck } from '../scripts/model-check/inventory';

test('生存確認の一覧は ID が重複しない', () => {
    const ids = listModelsToCheck().map(model => model.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('AVAILABLE_MODELS（local_llm を除く）・移行先・相談用・階層判定用のモデルをすべて含む', () => {
    const ids = new Set(listModelsToCheck().map(model => model.id));
    for (const model of AVAILABLE_MODELS.filter(m => m.provider !== 'local_llm')) {
        assert.ok(ids.has(model.id), `AVAILABLE_MODELS の ${model.id} がありません`);
    }
    for (const target of Object.values(MODEL_ID_MIGRATIONS)) assert.ok(ids.has(target), `移行先 ${target} がありません`);
    for (const id of Object.values(CONSULT_MODELS)) assert.ok(ids.has(id), `CONSULT_MODELS の ${id} がありません`);
    assert.ok(ids.has(TIER_PROBE_MODEL));
});

test('MODEL_ID_MIGRATIONS のキー（旧 ID）は含まない', () => {
    const ids = new Set(listModelsToCheck().map(model => model.id));
    for (const legacy of Object.keys(MODEL_ID_MIGRATIONS)) {
        // 旧 ID が別の経路で現役の ID でもある場合（TIER_PROBE_MODEL など）は対象に残る
        const stillUsed = AVAILABLE_MODELS.some(model => model.id === legacy)
            || legacy === TIER_PROBE_MODEL
            || Object.values(CONSULT_MODELS).some(id => id === legacy);
        if (!stillUsed) assert.ok(!ids.has(legacy), `旧 ID ${legacy} が含まれています`);
    }
});

test('provider は AVAILABLE_MODELS の値と一致し、TIER_PROBE_MODEL は gemini', () => {
    const providerById = new Map(AVAILABLE_MODELS.map(model => [model.id, model.provider]));
    for (const entry of listModelsToCheck()) {
        if (entry.id === TIER_PROBE_MODEL && !providerById.has(entry.id)) {
            assert.equal(entry.provider, 'gemini');
        } else {
            assert.equal(entry.provider, providerById.get(entry.id), entry.id);
        }
    }
});

test('usedBy に出どころが入る', () => {
    const byId = new Map(listModelsToCheck().map(entry => [entry.id, entry]));
    assert.ok(byId.get(TIER_PROBE_MODEL)?.usedBy.includes('TIER_PROBE_MODEL'));
    assert.ok(byId.get(CONSULT_MODELS.openai)?.usedBy.includes('CONSULT_MODELS.openai'));
    assert.ok(byId.get(Object.values(MODEL_ID_MIGRATIONS)[0])?.usedBy.includes('MODEL_ID_MIGRATIONS の移行先'));
});
