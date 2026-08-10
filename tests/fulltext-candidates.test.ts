import test from 'node:test';
import assert from 'node:assert/strict';
import { isFulltextCandidateRef } from '../src/lib/fulltext-candidates';
import { isInFulltextPool } from '../src/lib/fulltext-pool';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';
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
        client_version: '0.20.3-human',
        screening_phase: 'tiab',
        ...overrides,
    };
}

const NONE_ASSIGNMENT: FulltextAssignmentConfig = { status: 'none', groupCount: 2, reviewerMap: {} };
const CONFIGURED_ASSIGNMENT: FulltextAssignmentConfig = {
    status: 'configured',
    groupCount: 2,
    reviewerMap: {
        'ft-group-1': ['admin@example.com'],
        'ft-group-2': ['member@example.com'],
    },
};

// ---------------------------------------------------------------------------
// 割り振り済み（status === 'configured'）
// ---------------------------------------------------------------------------

test('割り振り済み: fulltext_set が非空なら decisions が空でも候補（Blind中の全員一致を再現）', () => {
    const result = isFulltextCandidateRef({
        ref: { fulltext_set: 'ft-group-1' },
        decisions: [],
        poolRule: {
            version: 1,
            voters: ['human:admin@example.com'],
            threshold: 1,
        },
        assignment: CONFIGURED_ASSIGNMENT,
        userEmail: 'member@example.com',
        isAdmin: false,
    });
    assert.equal(result, true);
});

test('割り振り済み: fulltext_set 空 + プールルール成立 → 候補（未割り当て流入）', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:member@example.com'],
        threshold: 1,
    };
    const decisions = [makeDecision({ reviewer_id: 'member@example.com', decision: 'include' })];

    const result = isFulltextCandidateRef({
        ref: { fulltext_set: '' },
        decisions,
        poolRule: rule,
        assignment: CONFIGURED_ASSIGNMENT,
        userEmail: 'member@example.com',
        isAdmin: false,
    });
    assert.equal(result, true);
});

test('割り振り済み: fulltext_set 空 + 票不足 → 非候補', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:member@example.com'],
        threshold: 2,
    };
    const decisions = [makeDecision({ reviewer_id: 'member@example.com', decision: 'include' })];

    const result = isFulltextCandidateRef({
        ref: { fulltext_set: '' },
        decisions,
        poolRule: rule,
        assignment: CONFIGURED_ASSIGNMENT,
        userEmail: 'member@example.com',
        isAdmin: false,
    });
    assert.equal(result, false);
});

test('割り振り済み: fulltext_set が空白のみなら空扱いになる', () => {
    const result = isFulltextCandidateRef({
        ref: { fulltext_set: '   ' },
        decisions: [],
        poolRule: null,
        assignment: CONFIGURED_ASSIGNMENT,
        userEmail: 'member@example.com',
        isAdmin: false,
    });
    assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// 未設定（status === 'none'）
// ---------------------------------------------------------------------------

test('未設定 + poolRule あり: isInFulltextPool と同じ結果', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com', 'human:bob@example.com'],
        threshold: 2,
    };
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
    ];

    const expected = isInFulltextPool(decisions, rule);
    const result = isFulltextCandidateRef({
        ref: { fulltext_set: '' },
        decisions,
        poolRule: rule,
        assignment: NONE_ASSIGNMENT,
        userEmail: 'alice@example.com',
        isAdmin: false,
    });
    assert.equal(result, expected);
    assert.equal(result, true);

    // 閾値未達のケースでも一致することを確認
    const shortDecisions = [makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' })];
    const expectedShort = isInFulltextPool(shortDecisions, rule);
    const resultShort = isFulltextCandidateRef({
        ref: { fulltext_set: '' },
        decisions: shortDecisions,
        poolRule: rule,
        assignment: NONE_ASSIGNMENT,
        userEmail: 'alice@example.com',
        isAdmin: false,
    });
    assert.equal(resultShort, expectedShort);
    assert.equal(resultShort, false);
});

test('未設定 + poolRule なし: 非管理者は自分のIncludeのみ候補', () => {
    const myInclude = makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' });
    const otherInclude = makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' });

    assert.equal(
        isFulltextCandidateRef({
            ref: { fulltext_set: '' },
            decisions: [myInclude],
            poolRule: null,
            assignment: NONE_ASSIGNMENT,
            userEmail: 'alice@example.com',
            isAdmin: false,
        }),
        true
    );

    assert.equal(
        isFulltextCandidateRef({
            ref: { fulltext_set: '' },
            decisions: [otherInclude],
            poolRule: null,
            assignment: NONE_ASSIGNMENT,
            userEmail: 'alice@example.com',
            isAdmin: false,
        }),
        false
    );
});

test('未設定 + poolRule なし: 管理者は他人のIncludeも候補にする', () => {
    const otherInclude = makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' });

    assert.equal(
        isFulltextCandidateRef({
            ref: { fulltext_set: '' },
            decisions: [otherInclude],
            poolRule: null,
            assignment: NONE_ASSIGNMENT,
            userEmail: 'alice@example.com',
            isAdmin: true,
        }),
        true
    );
});

test('未設定 + poolRule なし: screening_phase 省略時は tiab 扱い（後方互換）', () => {
    const legacyInclude = makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', screening_phase: undefined });
    const fulltextInclude = makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', screening_phase: 'fulltext' });

    assert.equal(
        isFulltextCandidateRef({
            ref: { fulltext_set: '' },
            decisions: [legacyInclude],
            poolRule: null,
            assignment: NONE_ASSIGNMENT,
            userEmail: 'alice@example.com',
            isAdmin: false,
        }),
        true,
        'screening_phase省略はtiab扱いなので候補になる'
    );

    assert.equal(
        isFulltextCandidateRef({
            ref: { fulltext_set: '' },
            decisions: [fulltextInclude],
            poolRule: null,
            assignment: NONE_ASSIGNMENT,
            userEmail: 'alice@example.com',
            isAdmin: false,
        }),
        false,
        'fulltextフェーズの判定はTiAb候補判定の対象外'
    );
});

// ---------------------------------------------------------------------------
// 実プロジェクト再現（rule_unevaluable_blind 事故ケースの解消確認）
// ---------------------------------------------------------------------------

test('実プロジェクト再現: 割り振り済み + voters=[human:admin] + decisions空（Blind） → fulltext_setがある文献は候補になる', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:admin@example.com'],
        threshold: 1,
    };

    // Blind中は他レビュアー（admin）の票がクライアントにロードされないため decisions は空。
    // 割り振り生成時に確定していた fulltext_set だけを頼りに候補判定できることを確認する。
    const results = Array.from({ length: 104 }, (_, i) =>
        isFulltextCandidateRef({
            ref: { fulltext_set: `ft-group-${(i % 2) + 1}` },
            decisions: [],
            poolRule: rule,
            assignment: CONFIGURED_ASSIGNMENT,
            userEmail: 'member@example.com',
            isAdmin: false,
        })
    );

    assert.equal(results.filter(Boolean).length, 104, 'fulltext_setが割り当てられた104件全てが候補になる');
});
