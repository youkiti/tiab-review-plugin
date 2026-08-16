import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { describePdfLoadFailure } from '../src/lib/fulltext-pdf-access';
import {
    DriveAccessDeniedError,
    DriveAuthError,
    DriveTransientError,
    downloadDriveFile,
} from '../src/lib/drive-api';

// Issue #69: Drive の /preview 埋め込みは frame-ancestors により拡張機能ページからは
// 構造的に読み込めない。フォールバック先が無い以上、左ペインは「なぜ読めないか」を
// 出し分けるしかなく、その出し分けを間違えると
//  - 一時エラーなのに「未付与です、再付与してください」（再付与しても直らない）
//  - 未付与なのに「時間をおいて再試行」（いつまで待っても直らない）
// という誤った案内になる。ここはその出し分けの回帰テスト。

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
    getMessage: (key: string) => key, // 分岐の検証が目的なのでメッセージ内容は問わない
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
setPlatform(mockPlatform);

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

/** 指定のレスポンスを返す fetch スタブ */
function stubFetch(response: Response | (() => never)): void {
    globalThis.fetch = (async () => {
        if (typeof response === 'function') response();
        return response as Response;
    }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// describePdfLoadFailure: 失敗の種別 → 案内の出し分け
// ---------------------------------------------------------------------------

test('describePdfLoadFailure: 未付与は再付与を主導線にし、再試行は出さない', () => {
    const view = describePdfLoadFailure(new DriveAccessDeniedError('file-1', 404));
    assert.equal(view.kind, 'not-granted');
    assert.equal(view.messageKey, 'fulltext_pdfPaneNotGranted');
    assert.equal(view.showRegrant, true);
    // 再付与せずに再試行しても結果は変わらないため出さない
    assert.equal(view.showRetry, false);
});

test('describePdfLoadFailure: 認証切れは再試行のみ（再付与を案内しない）', () => {
    const view = describePdfLoadFailure(new DriveAuthError('file-1'));
    assert.equal(view.kind, 'auth-error');
    assert.equal(view.messageKey, 'fulltext_driveAuthError');
    assert.equal(view.showRegrant, false);
    assert.equal(view.showRetry, true);
});

test('describePdfLoadFailure: 一時エラーを未付与と断定しない', () => {
    const view = describePdfLoadFailure(new DriveTransientError('file-1'));
    assert.equal(view.kind, 'transient');
    assert.equal(view.messageKey, 'fulltext_driveTransientError');
    assert.equal(view.showRegrant, false);
    assert.equal(view.showRetry, true);
});

test('describePdfLoadFailure: 分類できない失敗は unknown（未付与へ倒さない）', () => {
    for (const err of [null, undefined, new Error('boom'), 'not an error']) {
        const view = describePdfLoadFailure(err);
        assert.equal(view.kind, 'unknown', String(err));
        assert.equal(view.messageKey, 'fulltext_pdfPaneLoadFailed');
        assert.equal(view.showRegrant, false, String(err));
        assert.equal(view.showRetry, true, String(err));
    }
});

// ---------------------------------------------------------------------------
// downloadDriveFile: 上の出し分けの前提になる型付きエラー
// （ステータス分類は classifyDriveApiStatus に一本化されている）
// ---------------------------------------------------------------------------

test('downloadDriveFile: 401 は DriveAuthError', async () => {
    stubFetch(new Response('', { status: 401 }));
    await assert.rejects(downloadDriveFile('file-1'), DriveAuthError);
});

test('downloadDriveFile: 403/404 は DriveAccessDeniedError（statusも保持する）', async () => {
    for (const status of [403, 404]) {
        stubFetch(new Response('', { status }));
        await assert.rejects(downloadDriveFile('file-1'), (err: unknown) => {
            assert.ok(err instanceof DriveAccessDeniedError);
            assert.equal(err.status, status);
            return true;
        });
    }
});

test('downloadDriveFile: 5xx/429 は DriveTransientError（素の Error にしない）', async () => {
    for (const status of [429, 500, 503]) {
        stubFetch(new Response('', { status }));
        await assert.rejects(downloadDriveFile('file-1'), DriveTransientError, `status=${status}`);
    }
});

test('downloadDriveFile: ネットワーク例外は DriveTransientError', async () => {
    stubFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(downloadDriveFile('file-1'), DriveTransientError);
});

test('downloadDriveFile: 200でも本文がHTMLならファイル実体として扱わない', async () => {
    // サインインページ等のHTMLをそのまま blob で返すと、PDF.js が「壊れたPDF」として
    // 失敗し、原因が画面から辿れなくなる。
    stubFetch(new Response('<html>sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
    }));
    await assert.rejects(downloadDriveFile('file-1'), DriveAccessDeniedError);
});

test('downloadDriveFile: PDFバイトはそのまま返す', async () => {
    stubFetch(new Response('%PDF-1.4', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
    }));
    const blob = await downloadDriveFile('file-1');
    assert.equal(await blob.text(), '%PDF-1.4');
});
