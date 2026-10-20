import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThresholdConfirmationUpdates, computeReviewValidation, validationUnavailableMessageKey } from '../src/sidepanel/features/llm/validation-model';
import type { LlmConfig } from '../src/lib/types';
import { parseLlmConfig } from '../src/lib/sheets/config-schema';

const config: LlmConfig = parseLlmConfig([
    ['llm_validation_max_miss_rate', '0.02'],
    ['llm_validation_criterion_set_at', '2026-10-19T00:00:00Z'],
]);

function validation(isKeyOpened: boolean) {
    return computeReviewValidation({
        isKeyOpened,
        refs: [],
        aiDecisions: [],
        threshold: 0.3,
        treatMlAsManual: true,
        assignmentConfig: null,
    });
}

test('キー未開封は比較不能となり、確定時に検証の7列を渡さない', () => {
    const result = validation(false);
    assert.equal(result, null);
    assert.equal(validationUnavailableMessageKey(result), 'llm_validationKeyUnopened');
    const updates = buildThresholdConfirmationUpdates(0.3, result, config, '2026-10-20T00:00:00Z');
    assert.deepEqual(updates, { include_threshold: 0.3, status: 'confirmed', is_active: true });
    assert.equal(Object.keys(updates).some(key => key.startsWith('validation_')), false);
});

test('キー未開封では文献と判定を集計しない', () => {
    const params = {
        isKeyOpened: false,
        get refs(): never {
            throw new Error('キー未開封で文献を集計している');
        },
        aiDecisions: [],
        threshold: 0.3,
        treatMlAsManual: true,
        assignmentConfig: null,
    };
    assert.equal(computeReviewValidation(params), null);
});

test('開封済みの比較ゼロは比較不能と区別し、検証の7列を保存する', () => {
    const result = validation(true);
    assert.ok(result);
    assert.equal(result.compared, 0);
    assert.equal(validationUnavailableMessageKey(result), null);
    const updates = buildThresholdConfirmationUpdates(0.4, result, config, '2026-10-20T00:00:00Z');
    assert.deepEqual(updates, {
        include_threshold: 0.4,
        status: 'confirmed',
        is_active: true,
        validation_compared: 0,
        validation_human_includes: 0,
        validation_missed: 0,
        validation_false_includes: 0,
        validation_max_miss_rate: 0.02,
        validation_criterion_set_at: '2026-10-19T00:00:00Z',
        validation_evaluated_at: '2026-10-20T00:00:00Z',
    });
});
