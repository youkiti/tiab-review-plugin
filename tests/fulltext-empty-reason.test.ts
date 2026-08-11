import test from 'node:test';
import assert from 'node:assert/strict';
import { explainEmptyFulltextCandidates } from '../src/lib/fulltext-empty-reason';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';

const RULE_OTHER_ADMIN: FulltextPoolRule = {
    version: 1,
    voters: ['human:admin@example.com'],
    threshold: 1,
};

const RULE_SELF_ONLY: FulltextPoolRule = {
    version: 1,
    voters: ['human:member@example.com'],
    threshold: 1,
};

const RULE_ML_LLM_ONLY: FulltextPoolRule = {
    version: 1,
    voters: ['ml:member@example.com', 'llm:gemini-2.0@2026-01-01T00:00:00Z'],
    threshold: 1,
};

test('実事故ケース: voters=[human:admin] かつ keyOpened=false → rule_unevaluable_blind', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_OTHER_ADMIN,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 104,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'rule_unevaluable_blind');
});

test('自分だけがvoterならBlindでも rule_unevaluable_blind にならない（assignedSetCount>0 → assignment_mismatch）', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_SELF_ONLY,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 10,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'assignment_mismatch');
});

test('自分だけがvoterならBlindでも rule_unevaluable_blind にならない（assignedSetCount=0 → no_candidates）', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_SELF_ONLY,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 0,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'no_candidates');
});

test('voters が llm:/ml: のみなら rule_unevaluable_blind にならない', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_ML_LLM_ONLY,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 0,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'no_candidates');
});

test('filtered_out が優先される（before>0, visible=0）', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_OTHER_ADMIN,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 104,
        candidateCountBeforeSetFilter: 5,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'filtered_out');
});

test('visible > 0 → null（空でない）', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_OTHER_ADMIN,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 104,
        candidateCountBeforeSetFilter: 5,
        visibleCandidateCount: 3,
    });
    assert.equal(reason, null);
});

test('userEmail の大文字小文字・空白は正規化して比較する', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_SELF_ONLY,
        keyOpened: false,
        userEmail: '  Member@Example.com  ',
        assignedSetCount: 0,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    // 自分自身のvoterとして認識されるため rule_unevaluable_blind にはならない
    assert.equal(reason, 'no_candidates');
});

test('keyOpened=true なら人間voterがいても rule_unevaluable_blind にならない', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: RULE_OTHER_ADMIN,
        keyOpened: true,
        userEmail: 'member@example.com',
        assignedSetCount: 0,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'no_candidates');
});

test('poolRule が null なら rule_unevaluable_blind にならない', () => {
    const reason = explainEmptyFulltextCandidates({
        poolRule: null,
        keyOpened: false,
        userEmail: 'member@example.com',
        assignedSetCount: 0,
        candidateCountBeforeSetFilter: 0,
        visibleCandidateCount: 0,
    });
    assert.equal(reason, 'no_candidates');
});
