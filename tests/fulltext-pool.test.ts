import test from 'node:test';
import assert from 'node:assert/strict';
import {
    voterKeyOf,
    countIncludeVotes,
    isInFulltextPool,
    isProjectFulltextCandidate,
    discoverVoters,
    parseFulltextPoolRule,
    type FulltextPoolRule,
} from '../src/lib/fulltext-pool';
import type { Decision } from '../src/lib/types';

let seq = 0;
function makeDecision(overrides: Partial<Decision>): Decision {
    seq++;
    return {
        decision_id: `d${seq}`,
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
        client_version: '0.1.0',
        ...overrides,
    };
}

test('voterKeyOf: 人間判定は human: プレフィックス', () => {
    assert.equal(voterKeyOf(makeDecision({ client_version: '0.1.0' })), 'human:alice@example.com');
    assert.equal(voterKeyOf(makeDecision({ client_version: '0.20.0-human' })), 'human:alice@example.com');
});

test('voterKeyOf: ML判定は ml: プレフィックス（確定・自動とも）', () => {
    assert.equal(voterKeyOf(makeDecision({ client_version: '0.7.0-ml' })), 'ml:alice@example.com');
    assert.equal(voterKeyOf(makeDecision({ client_version: '0.20.0-ml-auto' })), 'ml:alice@example.com');
});

test('voterKeyOf: LLM判定は reviewer_id そのまま', () => {
    const d = makeDecision({ reviewer_id: 'llm:gemini-2.5-flash@2026-01-01T00:00:00Z' });
    assert.equal(voterKeyOf(d), 'llm:gemini-2.5-flash@2026-01-01T00:00:00Z');
});

test('voterKeyOf: client_version 不明の旧データは人間扱い', () => {
    assert.equal(voterKeyOf(makeDecision({ client_version: undefined })), 'human:alice@example.com');
});

test('countIncludeVotes: 採用voterのInclude票のみ数える', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com', 'human:bob@example.com'],
        threshold: 2,
    };
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
        // 未採用のLLM票は無視される
        makeDecision({ reviewer_id: 'llm:m@t', decision: 'include' }),
    ];
    assert.equal(countIncludeVotes(decisions, rule), 2);
    assert.equal(isInFulltextPool(decisions, rule), true);
});

test('countIncludeVotes: 同一人物の手動+MLは1票に統合（最新優先）', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com', 'ml:alice@example.com'],
        threshold: 2,
    };
    // 手動include（古い）→ ML include（新しい）でも同一人物なので1票
    const decisions = [
        makeDecision({ client_version: '0.1.0', decision: 'include' }),
        makeDecision({ client_version: '0.7.0-ml', decision: 'include' }),
    ];
    assert.equal(countIncludeVotes(decisions, rule), 1);
    assert.equal(isInFulltextPool(decisions, rule), false);
});

test('countIncludeVotes: include→exclude に変えた人は票なし', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const decisions = [
        makeDecision({ decision: 'include' }),
        makeDecision({ decision: 'exclude' }), // decided_at がより新しい
    ];
    assert.equal(countIncludeVotes(decisions, rule), 0);
});

test('countIncludeVotes: fulltextフェーズの判定は無視される', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const decisions = [
        makeDecision({ decision: 'include', screening_phase: 'fulltext' }),
    ];
    assert.equal(countIncludeVotes(decisions, rule), 0);
});

test('countIncludeVotes: screening_phase 省略は tiab 扱い（後方互換）', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const d = makeDecision({ decision: 'include' });
    delete d.screening_phase;
    assert.equal(countIncludeVotes([d], rule), 1);
});

test('discoverVoters: human→ml→llm の順で発見しInclude件数を数える', () => {
    const decisions = [
        makeDecision({ ref_id: 'r1', reviewer_id: 'llm:m@t', decision: 'include' }),
        makeDecision({ ref_id: 'r1', reviewer_id: 'bob@example.com', client_version: '0.7.0-ml', decision: 'include' }),
        makeDecision({ ref_id: 'r1', reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ ref_id: 'r2', reviewer_id: 'alice@example.com', decision: 'exclude' }),
    ];
    const voters = discoverVoters(decisions);
    assert.deepEqual(voters.map(v => v.key), ['human:alice@example.com', 'ml:bob@example.com', 'llm:m@t']);
    assert.equal(voters[0].includeCount, 1); // r2 は exclude なのでカウントしない
    assert.equal(voters[0].label, 'alice@example.com');
    assert.equal(voters[1].label, 'bob@example.com (ML)');
    assert.equal(voters[2].label, 'LLM: m@t');
});

test('discoverVoters: 同一voter同一文献の判定は最新だけ数える', () => {
    const decisions = [
        makeDecision({ ref_id: 'r1', decision: 'exclude' }),
        makeDecision({ ref_id: 'r1', decision: 'include' }), // 最新
    ];
    const voters = discoverVoters(decisions);
    assert.equal(voters[0].includeCount, 1);
});

test('isProjectFulltextCandidate: ルールありは isInFulltextPool に委譲する', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const included = [makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' })];
    const excluded = [makeDecision({ reviewer_id: 'alice@example.com', decision: 'exclude' })];
    assert.equal(isProjectFulltextCandidate(included, rule), isInFulltextPool(included, rule));
    assert.equal(isProjectFulltextCandidate(excluded, rule), isInFulltextPool(excluded, rule));
    assert.equal(isProjectFulltextCandidate(included, rule), true);
    assert.equal(isProjectFulltextCandidate(excluded, rule), false);
});

test('isProjectFulltextCandidate: ルールなしは自分以外のTiAb Includeでも候補になる（ユーザーに依存しない）', () => {
    const decisions = [makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' })];
    assert.equal(isProjectFulltextCandidate(decisions, null), true);
});

test('isProjectFulltextCandidate: ルールなしでTiAb Includeが誰にも無ければfalse', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'exclude' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'pending' }),
    ];
    assert.equal(isProjectFulltextCandidate(decisions, null), false);
});

test('isProjectFulltextCandidate: ルールなしでフルテキスト相のIncludeはTiAb Includeとして数えない', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', screening_phase: 'fulltext' }),
    ];
    assert.equal(isProjectFulltextCandidate(decisions, null), false);
});

test('parseFulltextPoolRule: 妥当なJSONをパース、不正値はnull', () => {
    assert.deepEqual(
        parseFulltextPoolRule('{"version":1,"voters":["human:a@b.com"],"threshold":1}'),
        { version: 1, voters: ['human:a@b.com'], threshold: 1 }
    );
    assert.equal(parseFulltextPoolRule('not json'), null);
    assert.equal(parseFulltextPoolRule('{"voters":"x","threshold":1}'), null);
    assert.equal(parseFulltextPoolRule('{"voters":[],"threshold":0}'), null);
});
