import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManuscriptValidationSentence } from '../src/lib/manuscript-ai';
import type { LlmRun } from '../src/lib/types';

function run(extra: Partial<LlmRun> = {}): LlmRun {
    return {
        run_id: 'run', config_hash: 'hash', created_at: '2026-10-20T00:00:00Z', model: 'model',
        criteria_snapshot: null, screening_prompt: '', include_threshold: 0.3, status: 'confirmed', is_active: true,
        validation_compared: 100, validation_human_includes: 20, validation_missed: 1,
        validation_false_includes: 2, validation_max_miss_rate: 0.05,
        validation_criterion_set_at: '2026-10-19T00:00:00Z', validation_evaluated_at: '2026-10-21T00:00:00Z',
        ...extra,
    };
}

test('事前に設定した基準と確定時の検証結果を論文用の文にする', () => {
    const sentence = buildManuscriptValidationSentence(run());
    assert.match(sentence, /100 records \(20 included by the reviewers\)/);
    assert.match(sentence, /threshold of 0.3/);
    assert.match(sentence, /missed 1 of the 20 included records \(miss rate 5.0%\)/);
    assert.match(sentence, /acceptable miss rate of 5.0% that was specified before the run/);
    assert.doesNotMatch(sentence, /did not meet/);
});

test('事後の基準と事前記録なしを区別する', () => {
    assert.match(buildManuscriptValidationSentence(run({ validation_criterion_set_at: '2026-10-20T01:00:00Z' })), /specified after the run/);
    assert.match(buildManuscriptValidationSentence(run({ validation_criterion_set_at: undefined })), /not recorded in advance/);
    assert.match(buildManuscriptValidationSentence(run({ validation_criterion_set_at: 'invalid' })), /not recorded in advance/);
    assert.match(buildManuscriptValidationSentence(run({ validation_criterion_set_at: '2026-10-20T09:00:00+09:00' })), /specified before the run/);
});

test('基準を満たさない場合は明記し、事後の基準を事前とは呼ばない', () => {
    assert.match(buildManuscriptValidationSentence(run({ validation_missed: 2 })), /which did not meet the prespecified criterion/);
    const sentence = buildManuscriptValidationSentence(run({ validation_missed: 2, validation_criterion_set_at: '' }));
    assert.match(sentence, /which did not meet the specified criterion/);
    assert.doesNotMatch(sentence, /prespecified/);
});

test('比較ゼロは比較なしと記述し、検証記録の無い Run には何も書かない', () => {
    const noComparison = "The model's decisions were not compared with reviewers' decisions within this review.";
    assert.equal(buildManuscriptValidationSentence(run({ validation_compared: 0 })), noComparison);
    assert.equal(buildManuscriptValidationSentence(run({ validation_compared: undefined })), noComparison);
    // 機能の導入前に確定した Run は、比較したかどうかが分からないので断定しない
    assert.equal(buildManuscriptValidationSentence(run({ validation_evaluated_at: undefined })), '');
});

test('人の組み入れゼロでも比較件数があれば比較したことと見落とし率の評価不能を記述する', () => {
    for (const setAt of ['2026-10-19T00:00:00Z', '2026-10-22T00:00:00Z', undefined]) {
        const sentence = buildManuscriptValidationSentence(run({
            validation_compared: 12,
            validation_human_includes: 0,
            validation_criterion_set_at: setAt,
        }));
        assert.equal(sentence, "Before the large language model's decisions were used, they were compared with the reviewers' consensus decisions for 12 records, none of which were included by the reviewers, so the miss rate could not be assessed.");
    }
});
