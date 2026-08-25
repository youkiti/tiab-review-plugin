import test from 'node:test';
import assert from 'node:assert/strict';
import { isDecisionVisibleDuringBlind } from '../src/lib/blind-visibility';
import type { Decision } from '../src/lib/types';

const ME = 'me@example.com';

function makeDecision(overrides: Partial<Decision>): Decision {
    return {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.40.0-human',
        screening_phase: 'fulltext',
        ...overrides,
    };
}

test('自分自身の判定は true', () => {
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: ME }), ME), true);
});

test('前後に空白があっても自分の判定として一致する', () => {
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: `  ${ME}  ` }), ME), true);
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: ME }), `  ${ME}  `), true);
});

test('llm: プレフィックスのAI判定は true', () => {
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: 'llm:gemini@2026' }), ME), true);
});

test('他レビュアーの判定は false', () => {
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: 'bob@example.com' }), ME), false);
});

test('裁定票（adjudication:）は自分以外なら false', () => {
    assert.equal(isDecisionVisibleDuringBlind(makeDecision({ reviewer_id: 'adjudication:boss@example.com' }), ME), false);
});
