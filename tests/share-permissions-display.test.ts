import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePermissionsForDisplay } from '../src/lib/share-permissions';

// mergePermissionsForDisplay は DOM/fetch に依存しない純粋関数のため、
// platform のセットアップは不要（share-permission-remove.test.ts 等とは異なる）。

test('mergePermissionsForDisplay: フォルダのみの場合はフォルダ権限がそのままusersに入る', () => {
    const result = mergePermissionsForDisplay(
        [{ id: 'p1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' }],
        null
    );
    assert.deepEqual(result.users, [
        { id: 'p1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com', displayName: undefined },
    ]);
    assert.equal(result.linkShare, null);
});

test('mergePermissionsForDisplay: シートのみの場合はシート権限がそのままusersに入る', () => {
    const result = mergePermissionsForDisplay(
        null,
        [{ id: 'p2', role: 'owner', type: 'user', emailAddress: 'owner@example.com' }]
    );
    assert.deepEqual(result.users, [
        { id: 'p2', role: 'owner', type: 'user', emailAddress: 'owner@example.com', displayName: undefined },
    ]);
    assert.equal(result.linkShare, null);
});

test('mergePermissionsForDisplay: 同一メールが両方にいる場合は強い方のroleで1行に統合される（フォルダreader/シートwriter）', () => {
    const result = mergePermissionsForDisplay(
        [{ id: 'folder-perm', role: 'reader', type: 'user', emailAddress: 'Reviewer@Example.com' }],
        [{ id: 'sheet-perm', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' }]
    );
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].role, 'writer');
    assert.equal(result.users[0].id, 'sheet-perm');
});

test('mergePermissionsForDisplay: 同一メールが両方にいる場合は強い方のroleで1行に統合される（フォルダowner/シートwriter）', () => {
    const result = mergePermissionsForDisplay(
        [{ id: 'folder-perm', role: 'owner', type: 'user', emailAddress: 'owner@example.com' }],
        [{ id: 'sheet-perm', role: 'writer', type: 'user', emailAddress: 'owner@example.com' }]
    );
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].role, 'owner');
    assert.equal(result.users[0].id, 'folder-perm');
});

test("mergePermissionsForDisplay: type='anyone'(writer)はusersから除外されlinkShare.role='writer'になる", () => {
    const result = mergePermissionsForDisplay(
        [
            { id: 'p1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
            { id: 'p2', role: 'writer', type: 'anyone' },
        ],
        null
    );
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].emailAddress, 'reviewer@example.com');
    assert.deepEqual(result.linkShare, { role: 'writer' });
});

test("mergePermissionsForDisplay: type='anyone'(reader)はusersから除外されlinkShare.role='reader'になる", () => {
    const result = mergePermissionsForDisplay(
        null,
        [{ id: 'p1', role: 'reader', type: 'anyone' }]
    );
    assert.equal(result.users.length, 0);
    assert.deepEqual(result.linkShare, { role: 'reader' });
});

test("mergePermissionsForDisplay: フォルダ側がanyone(reader)・シート側がanyone(writer)の場合は強い方(writer)を採用する", () => {
    const result = mergePermissionsForDisplay(
        [{ id: 'p1', role: 'reader', type: 'anyone' }],
        [{ id: 'p2', role: 'writer', type: 'anyone' }]
    );
    assert.deepEqual(result.linkShare, { role: 'writer' });
});

test('mergePermissionsForDisplay: emailAddressが無い権限（グループ・ドメイン共有等）はusersから除外される', () => {
    const result = mergePermissionsForDisplay(
        [
            { id: 'p1', role: 'reader', type: 'domain' },
            { id: 'p2', role: 'writer', type: 'group' },
            { id: 'p3', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
        ],
        null
    );
    assert.equal(result.users.length, 1);
    assert.equal(result.users[0].emailAddress, 'reviewer@example.com');
});

test('mergePermissionsForDisplay: 両方null・空配列の場合はusers=[], linkShare=null', () => {
    const resultNull = mergePermissionsForDisplay(null, null);
    assert.deepEqual(resultNull, { users: [], linkShare: null });

    const resultEmpty = mergePermissionsForDisplay([], []);
    assert.deepEqual(resultEmpty, { users: [], linkShare: null });

    const resultUndefined = mergePermissionsForDisplay(undefined, undefined);
    assert.deepEqual(resultUndefined, { users: [], linkShare: null });
});
