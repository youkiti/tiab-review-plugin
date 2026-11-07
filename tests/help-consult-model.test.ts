// キーの全組み合わせと現在モデルの優先順位を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseConsultProvider, CONSULT_MODELS } from '../src/lib/help-consult/model';
import { AVAILABLE_MODELS } from '../src/lib/gemini-api';
import type { LlmProviderId } from '../src/lib/llm-provider';

test('全てのキーの組み合わせで現在の社を優先し、未対応・未選択なら既定順にする', () => {
    const priority = ['gemini', 'openai', 'anthropic', 'openrouter'] as const;
    const unsupported = AVAILABLE_MODELS.find(model => model.provider === 'typesafe')!;
    const currents = [...Object.entries(CONSULT_MODELS), ['typesafe', unsupported.id], ['local_llm', 'local:model'], ['', '']];
    for (let mask = 0; mask < 1 << priority.length; mask++) {
        const enabled = priority.filter((_, index) => mask & (1 << index));
        const configured = new Set<LlmProviderId>([...enabled, 'typesafe', 'local_llm']);
        for (const [provider, model] of currents) {
            const expected = enabled.find(id => id === provider) ?? enabled[0] ?? null;
            assert.equal(chooseConsultProvider(configured, model), expected, `${mask}: ${provider}`);
        }
        assert.equal(chooseConsultProvider(configured), enabled[0] ?? null);
        assert.equal(chooseConsultProvider(configured, null), enabled[0] ?? null);
    }
    for (const [provider, model] of Object.entries(CONSULT_MODELS)) {
        assert.ok(AVAILABLE_MODELS.some(item => item.id === model && item.provider === provider));
    }
});
