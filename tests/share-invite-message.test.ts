import test from 'node:test';
import assert from 'node:assert/strict';
import { addPermission } from '../src/lib/sheets-api';
import { buildSpreadsheetUrl, buildInviteMessage } from '../src/lib/share-invite';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

// share_inviteTemplate の実文言（Chrome i18n / manifest）には依存せず、
// t('share_inviteTemplate', url) が呼ばれたことと url の埋め込みだけを検証する
// 軽量な PlatformAdapter モックを使う（chrome.i18n.getMessage 相当）。
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
    getMessage: (key: string, substitutions?: string[]) => {
        if (key === 'share_inviteTemplate') {
            return `INVITE_TEMPLATE:${substitutions?.[0] ?? ''}`;
        }
        return key;
    },
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};

setPlatform(mockPlatform);

// --- buildSpreadsheetUrl / buildInviteMessage ---

test('buildSpreadsheetUrl はスプレッドシートの編集URLを組み立てる', () => {
    assert.equal(buildSpreadsheetUrl('sheet123'), 'https://docs.google.com/spreadsheets/d/sheet123/edit');
});

test('buildInviteMessage は share_inviteTemplate にスプレッドシートURLを渡して招待文を組み立てる', () => {
    const message = buildInviteMessage('sheet123');
    assert.equal(message, 'INVITE_TEMPLATE:https://docs.google.com/spreadsheets/d/sheet123/edit');
});

// --- addPermission ---
// Drive API v3 permissions.create の emailMessage / sendNotificationEmail は
// リクエストボディではなく URL のクエリパラメータで渡す仕様
// （https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create）。
// そのためここでは fetch に渡された URL（第1引数）を検証する。

const originalFetch = globalThis.fetch;

test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

// 注: URL には共有ドライブ対応の supportsAllDrives=true が常に付く（withSharedDriveParams）。
// このテストが見張っているのは「emailMessage / sendNotificationEmail がクエリに載るか」なので、
// 「クエリが1つも無い」ではなくキー単位で不在を確認する。
test('addPermission: emailMessage未指定時は通知系クエリが付かず、ボディも従来どおり', async () => {
    let requestUrl = '';
    let requestBodyText = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        requestBodyText = typeof init?.body === 'string' ? init.body : '';
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await addPermission('file1', 'reviewer@example.com', 'writer');

    assert.equal(requestUrl.includes('emailMessage'), false);
    assert.equal(requestUrl.includes('sendNotificationEmail'), false);
    assert.equal(
        requestUrl,
        'https://www.googleapis.com/drive/v3/files/file1/permissions?supportsAllDrives=true'
    );

    const sentBody = JSON.parse(requestBodyText);
    assert.equal('emailMessage' in sentBody, false);
    assert.equal(sentBody.role, 'writer');
    assert.equal(sentBody.type, 'user');
    assert.equal(sentBody.emailAddress, 'reviewer@example.com');
});

test('addPermission: emailMessage指定時はURLのクエリに載り、sendNotificationEmail=trueも付く。ボディには含まれない', async () => {
    let requestUrl = '';
    let requestBodyText = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        requestBodyText = typeof init?.body === 'string' ? init.body : '';
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const message = 'こんにちは、ご協力ありがとうございます。';
    await addPermission('file1', 'reviewer@example.com', 'writer', message);

    const url = new URL(requestUrl);
    assert.equal(url.searchParams.get('emailMessage'), message);
    assert.equal(url.searchParams.get('sendNotificationEmail'), 'true');

    // 回帰防止: emailMessage はボディへ混入していないこと（Permissionリソースに存在しないフィールドのため）
    const sentBody = JSON.parse(requestBodyText);
    assert.equal('emailMessage' in sentBody, false);
    assert.equal('sendNotificationEmail' in sentBody, false);
});

test('addPermission: emailMessageの空白は%20にエンコードされ、+にはならない（URLSearchParams回帰防止）', async () => {
    let requestUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const message = 'TiAb Review Plugin へようこそ';
    await addPermission('file1', 'reviewer@example.com', 'writer', message);

    // new URL() でパースすると +/%20 のどちらも空白にデコードされてしまい検出できないため、
    // 生のURL文字列に対して直接検証する（URLSearchParams.toString() が使われていないことの確認）
    assert.equal(requestUrl.includes('+'), false, 'URLに + が含まれていないこと（application/x-www-form-urlencoded形式で送っていないこと）');
    assert.equal(requestUrl.includes('%20'), true, 'URLに %20（RFC 3986のパーセントエンコード）が含まれていること');

    // デコードした結果は元のメッセージと一致すること
    const url = new URL(requestUrl);
    assert.equal(url.searchParams.get('emailMessage'), message);
});

test('addPermission: emailMessageのエンコード後の長さがバジェットを超える場合は末尾を切り詰める', async () => {
    let requestUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // 日本語1文字はencodeURIComponentで最大9文字に膨らむため、2500文字あれば
    // バジェット(4000)を大きく超える
    const longMessage = 'あ'.repeat(2500);
    await addPermission('file1', 'reviewer@example.com', 'writer', longMessage);

    const url = new URL(requestUrl);
    const sentMessage = url.searchParams.get('emailMessage');
    assert.ok(sentMessage);
    assert.ok(sentMessage!.length < longMessage.length, '切り詰めが発生していること');
    assert.ok(encodeURIComponent(sentMessage!).length <= 4000, 'エンコード後の長さがバジェット以内であること');
    // 元メッセージの先頭部分が保持されていること（末尾から削る方式のため）
    assert.equal(longMessage.startsWith(sentMessage!), true);
});

test('addPermission: buildInviteMessageの結果をそのままemailMessageクエリとして送れる（実際の呼び出し経路を模した結合確認）', async () => {
    let requestUrl = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestUrl = typeof input === 'string' ? input : input.toString();
        return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const message = buildInviteMessage('sheet123');
    await addPermission('folder1', 'reviewer@example.com', 'writer', message);

    const url = new URL(requestUrl);
    assert.equal(url.searchParams.get('emailMessage'), 'INVITE_TEMPLATE:https://docs.google.com/spreadsheets/d/sheet123/edit');
    assert.equal(url.searchParams.get('sendNotificationEmail'), 'true');
});
