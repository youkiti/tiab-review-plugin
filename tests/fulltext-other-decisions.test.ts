import test from 'node:test';
import assert from 'node:assert/strict';
import {
    selectOtherFulltextDecisions,
    otherReviewerLabel,
} from '../src/lib/fulltext-other-decisions';
import { adjudicationReviewerId } from '../src/lib/fulltext-consensus';
import type { Decision } from '../src/lib/types';

const ME = 'me@example.com';

let seq = 0;
function makeDecision(overrides: Partial<Decision>): Decision {
    seq++;
    return {
        decision_id: `d${seq}`,
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
        client_version: '0.40.0-human',
        screening_phase: 'fulltext',
        ...overrides,
    };
}

test('Blind中（keyOpened=false）は他レビュアーの判定を一切返さない', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', note: '相手のメモ' }),
        makeDecision({ reviewer_id: ME }),
    ];
    assert.deepEqual(selectOtherFulltextDecisions(decisions, 'ref1', ME, false), []);
});

test('自分・AI票・他フェーズ・他文献を除いた他レビュアーの票だけ返す', () => {
    const decisions = [
        makeDecision({ reviewer_id: ME, note: '自分のメモ' }),
        makeDecision({ reviewer_id: 'llm:gemini@2026', note: '{"reason":"AI"}' }),
        makeDecision({ reviewer_id: 'bob@example.com', screening_phase: 'tiab' }),
        makeDecision({ reviewer_id: 'carol@example.com', ref_id: 'ref2' }),
        makeDecision({ reviewer_id: 'alice@example.com', note: '相手のメモ' }),
    ];

    const result = selectOtherFulltextDecisions(decisions, 'ref1', ME, true);
    assert.equal(result.length, 1);
    assert.equal(result[0].reviewer_id, 'alice@example.com');
    assert.equal(result[0].note, '相手のメモ');
});

test('同一レビュアーに複数行あるときは decided_at が最新の1件へ畳み込む', () => {
    const decisions = [
        makeDecision({
            reviewer_id: 'alice@example.com',
            decision: 'include',
            note: '古いメモ',
            decided_at: '2026-01-01T00:00:00Z',
        }),
        makeDecision({
            reviewer_id: 'alice@example.com',
            decision: 'exclude',
            reason: 'population',
            note: '新しいメモ',
            decided_at: '2026-02-01T00:00:00Z',
        }),
    ];

    const result = selectOtherFulltextDecisions(decisions, 'ref1', ME, true);
    assert.equal(result.length, 1);
    assert.equal(result[0].decision, 'exclude');
    assert.equal(result[0].note, '新しいメモ');
});

test('裁定票は含めたうえで通常の判定者の後ろに並べる', () => {
    const decisions = [
        makeDecision({ reviewer_id: adjudicationReviewerId('boss@example.com'), decision: 'exclude' }),
        makeDecision({ reviewer_id: 'zoe@example.com' }),
        makeDecision({ reviewer_id: 'alice@example.com' }),
    ];

    const keys = selectOtherFulltextDecisions(decisions, 'ref1', ME, true).map(d => d.reviewer_id);
    assert.deepEqual(keys, [
        'alice@example.com',
        'zoe@example.com',
        adjudicationReviewerId('boss@example.com'),
    ]);
});

test('otherReviewerLabel: 通常の判定者は完全なメールアドレス、裁定票は裁定者の完全なメールアドレスを出す', () => {
    assert.equal(otherReviewerLabel('alice@example.com', ME), 'alice@example.com');
    assert.equal(otherReviewerLabel(adjudicationReviewerId('boss@example.com'), ME), '⚖ 裁定（boss@example.com）');
    assert.equal(otherReviewerLabel(adjudicationReviewerId(ME), ME), '⚖ 裁定（自分）');
});

test('複数の裁定者の裁定票があるときは decided_at が最新の1件だけを返す', () => {
    const decisions = [
        makeDecision({
            reviewer_id: adjudicationReviewerId('old-boss@example.com'),
            decision: 'exclude',
            decided_at: '2026-01-01T00:00:00Z',
        }),
        makeDecision({
            reviewer_id: adjudicationReviewerId('new-boss@example.com'),
            decision: 'include',
            decided_at: '2026-02-01T00:00:00Z',
        }),
        makeDecision({ reviewer_id: 'alice@example.com' }),
    ];

    const result = selectOtherFulltextDecisions(decisions, 'ref1', ME, true);
    const adjudicationRows = result.filter(d => d.reviewer_id?.startsWith('adjudication:'));
    assert.equal(adjudicationRows.length, 1);
    assert.equal(adjudicationRows[0].reviewer_id, adjudicationReviewerId('new-boss@example.com'));
    assert.equal(adjudicationRows[0].decision, 'include');
    // 並び順: 通常の判定者 → 裁定票（1件のみ）
    assert.deepEqual(result.map(d => d.reviewer_id), [
        'alice@example.com',
        adjudicationReviewerId('new-boss@example.com'),
    ]);
});
