import test from 'node:test';
import assert from 'node:assert/strict';
import {
    canRemovePermission,
    classifyPermissionRemovalError,
    findRemovableUserPermission,
    permissionRemovalMessageKey,
    resolveRemovalTargets,
    summarizeRemovalOutcome,
} from '../src/lib/share-permissions';
import { deletePermission, DrivePermissionError } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// share-invite-message.test.ts と同じ軽量な PlatformAdapter モック
// （getAuthToken のみ実際に使用される）
const mockPlatform: PlatformAdapter = {
    getAuthToken: async () => 'test-token',
    forceReauth: async () => 'test-token',
    clearAuth: async () => {},
    storageGet: async () => ({}),
    storageSet: async () => {},
    storageRemove: async () => {},
    storageClear: async () => {},
    onMessage: () => {},
    emitMessage: () => {},
    getMessage: (key: string) => key,
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};

setPlatform(mockPlatform);

// --- canRemovePermission ---

test('canRemovePermission: 編集者(writer)は解除可能', () => {
    const result = canRemovePermission(
        { id: 'perm1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
        { isAdmin: true, selfEmail: 'owner@example.com' }
    );
    assert.equal(result, true);
});

test('canRemovePermission: オーナー(owner)は解除不可', () => {
    const result = canRemovePermission(
        { id: 'perm1', role: 'owner', type: 'user', emailAddress: 'owner@example.com' },
        { isAdmin: true, selfEmail: 'owner@example.com' }
    );
    assert.equal(result, false);
});

test('canRemovePermission: 自分自身（大文字小文字違い）は解除不可', () => {
    const result = canRemovePermission(
        { id: 'perm1', role: 'writer', type: 'user', emailAddress: 'Reviewer@Example.com' },
        { isAdmin: true, selfEmail: '  reviewer@example.com  ' }
    );
    assert.equal(result, false);
});

test('canRemovePermission: isAdmin=false は解除不可', () => {
    const result = canRemovePermission(
        { id: 'perm1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
        { isAdmin: false, selfEmail: 'owner@example.com' }
    );
    assert.equal(result, false);
});

test('canRemovePermission: id無しは解除不可', () => {
    const result = canRemovePermission(
        { role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
        { isAdmin: true, selfEmail: 'owner@example.com' }
    );
    assert.equal(result, false);
});

test("canRemovePermission: type='anyone'（リンク共有）は解除不可", () => {
    const result = canRemovePermission(
        { id: 'perm1', role: 'reader', type: 'anyone' },
        { isAdmin: true, selfEmail: 'owner@example.com' }
    );
    assert.equal(result, false);
});

// --- resolveRemovalTargets ---

test('resolveRemovalTargets: フォルダありの場合はフォルダ優先で両方返す', () => {
    assert.deepEqual(resolveRemovalTargets('folderA', 'sheetB'), ['folderA', 'sheetB']);
});

test('resolveRemovalTargets: フォルダなし(null)の場合はスプレッドシートのみ', () => {
    assert.deepEqual(resolveRemovalTargets(null, 'sheetB'), ['sheetB']);
});

test('resolveRemovalTargets: フォルダIDとスプレッドシートIDが同一の場合は重複除去', () => {
    assert.deepEqual(resolveRemovalTargets('sheetB', 'sheetB'), ['sheetB']);
});

// --- findRemovableUserPermission ---

test('findRemovableUserPermission: 大文字小文字を無視してメールアドレスが一致する権限を返す', () => {
    const permissions = [
        { id: 'perm1', role: 'writer', type: 'user', emailAddress: 'reviewer@example.com' },
    ];
    const found = findRemovableUserPermission(permissions, 'Reviewer@Example.COM');
    assert.deepEqual(found, permissions[0]);
});

test('findRemovableUserPermission: オーナーの権限はマッチしない', () => {
    const permissions = [
        { id: 'perm1', role: 'owner', type: 'user', emailAddress: 'owner@example.com' },
    ];
    const found = findRemovableUserPermission(permissions, 'owner@example.com');
    assert.equal(found, undefined);
});

// --- classifyPermissionRemovalError / permissionRemovalMessageKey ---

test('classifyPermissionRemovalError: apiMessageにinheritedを含む場合はinherited', () => {
    assert.equal(classifyPermissionRemovalError(403, 'The permission is inherited and cannot be deleted'), 'inherited');
    assert.equal(classifyPermissionRemovalError(403, 'INHERITED permission'), 'inherited');
});

test('classifyPermissionRemovalError: status 404はnotFound', () => {
    assert.equal(classifyPermissionRemovalError(404), 'notFound');
});

test('classifyPermissionRemovalError: status 403はforbidden', () => {
    assert.equal(classifyPermissionRemovalError(403), 'forbidden');
});

test('classifyPermissionRemovalError: それ以外はunknown', () => {
    assert.equal(classifyPermissionRemovalError(500), 'unknown');
    assert.equal(classifyPermissionRemovalError(400, 'Bad request'), 'unknown');
});

test('permissionRemovalMessageKey: 分類ごとに対応するi18nキーを返す', () => {
    assert.equal(permissionRemovalMessageKey('forbidden'), 'share_removeErrorForbidden');
    assert.equal(permissionRemovalMessageKey('notFound'), 'share_removeErrorNotFound');
    assert.equal(permissionRemovalMessageKey('inherited'), 'share_removeErrorInherited');
    assert.equal(permissionRemovalMessageKey('unknown'), 'share_removeErrorUnknown');
});

// --- summarizeRemovalOutcome ---

test('summarizeRemovalOutcome: 成功1件以上・失敗0件は share_removed（$1=メール）', () => {
    assert.deepEqual(summarizeRemovalOutcome(1, []), { key: 'share_removed', arg: 'email' });
});

test('summarizeRemovalOutcome: 成功1件以上・失敗1件以上は share_removePartial（$1=メール）', () => {
    assert.deepEqual(summarizeRemovalOutcome(1, ['forbidden']), { key: 'share_removePartial', arg: 'email' });
});

test('summarizeRemovalOutcome: 成功0件・失敗0件（対象なし）は share_removeNotFound（$1=メール）', () => {
    assert.deepEqual(summarizeRemovalOutcome(0, []), { key: 'share_removeNotFound', arg: 'email' });
});

test("summarizeRemovalOutcome: 全失敗が'unknown'の場合は share_removeErrorUnknown で arg='apiMessage'", () => {
    assert.deepEqual(summarizeRemovalOutcome(0, ['unknown']), { key: 'share_removeErrorUnknown', arg: 'apiMessage' });
});

test("summarizeRemovalOutcome: 全失敗が'forbidden'の場合は share_removeErrorForbidden で arg='none'", () => {
    assert.deepEqual(summarizeRemovalOutcome(0, ['forbidden']), { key: 'share_removeErrorForbidden', arg: 'none' });
});

// --- deletePermission ---

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('deletePermission: DELETEメソッドと正しいURLでfetchを呼ぶ', async () => {
    let requestUrl = '';
    let requestMethod = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        requestMethod = init?.method ?? '';
        return new Response(null, { status: 204 });
    }) as typeof fetch;

    await deletePermission('file1', 'perm1');

    assert.equal(requestMethod, 'DELETE');
    assert.equal(requestUrl, 'https://www.googleapis.com/drive/v3/files/file1/permissions/perm1');
});

test('deletePermission: 204で正常に解決する', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await assert.doesNotReject(deletePermission('file1', 'perm1'));
});

test('deletePermission: 403の場合はDrivePermissionError(status=403)がthrowされる', async () => {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: 'The user does not have sufficient permissions' } }), {
            status: 403,
        })) as typeof fetch;

    await assert.rejects(
        deletePermission('file1', 'perm1'),
        (error: unknown) => {
            assert.ok(error instanceof DrivePermissionError);
            assert.equal(error.status, 403);
            assert.equal(error.apiMessage, 'The user does not have sufficient permissions');
            return true;
        }
    );
});
