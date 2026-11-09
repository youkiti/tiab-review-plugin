// assignment-initial-selection.test.ts - TiAb 担当セットの初期選択の検証

import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSelectedAssignmentSets } from '../src/lib/assignment-initial-selection';

const availableSets = new Set(['calibration', 'group-1', 'group-2', 'unassigned']);

test('管理者で担当あり: 担当とキャリブレーションと未割当を選び、存在しないセットを除く', () => {
    const assignedSets = new Set(['calibration', 'group-2', 'group-9']);
    const selected = initialSelectedAssignmentSets({ configured: true, isAdmin: true, availableSets, assignedSets });
    assert.deepEqual(selected, new Set(['calibration', 'group-2', 'unassigned']));
    assert.deepEqual(assignedSets, new Set(['calibration', 'group-2', 'group-9']));
    assert.deepEqual(availableSets, new Set(['calibration', 'group-1', 'group-2', 'unassigned']));
});

test('管理者で担当あり: 未割当がなければ追加しない', () => {
    assert.deepEqual(initialSelectedAssignmentSets({
        configured: true,
        isAdmin: true,
        availableSets: new Set(['calibration', 'group-1', 'group-2']),
        assignedSets: new Set(['calibration', 'group-1']),
    }), new Set(['calibration', 'group-1']));
});

test('管理者で担当なし: キャリブレーションだけや存在しないグループは担当ありとみなさない', () => {
    for (const assignedSets of [new Set<string>(), new Set(['calibration']), new Set(['calibration', 'group-9'])]) {
        const selected = initialSelectedAssignmentSets({ configured: true, isAdmin: true, availableSets, assignedSets });
        assert.deepEqual(selected, availableSets);
        assert.notEqual(selected, availableSets);
    }
});

test('非管理者で設定済み: 従来どおり担当セットをそのまま選ぶ', () => {
    const assignedSets = new Set(['calibration', 'group-2', 'group-9']);
    assert.deepEqual(initialSelectedAssignmentSets({
        configured: true, isAdmin: false, availableSets, assignedSets,
    }), assignedSets);
});

test('未設定: 管理者は全セット、非管理者は空を選ぶ', () => {
    for (const isAdmin of [true, false]) {
        assert.deepEqual(initialSelectedAssignmentSets({
            configured: false, isAdmin, availableSets, assignedSets: new Set(),
        }), isAdmin ? availableSets : new Set());
    }
});
