import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFulltextSetAssignments,
    distributeUnassigned,
    canSeeFulltextRef,
    getFulltextSetsForUser,
    fulltextSetOf,
} from '../src/lib/fulltext-assignment';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';

const CONFIGURED: FulltextAssignmentConfig = {
    status: 'configured',
    groupCount: 2,
    reviewerMap: {
        'ft-group-1': ['alice@example.com'],
        'ft-group-2': ['bob@example.com', 'carol@example.com'],
    },
};

const NONE: FulltextAssignmentConfig = { status: 'none', groupCount: 2, reviewerMap: {} };

test('buildFulltextSetAssignments: 全件が割り当てられ、グループ間の件数差は1以内', () => {
    const refIds = Array.from({ length: 25 }, (_, i) => `ref-${i}`);
    const assignments = buildFulltextSetAssignments(refIds, 3, 'seed-1');

    assert.equal(assignments.length, 25);
    assert.deepEqual(new Set(assignments.map(a => a.refId)), new Set(refIds));

    const counts = new Map<string, number>();
    for (const a of assignments) {
        counts.set(a.fulltextSet, (counts.get(a.fulltextSet) ?? 0) + 1);
    }
    assert.deepEqual([...counts.keys()].sort(), ['ft-group-1', 'ft-group-2', 'ft-group-3']);
    const values = [...counts.values()];
    assert.ok(Math.max(...values) - Math.min(...values) <= 1);
});

test('buildFulltextSetAssignments: 同じシードなら同じ割り振りになる（決定的）', () => {
    const refIds = Array.from({ length: 10 }, (_, i) => `ref-${i}`);
    const a = buildFulltextSetAssignments(refIds, 2, 'seed-x');
    const b = buildFulltextSetAssignments(refIds, 2, 'seed-x');
    assert.deepEqual(a, b);
});

test('distributeUnassigned: 件数の少ないグループから埋めて均す', () => {
    const currentCounts = new Map<string, number>([
        ['ft-group-1', 10],
        ['ft-group-2', 4],
    ]);
    const assignments = distributeUnassigned(
        ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
        2,
        currentCounts,
        'seed-1'
    );

    assert.equal(assignments.length, 6);
    const added = new Map<string, number>();
    for (const a of assignments) {
        added.set(a.fulltextSet, (added.get(a.fulltextSet) ?? 0) + 1);
    }
    // 10 vs 4 → 6件はすべて group-2 に入って 10 vs 10 になる
    assert.equal(added.get('ft-group-2'), 6);
    assert.equal(added.get('ft-group-1') ?? 0, 0);
});

test('canSeeFulltextRef: 未設定なら全員が全候補を見る', () => {
    assert.equal(canSeeFulltextRef({ fulltext_set: 'ft-group-2' }, NONE, 'alice@example.com', false), true);
    assert.equal(canSeeFulltextRef({}, NONE, 'alice@example.com', false), true);
});

test('canSeeFulltextRef: 設定済みなら担当グループ + 未割り当てのみ（管理者は常に全件）', () => {
    // 自分の担当グループ
    assert.equal(canSeeFulltextRef({ fulltext_set: 'ft-group-1' }, CONFIGURED, 'alice@example.com', false), true);
    // 他人のグループ
    assert.equal(canSeeFulltextRef({ fulltext_set: 'ft-group-2' }, CONFIGURED, 'alice@example.com', false), false);
    // 未割り当ては全員に見える
    assert.equal(canSeeFulltextRef({}, CONFIGURED, 'alice@example.com', false), true);
    // 管理者は常に全件
    assert.equal(canSeeFulltextRef({ fulltext_set: 'ft-group-2' }, CONFIGURED, 'admin@example.com', true), true);
    // メールの大文字小文字は無視
    assert.equal(canSeeFulltextRef({ fulltext_set: 'ft-group-1' }, CONFIGURED, 'Alice@Example.com', false), true);
});

test('getFulltextSetsForUser: 複数グループ担当と未設定時の空集合', () => {
    const multi: FulltextAssignmentConfig = {
        status: 'configured',
        groupCount: 2,
        reviewerMap: {
            'ft-group-1': ['alice@example.com'],
            'ft-group-2': ['alice@example.com', 'bob@example.com'],
        },
    };
    assert.deepEqual(
        [...getFulltextSetsForUser(multi, 'alice@example.com')].sort(),
        ['ft-group-1', 'ft-group-2']
    );
    assert.equal(getFulltextSetsForUser(NONE, 'alice@example.com').size, 0);
});

test('fulltextSetOf: 設定済みで空値は unassigned、未設定では空文字', () => {
    assert.equal(fulltextSetOf({ fulltext_set: ' ft-group-1 ' }, CONFIGURED), 'ft-group-1');
    assert.equal(fulltextSetOf({}, CONFIGURED), 'unassigned');
    assert.equal(fulltextSetOf({}, NONE), '');
});
