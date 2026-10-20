import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLlmValidation, judgeValidation } from '../src/lib/llm-validation';
import { collectReviewerKeys } from '../src/lib/decision-summary';
import { parseLlmConfig } from '../src/lib/sheets/config-schema';
import type { AssignmentConfig, Decision, ReferenceWithStatus } from '../src/lib/types';

function vote(ref: string, reviewer: string, decision: Decision['decision'], extra: Partial<Decision> = {}): Decision {
    return {
        decision_id: `${ref}-${reviewer}`, ref_id: ref, reviewer_id: reviewer, decision,
        decided_at: '2026-10-20T00:00:00Z', client_version: '1-human', ...extra,
    };
}

function ai(ref: string, probability: number, extra: Partial<Decision> = {}): Decision {
    return vote(ref, 'llm:model@run', 'pending', {
        client_version: '1-llm', note: JSON.stringify({ type: 'llm', include_probability: probability }), ...extra,
    });
}

function reference(id: string, decisions: Decision[]): ReferenceWithStatus {
    return { ref_id: id, title: id, abstract: '', status: 'pending', allDecisions: decisions };
}

function compute(refs: ReferenceWithStatus[], decisions: Decision[], assignmentConfig?: AssignmentConfig, treatMlAsManual = true) {
    return computeLlmValidation({
        refs, aiDecisions: decisions, threshold: 0.3,
        reviewerKeys: collectReviewerKeys(refs, new Set(), treatMlAsManual), treatMlAsManual, assignmentConfig,
    });
}

test('一致した人の組み入れ・除外と AI の誤りから各指標を求める', () => {
    const refs = ['i1', 'i2', 'e1', 'e2'].map(id => reference(id, [
        vote(id, 'a', id.startsWith('i') ? 'include' : 'exclude'),
        vote(id, 'b', id.startsWith('i') ? 'include' : 'exclude'),
    ]));
    const result = compute(refs, [ai('i1', 0.2), ai('i2', 0.3), ai('e1', 0.1), ai('e2', 0.9)]);
    assert.deepEqual(result, {
        compared: 4, humanIncludes: 2, humanExcludes: 2, missed: 1, falseIncludes: 1,
        unresolved: { conflict: 0, maybe: 0, incomplete: 0, pending: 0 },
        missRate: 0.5, specificity: 0.5, agreement: 0.5,
    });
    assert.equal(judgeValidation(result, 0.5), 'pass');
    assert.equal(judgeValidation(result, 0.49), 'fail');
});

test('不一致・保留・担当者の一部だけ判定・人の判定なしを内訳に分ける', () => {
    const refs = [
        reference('conflict', [vote('conflict', 'a', 'include'), vote('conflict', 'b', 'exclude')]),
        reference('maybe', [vote('maybe', 'a', 'maybe'), vote('maybe', 'b', 'maybe')]),
        reference('incomplete', [vote('incomplete', 'a', 'include')]),
        reference('pending', []),
        reference('no-ai', [vote('no-ai', 'a', 'include'), vote('no-ai', 'b', 'include')]),
    ].map(ref => ({ ...ref, screening_set: 'group-1' }));
    const config: AssignmentConfig = {
        status: 'configured', calibrationSize: 10, groupCount: 1, reviewerMap: { 'group-1': ['a', 'b'] },
    };
    const result = compute(refs, refs.filter(ref => ref.ref_id !== 'no-ai').map(ref => ai(ref.ref_id, 0.5)), config);
    assert.equal(result.compared, 0);
    assert.deepEqual(result.unresolved, { conflict: 1, maybe: 1, incomplete: 1, pending: 1 });
    assert.equal(result.missRate, null);
    assert.equal(result.specificity, null);
    assert.equal(result.agreement, null);
    assert.equal(judgeValidation(result, 0.05), 'insufficient');
});

test('AI 票・ML 自動除外・全文相の票は正解にしない', () => {
    const refs = [
        reference('ml', [vote('ml', 'a', 'exclude', { client_version: '1-ml-auto' })]),
        reference('ai', [ai('ai', 1)]),
        reference('fulltext', [vote('fulltext', 'a', 'include', { screening_phase: 'fulltext' })]),
    ];
    const result = compute(refs, refs.map(ref => ai(ref.ref_id, 0.1)));
    assert.equal(result.compared, 0);
    assert.equal(result.unresolved.pending, 3);
});

test('確認済み ML は設定に従って人の票として扱い、AI の票は合議に混ぜない', () => {
    for (const treatMlAsManual of [true, false]) {
        const refs = [reference('a', [vote('a', 'a', 'include', { client_version: '1-ml' }), ai('a', 0)])];
        const result = compute(refs, [ai('a', 0.3)], undefined, treatMlAsManual);
        assert.equal(result.humanIncludes, 1);
        assert.equal(result.missed, 0);
        assert.equal(result.agreement, 1);
        assert.equal(result.specificity, null);
    }
});

test('同じ文献の最新 AI 票を使い、閾値ちょうどは組み入れとする', () => {
    const refs = [reference('a', [vote('a', 'a', 'include')])];
    const result = compute(refs, [
        ai('a', 0.3, { decided_at: '2026-10-20T01:00:00Z' }), ai('a', 0.1),
        ai('a', 0, { screening_phase: 'fulltext', decided_at: '2026-10-20T02:00:00Z' }),
    ]);
    assert.equal(result.compared, 1);
    assert.equal(result.missed, 0);
});

test('人の組み入れがゼロなら合否は判定不能で、特異度は算出できる', () => {
    const result = compute([reference('e', [vote('e', 'a', 'exclude')])], [ai('e', 0.1)]);
    assert.equal(result.humanIncludes, 0);
    assert.equal(result.missRate, null);
    assert.equal(result.specificity, 1);
    assert.equal(judgeValidation(result, 0.05), 'insufficient');
});

test('確率を読めない AI 票は比較せず、最新の人の判定を使う', () => {
    const refs = [reference('a', [vote('a', 'a', 'exclude'), vote('a', 'a', 'include', { decided_at: '2026-10-21T00:00:00Z' })])];
    assert.equal(compute(refs, [ai('a', 1, { note: 'invalid' })]).compared, 0);
    assert.equal(compute(refs, [ai('a', 1)]).humanIncludes, 1);
});

test('合格基準は既定5%で、0と1を保持し、範囲外は受け付けない', () => {
    assert.equal(parseLlmConfig([]).llm_validation_max_miss_rate, 0.05);
    for (const value of ['0', '1', '0.12']) {
        assert.equal(parseLlmConfig([['llm_validation_max_miss_rate', value]]).llm_validation_max_miss_rate, Number(value));
    }
    for (const value of ['-1', '2', 'NaN', 'Infinity']) {
        assert.equal(parseLlmConfig([['llm_validation_max_miss_rate', value]]).llm_validation_max_miss_rate, 0.05);
    }
    const date = '2026-10-20T00:00:00Z';
    assert.equal(parseLlmConfig([['llm_validation_criterion_set_at', date]]).llm_validation_criterion_set_at, date);
});
