import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCachedFulltextRefs, selectUnreadableRefs } from '../src/lib/fulltext-access';
import type { ReferenceWithStatus } from '../src/lib/types';

// Issue #60: drive.file は「アプリ×ユーザー×ファイル」単位でしか付与されないため、
// 共同研究者がアップロードしたPDFは他のメンバーから読めない。ここでは「読めないPDF」の
// 検知ロジック（純粋関数）だけを検証する。実際のDrive API呼び出し（listAccessibleFileIdsInFolder）と
// クエリ組み立て（buildFolderChildrenQuery、drive-api.ts側で定義）は fulltext-access-drive.test.ts
// 側でカバーする。

function makeRef(overrides: Partial<ReferenceWithStatus>): ReferenceWithStatus {
    return {
        ref_id: 'ref-1',
        title: 'タイトル',
        status: 'pending',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// collectCachedFulltextRefs
// ---------------------------------------------------------------------------

test('collectCachedFulltextRefs: fulltext_status=cached かつ Drive URLからfileIdを取れる文献のみ返す', () => {
    const refs: ReferenceWithStatus[] = [
        makeRef({
            ref_id: 'ref-a',
            title: 'A論文',
            fulltext_status: 'cached',
            fulltext_url: 'https://drive.google.com/file/d/abc123/view',
        }),
    ];
    const result = collectCachedFulltextRefs(refs);
    assert.deepEqual(result, [
        { refId: 'ref-a', title: 'A論文', fileId: 'abc123', url: 'https://drive.google.com/file/d/abc123/view' },
    ]);
});

test('collectCachedFulltextRefs: fulltext_status が cached でない文献は除外する', () => {
    const refs: ReferenceWithStatus[] = [
        makeRef({ fulltext_status: 'retrieved', fulltext_url: 'https://drive.google.com/file/d/abc123/view' }),
        makeRef({ fulltext_status: 'not_retrieved', fulltext_url: 'https://drive.google.com/file/d/def456/view' }),
        makeRef({ fulltext_status: undefined, fulltext_url: 'https://drive.google.com/file/d/ghi789/view' }),
    ];
    assert.deepEqual(collectCachedFulltextRefs(refs), []);
});

test('collectCachedFulltextRefs: fulltext_url が空/未設定の文献は除外する', () => {
    const refs: ReferenceWithStatus[] = [
        makeRef({ fulltext_status: 'cached', fulltext_url: '' }),
        makeRef({ fulltext_status: 'cached', fulltext_url: undefined }),
    ];
    assert.deepEqual(collectCachedFulltextRefs(refs), []);
});

test('collectCachedFulltextRefs: Drive以外のURL（fileIdを抽出できない）は除外する', () => {
    const refs: ReferenceWithStatus[] = [
        makeRef({ fulltext_status: 'cached', fulltext_url: 'https://example.com/paper.pdf' }),
    ];
    assert.deepEqual(collectCachedFulltextRefs(refs), []);
});

test('collectCachedFulltextRefs: 空配列を渡せば空配列を返す', () => {
    assert.deepEqual(collectCachedFulltextRefs([]), []);
});

// ---------------------------------------------------------------------------
// selectUnreadableRefs
// ---------------------------------------------------------------------------

test('selectUnreadableRefs: accessibleIdsに含まれないfileIdの文献だけを返す', () => {
    const cached = [
        { refId: 'ref-a', title: 'A', fileId: 'file-a', url: 'u-a' },
        { refId: 'ref-b', title: 'B', fileId: 'file-b', url: 'u-b' },
        { refId: 'ref-c', title: 'C', fileId: 'file-c', url: 'u-c' },
    ];
    const accessibleIds = new Set(['file-a', 'file-c']);
    const result = selectUnreadableRefs(cached, accessibleIds);
    assert.deepEqual(result, [{ refId: 'ref-b', title: 'B', fileId: 'file-b', url: 'u-b' }]);
});

test('selectUnreadableRefs: 全てaccessibleIdsに含まれれば空配列', () => {
    const cached = [{ refId: 'ref-a', title: 'A', fileId: 'file-a', url: 'u-a' }];
    assert.deepEqual(selectUnreadableRefs(cached, new Set(['file-a'])), []);
});

test('selectUnreadableRefs: accessibleIdsが空集合なら全件を「読めない」として返す', () => {
    const cached = [
        { refId: 'ref-a', title: 'A', fileId: 'file-a', url: 'u-a' },
        { refId: 'ref-b', title: 'B', fileId: 'file-b', url: 'u-b' },
    ];
    assert.deepEqual(selectUnreadableRefs(cached, new Set()), cached);
});
