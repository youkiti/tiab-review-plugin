import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFulltextSetAssignments,
    distributeUnassigned,
    canSeeFulltextRef,
    getFulltextSetsForUser,
    fulltextSetOf,
    initialSelectedFulltextSets,
    matchesSelectedFulltextSets,
    normalizeStoredFulltextSets,
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

test('initialSelectedFulltextSets: 担当グループがあれば担当分＋unassigned', () => {
    assert.deepEqual(
        [...initialSelectedFulltextSets(CONFIGURED, 'alice@example.com')].sort(),
        ['ft-group-1', 'unassigned']
    );
});

test('initialSelectedFulltextSets: 担当グループが無ければ全グループ＋unassigned（オーナー等）', () => {
    assert.deepEqual(
        [...initialSelectedFulltextSets(CONFIGURED, 'owner@example.com')].sort(),
        ['ft-group-1', 'ft-group-2', 'unassigned']
    );
});

test('initialSelectedFulltextSets: 割り振り未設定(status=none)なら空集合', () => {
    assert.equal(initialSelectedFulltextSets(NONE, 'alice@example.com').size, 0);
});

test('matchesSelectedFulltextSets: status=none なら常に true', () => {
    const selected = new Set(['ft-group-1']);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-2' }, NONE, selected), true);
});

test('matchesSelectedFulltextSets: 選択が空集合なら常に true（未初期化とみなす）', () => {
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, new Set()), true);
});

test('matchesSelectedFulltextSets: 全グループ選択時は絞り込まない（unassignedの有無は問わない）', () => {
    const selected = new Set(['ft-group-1', 'ft-group-2']);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, selected), true);
    assert.equal(matchesSelectedFulltextSets({}, CONFIGURED, selected), true); // unassigned
});

test('matchesSelectedFulltextSets: 一部選択時は該当セットのみ通す', () => {
    const selected = new Set(['ft-group-1', 'unassigned']);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, selected), true);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-2' }, CONFIGURED, selected), false);
    assert.equal(matchesSelectedFulltextSets({}, CONFIGURED, selected), true); // unassigned
});

test('非管理者回帰: 自分の担当セットのみ選択していても fulltext_set が空(unassigned)の文献は通る', () => {
    // 初期選択は担当セット + unassigned のはず。取りこぼし防止の要件。
    const selected = initialSelectedFulltextSets(CONFIGURED, 'alice@example.com');
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: '' }, CONFIGURED, selected), true);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, selected), true);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-2' }, CONFIGURED, selected), false);
});

test('回帰: グループ数変更後に古い選択(state.selectedFulltextSets)を使い回すと全件弾かれる', () => {
    // groupCount=3 → 2 へ再シャッフルした直後を想定。古い選択には新しい構成に存在しない
    // ft-group-3 が残ったまま（ウィザードが選択状態を更新しなかった場合の再現）。
    const staleSelected = new Set(['ft-group-3', 'unassigned']);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, staleSelected), false);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-2' }, CONFIGURED, staleSelected), false);

    // initialSelectedFulltextSets で新しい設定に基づいて選択を作り直せば、担当外だけを除いて通る
    const freshSelected = initialSelectedFulltextSets(CONFIGURED, 'owner@example.com');
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-1' }, CONFIGURED, freshSelected), true);
    assert.equal(matchesSelectedFulltextSets({ fulltext_set: 'ft-group-2' }, CONFIGURED, freshSelected), true);
});

test('normalizeStoredFulltextSets: 陳腐化したID（ft-group-9等）は捨てる', () => {
    const stored = ['ft-group-1', 'ft-group-9', 'unassigned'];
    const result = normalizeStoredFulltextSets(stored, CONFIGURED, 'alice@example.com');
    assert.deepEqual([...result].sort(), ['ft-group-1', 'unassigned']);
});

test('normalizeStoredFulltextSets: 捨てた結果グループが空になれば初期選択へフォールバック', () => {
    // CONFIGURED は groupCount=2 なので ft-group-9 は無効
    const stored = ['ft-group-9', 'unassigned'];
    const result = normalizeStoredFulltextSets(stored, CONFIGURED, 'alice@example.com');
    assert.deepEqual(
        [...result].sort(),
        [...initialSelectedFulltextSets(CONFIGURED, 'alice@example.com')].sort()
    );
});
