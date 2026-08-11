import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFulltextChecklistState, regrantResultKey } from '../src/lib/fulltext-checklist-state';
import type { FulltextChecklistInput, FulltextRegrantKnownResult } from '../src/lib/fulltext-checklist-state';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';

const ASSIGNMENT_NONE: FulltextAssignmentConfig = {
    status: 'none',
    groupCount: 2,
    reviewerMap: {},
};

const ASSIGNMENT_CONFIGURED: FulltextAssignmentConfig = {
    status: 'configured',
    groupCount: 3,
    reviewerMap: {
        'ft-group-1': ['alice@example.com'],
        'ft-group-2': ['bob@example.com'],
        'ft-group-3': ['carol@example.com'],
    },
};

function baseInput(overrides: Partial<FulltextChecklistInput> = {}): FulltextChecklistInput {
    return {
        version: '0.36.1',
        assignment: ASSIGNMENT_NONE,
        selectedFulltextSets: new Set<string>(),
        userEmail: 'carol@example.com',
        visibleCandidateCount: 34,
        decidedCount: 12,
        regrantAvailable: true,
        regrantResult: null,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 項目1: バージョン
// ---------------------------------------------------------------------------

test('バージョン: 取得できれば visible=true でそのまま表示', () => {
    const state = computeFulltextChecklistState(baseInput({ version: '0.36.1' }));
    assert.equal(state.version.visible, true);
    assert.equal(state.version.version, '0.36.1');
});

test('バージョン: 取得できない場合は非表示', () => {
    const state = computeFulltextChecklistState(baseInput({ version: null }));
    assert.equal(state.version.visible, false);
});

// ---------------------------------------------------------------------------
// 項目2: 担当グループ
// ---------------------------------------------------------------------------

test('担当グループ: 割り振り未設定なら非表示', () => {
    const state = computeFulltextChecklistState(baseInput({ assignment: ASSIGNMENT_NONE }));
    assert.equal(state.group.visible, false);
});

test('担当グループ: 自分の担当セットが選択と交差していれば narrowed=true でそのグループIDを返す', () => {
    const state = computeFulltextChecklistState(baseInput({
        assignment: ASSIGNMENT_CONFIGURED,
        selectedFulltextSets: new Set(['ft-group-3', 'unassigned']),
        userEmail: 'carol@example.com',
        visibleCandidateCount: 34,
    }));
    assert.equal(state.group.visible, true);
    assert.equal(state.group.narrowed, true);
    assert.deepEqual(state.group.groupIds, ['ft-group-3']);
    assert.equal(state.group.visibleCount, 34);
});

test('担当グループ: 自分の担当セットが無い（管理者等）場合は narrowed=false', () => {
    const state = computeFulltextChecklistState(baseInput({
        assignment: ASSIGNMENT_CONFIGURED,
        selectedFulltextSets: new Set(['ft-group-1', 'ft-group-2', 'ft-group-3']),
        userEmail: 'admin@example.com', // reviewerMap に無いユーザー
    }));
    assert.equal(state.group.visible, true);
    assert.equal(state.group.narrowed, false);
    assert.deepEqual(state.group.groupIds, []);
});

test('担当グループ: 担当セットはあるが選択から外れている（交差なし）場合は narrowed=false', () => {
    const state = computeFulltextChecklistState(baseInput({
        assignment: ASSIGNMENT_CONFIGURED,
        selectedFulltextSets: new Set(['ft-group-1']), // carolの担当は ft-group-3
        userEmail: 'carol@example.com',
    }));
    assert.equal(state.group.narrowed, false);
    assert.deepEqual(state.group.groupIds, []);
});

test('担当グループ: 複数グループを担当し両方選択中なら両方返す（昇順ソート）', () => {
    const assignment: FulltextAssignmentConfig = {
        status: 'configured',
        groupCount: 3,
        reviewerMap: {
            'ft-group-1': ['dave@example.com'],
            'ft-group-2': ['dave@example.com'],
            'ft-group-3': ['carol@example.com'],
        },
    };
    const state = computeFulltextChecklistState(baseInput({
        assignment,
        selectedFulltextSets: new Set(['ft-group-2', 'ft-group-1']),
        userEmail: 'dave@example.com',
    }));
    assert.deepEqual(state.group.groupIds, ['ft-group-1', 'ft-group-2']);
});

// ---------------------------------------------------------------------------
// 項目3: PDF読み取り権限
// ---------------------------------------------------------------------------

test('PDF読み取り権限: regrant機能が無い環境（Web版等）では非表示', () => {
    const state = computeFulltextChecklistState(baseInput({ regrantAvailable: false }));
    assert.equal(state.regrant.visible, false);
});

test('PDF読み取り権限: 未確認（結果なし）は kind=unchecked', () => {
    const state = computeFulltextChecklistState(baseInput({ regrantResult: null }));
    assert.equal(state.regrant.visible, true);
    assert.equal(state.regrant.kind, 'unchecked');
});

test('PDF読み取り権限: 今回のセッションで確認済み・問題なしは kind=ok', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 0,
        totalCachedCount: 20,
        checkedAt: '2026-08-10T01:00:00.000Z',
        freshness: 'session',
    };
    const state = computeFulltextChecklistState(baseInput({ regrantResult: result }));
    assert.equal(state.regrant.kind, 'ok');
    assert.equal(state.regrant.totalCachedCount, 20);
});

test('PDF読み取り権限: 今回のセッションで確認済み・読めないPDFありは kind=unreadable', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 3,
        totalCachedCount: 20,
        checkedAt: '2026-08-10T01:00:00.000Z',
        freshness: 'session',
    };
    const state = computeFulltextChecklistState(baseInput({ regrantResult: result }));
    assert.equal(state.regrant.kind, 'unreadable');
    assert.equal(state.regrant.unreadableCount, 3);
});

test('PDF読み取り権限: 前回確認（persisted）の結果は問題なしでも kind=previous のまま（✅固定にしない）', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 0,
        totalCachedCount: 20,
        checkedAt: '2026-08-01T01:00:00.000Z',
        freshness: 'persisted',
    };
    const state = computeFulltextChecklistState(baseInput({ regrantResult: result }));
    assert.equal(state.regrant.kind, 'previous');
    assert.equal(state.regrant.checkedAt, '2026-08-01T01:00:00.000Z');
});

test('PDF読み取り権限: 前回確認（persisted）で問題ありだった場合も kind=previous', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 5,
        totalCachedCount: 20,
        checkedAt: '2026-08-01T01:00:00.000Z',
        freshness: 'persisted',
    };
    const state = computeFulltextChecklistState(baseInput({ regrantResult: result }));
    assert.equal(state.regrant.kind, 'previous');
    assert.equal(state.regrant.unreadableCount, 5);
});

// ---------------------------------------------------------------------------
// 項目4: 判定進捗
// ---------------------------------------------------------------------------

test('判定進捗: done < total は complete=false', () => {
    const state = computeFulltextChecklistState(baseInput({ decidedCount: 12, visibleCandidateCount: 34 }));
    assert.equal(state.progress.done, 12);
    assert.equal(state.progress.total, 34);
    assert.equal(state.progress.complete, false);
});

test('判定進捗: done === total は complete=true', () => {
    const state = computeFulltextChecklistState(baseInput({ decidedCount: 34, visibleCandidateCount: 34 }));
    assert.equal(state.progress.complete, true);
});

test('判定進捗: 候補0件（0/0）は vacuously complete=true', () => {
    const state = computeFulltextChecklistState(baseInput({ decidedCount: 0, visibleCandidateCount: 0 }));
    assert.equal(state.progress.complete, true);
});

// ---------------------------------------------------------------------------
// 全体: 折りたたみ判定（allComplete）
// ---------------------------------------------------------------------------

test('allComplete: regrant=ok かつ progress=complete なら true（バージョン・グループは情報のみで妨げない）', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 0,
        totalCachedCount: 20,
        checkedAt: '2026-08-10T01:00:00.000Z',
        freshness: 'session',
    };
    const state = computeFulltextChecklistState(baseInput({
        assignment: ASSIGNMENT_NONE, // グループ行は非表示（情報のみ扱いなので妨げない）
        regrantResult: result,
        decidedCount: 34,
        visibleCandidateCount: 34,
    }));
    assert.equal(state.allComplete, true);
});

test('allComplete: regrant未確認なら false', () => {
    const state = computeFulltextChecklistState(baseInput({
        regrantResult: null,
        decidedCount: 34,
        visibleCandidateCount: 34,
    }));
    assert.equal(state.allComplete, false);
});

test('allComplete: 判定が未完了なら false', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 0,
        totalCachedCount: 20,
        checkedAt: '2026-08-10T01:00:00.000Z',
        freshness: 'session',
    };
    const state = computeFulltextChecklistState(baseInput({
        regrantResult: result,
        decidedCount: 12,
        visibleCandidateCount: 34,
    }));
    assert.equal(state.allComplete, false);
});

test('allComplete: regrant機能が無い環境（非表示）なら progress完了だけで true になりうる', () => {
    const state = computeFulltextChecklistState(baseInput({
        regrantAvailable: false,
        regrantResult: null,
        decidedCount: 34,
        visibleCandidateCount: 34,
    }));
    assert.equal(state.allComplete, true);
});

test('allComplete: regrantがpersisted(前回確認)扱いのままなら false（再確認を促す）', () => {
    const result: FulltextRegrantKnownResult = {
        unreadableCount: 0,
        totalCachedCount: 20,
        checkedAt: '2026-08-01T01:00:00.000Z',
        freshness: 'persisted',
    };
    const state = computeFulltextChecklistState(baseInput({
        regrantResult: result,
        decidedCount: 34,
        visibleCandidateCount: 34,
    }));
    assert.equal(state.allComplete, false);
});

// ---------------------------------------------------------------------------
// regrantResultKey（PDF権限確認結果の永続化・セッション記憶キー。アカウント間で共有しない）
// ---------------------------------------------------------------------------

test('regrantResultKey: 大文字小文字・前後の空白を正規化し同一キーになる', () => {
    const a = regrantResultKey('sheet1', 'A@X.com ');
    const b = regrantResultKey('sheet1', 'a@x.com');
    assert.equal(a, b);
});

test('regrantResultKey: 異なるユーザーは異なるキーになる（アカウント間で結果を共有しない）', () => {
    const alice = regrantResultKey('sheet1', 'alice@example.com');
    const bob = regrantResultKey('sheet1', 'bob@example.com');
    assert.notEqual(alice, bob);
});

test('regrantResultKey: 異なる spreadsheetId は異なるキーになる', () => {
    const a = regrantResultKey('sheet1', 'alice@example.com');
    const b = regrantResultKey('sheet2', 'alice@example.com');
    assert.notEqual(a, b);
});
