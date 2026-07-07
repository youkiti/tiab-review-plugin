import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeTeamProgress,
    shortNameOf,
    percentOf,
    type TeamProgressRef,
} from '../src/lib/team-progress';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';
import type { Decision, AssignmentConfig } from '../src/lib/types';

let seq = 0;
function makeDecision(overrides: Partial<Decision>): Decision {
    seq++;
    return {
        decision_id: `d${seq}`,
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
        client_version: '0.1.0',
        ...overrides,
    };
}

function makeRefs(count: number, setOf?: (i: number) => string): TeamProgressRef[] {
    return Array.from({ length: count }, (_, i) => ({
        ref_id: `ref${i + 1}`,
        screening_set: setOf ? setOf(i) : undefined,
    }));
}

const NO_ASSIGNMENT: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

test('割り振り未設定: 分母は全文献数、判定した文献数がカウントされる', () => {
    const refs = makeRefs(10);
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', decision: 'exclude' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'bob@example.com', decision: 'maybe' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    assert.equal(result.length, 2);
    // 自分が先頭
    assert.equal(result[0].email, 'alice@example.com');
    assert.equal(result[0].isSelf, true);
    assert.equal(result[0].tiabDone, 2);
    assert.equal(result[0].tiabTotal, 10);
    assert.equal(result[1].email, 'bob@example.com');
    assert.equal(result[1].tiabDone, 1);
    assert.equal(result[1].tiabTotal, 10);
});

test('LLM判定・ML自動判定・pending行は進捗にカウントしない', () => {
    const refs = makeRefs(5);
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'llm:gemini@2026-01-01' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', client_version: '0.20.0-ml-auto' }),
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com', decision: 'pending' }),
        // 確定ML判定はカウントする
        makeDecision({ ref_id: 'ref4', reviewer_id: 'alice@example.com', client_version: '0.7.0-ml' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    assert.equal(result.length, 1);
    assert.equal(result[0].tiabDone, 1);
});

test('割り振り設定済み: 分母は担当セット（calibration + 割当グループ）内の文献数', () => {
    // ref1-2: calibration, ref3-6: group-1, ref7-10: group-2
    const refs = makeRefs(10, (i) => (i < 2 ? 'calibration' : i < 6 ? 'group-1' : 'group-2'));
    const config: AssignmentConfig = {
        status: 'configured',
        calibrationSize: 2,
        groupCount: 2,
        reviewerMap: {
            'group-1': ['alice@example.com'],
            'group-2': ['bob@example.com'],
        },
    };
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com' }),  // calibration → 分子に入る
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com' }),  // group-1 → 分子に入る
        makeDecision({ ref_id: 'ref7', reviewer_id: 'alice@example.com' }),  // group-2 → 担当外なので分子に入らない
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: config,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(alice.tiabTotal, 6); // calibration 2 + group-1 4
    assert.equal(alice.tiabDone, 2);

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.tiabTotal, 6); // calibration 2 + group-2 4
    assert.equal(bob.tiabDone, 0);
});

test('メンバー発見: 判定がなくても reviewerMap に載っていれば表示される', () => {
    const config: AssignmentConfig = {
        status: 'configured',
        calibrationSize: 0,
        groupCount: 1,
        reviewerMap: { 'group-1': ['Alice@Example.com', 'carol@example.com'] },
    };
    const result = computeTeamProgress({
        refs: makeRefs(3, () => 'group-1'),
        decisions: [],
        assignmentConfig: config,
        poolRule: null,
        userEmail: 'alice@example.com',
    });

    // 大文字小文字は正規化され alice と重複しない
    assert.deepEqual(result.map((m) => m.email), ['alice@example.com', 'carol@example.com']);
    assert.equal(result[1].lastDecidedAt, null);
});

test('フルテキスト: ルール設定済みなら共通プールを分母にフェーズ別カウント', () => {
    const refs = makeRefs(5);
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const decisions = [
        // alice が ref1, ref2 を TiAb Include → プールは2件
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', decision: 'include' }),
        // フルテキスト判定: alice は ref1 のみ、bob は ref1, ref2
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', screening_phase: 'fulltext' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'bob@example.com', screening_phase: 'fulltext', decision: 'exclude' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'bob@example.com', screening_phase: 'fulltext', decision: 'exclude' }),
        // プール外のフルテキスト判定はカウントされない
        makeDecision({ ref_id: 'ref5', reviewer_id: 'bob@example.com', screening_phase: 'fulltext' }),
    ];
    const result = computeTeamProgress({
        refs,
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: rule,
        userEmail: 'alice@example.com',
    });

    const alice = result.find((m) => m.email === 'alice@example.com')!;
    assert.equal(alice.fulltextTotal, 2);
    assert.equal(alice.fulltextDone, 1);

    const bob = result.find((m) => m.email === 'bob@example.com')!;
    assert.equal(bob.fulltextTotal, 2);
    assert.equal(bob.fulltextDone, 2);
});

test('フルテキスト: ルール未設定なら fulltextDone/Total は null', () => {
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions: [makeDecision({ reviewer_id: 'alice@example.com' })],
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].fulltextDone, null);
    assert.equal(result[0].fulltextTotal, null);
});

test('lastDecidedAt: フェーズを問わず最新の判定日時を返す', () => {
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decided_at: '2026-01-01T00:00:00Z' }),
        makeDecision({ ref_id: 'ref2', reviewer_id: 'alice@example.com', screening_phase: 'fulltext', decided_at: '2026-02-01T00:00:00Z' }),
        // pending 行（メモのみ）は最終判定として扱わない
        makeDecision({ ref_id: 'ref3', reviewer_id: 'alice@example.com', decision: 'pending', decided_at: '2026-03-01T00:00:00Z' }),
    ];
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].lastDecidedAt, '2026-02-01T00:00:00Z');
});

test('同一文献への複数判定行は1件として数える', () => {
    const decisions = [
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'maybe' }),
        makeDecision({ ref_id: 'ref1', reviewer_id: 'alice@example.com', decision: 'include' }),
    ];
    const result = computeTeamProgress({
        refs: makeRefs(3),
        decisions,
        assignmentConfig: NO_ASSIGNMENT,
        poolRule: null,
        userEmail: 'alice@example.com',
    });
    assert.equal(result[0].tiabDone, 1);
});

test('shortNameOf / percentOf', () => {
    assert.equal(shortNameOf('alice@example.com'), 'alice');
    assert.equal(shortNameOf('very-long-local-part@example.com'), 'very-long-…');
    assert.equal(percentOf(1, 3), 33);
    assert.equal(percentOf(0, 0), 0);
});
