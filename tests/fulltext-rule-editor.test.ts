import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWarnBlindRule } from '../src/lib/fulltext-rule-editor';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';

const RULE_HUMAN_ONLY: FulltextPoolRule = {
    version: 1,
    voters: ['human:admin@example.com'],
    threshold: 1,
};

const RULE_MIXED: FulltextPoolRule = {
    version: 1,
    voters: ['human:admin@example.com', 'ml:admin@example.com'],
    threshold: 1,
};

const RULE_ML_LLM_ONLY: FulltextPoolRule = {
    version: 1,
    voters: ['ml:admin@example.com', 'llm:gemini-2.0@2026-01-01T00:00:00Z'],
    threshold: 1,
};

const RULE_EMPTY: FulltextPoolRule = {
    version: 1,
    voters: [],
    threshold: 1,
};

test('human voterを含みBlind中（keyOpened=false）→ true', () => {
    assert.equal(shouldWarnBlindRule(RULE_HUMAN_ONLY, false), true);
});

test('human voterを含んでいてもキー開封済み（keyOpened=true）→ false', () => {
    assert.equal(shouldWarnBlindRule(RULE_HUMAN_ONLY, true), false);
});

test('human voterとml voterが混在していてもBlind中なら true', () => {
    assert.equal(shouldWarnBlindRule(RULE_MIXED, false), true);
});

test('llm・mlのみ（human無し）でBlind中でも → false', () => {
    assert.equal(shouldWarnBlindRule(RULE_ML_LLM_ONLY, false), false);
});

test('voters空 → false', () => {
    assert.equal(shouldWarnBlindRule(RULE_EMPTY, false), false);
});
