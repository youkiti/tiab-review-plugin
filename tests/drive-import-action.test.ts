import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImportAction } from '../src/lib/drive-import-action';
import type { ImportedCopyMatch, SheetFulltextState } from '../src/lib/drive-import-action';

const REF_A = 'ref-a';
const REF_B = 'ref-b';

const copyForA: ImportedCopyMatch = { id: 'copy1', webViewLink: 'https://drive.google.com/file/d/copy1/view', refId: REF_A };
const copyNoRefId: ImportedCopyMatch = { id: 'copy2', webViewLink: 'https://drive.google.com/file/d/copy2/view' };

// --- シート行が見つからない -> 常に 'error' ---

test('resolveImportAction: シートに対象行が無ければ既存コピーの有無に関わらずerror', () => {
    assert.equal(resolveImportAction(null, undefined, REF_A), 'error');
    assert.equal(resolveImportAction(copyForA, undefined, REF_A), 'error');
});

// --- コピーなし ---

test('resolveImportAction: コピーなし・未反映(not_retrieved) -> copy-and-update', () => {
    const sheetState: SheetFulltextState = { status: 'not_retrieved', url: '' };
    assert.equal(resolveImportAction(null, sheetState, REF_A), 'copy-and-update');
});

test('resolveImportAction: コピーなし・retrieved(外部URLのみ) -> cachedではないのでcopy-and-update', () => {
    const sheetState: SheetFulltextState = { status: 'retrieved', url: 'https://example.com/paper.pdf' };
    assert.equal(resolveImportAction(null, sheetState, REF_A), 'copy-and-update');
});

test('resolveImportAction: コピーなし・unavailable -> copy-and-update', () => {
    const sheetState: SheetFulltextState = { status: 'unavailable', url: '' };
    assert.equal(resolveImportAction(null, sheetState, REF_A), 'copy-and-update');
});

test('resolveImportAction: コピーなし・cached(他経路で確保済み) -> 上書きしないのでconflict-keep', () => {
    const sheetState: SheetFulltextState = { status: 'cached', url: 'https://drive.google.com/file/d/other/view' };
    assert.equal(resolveImportAction(null, sheetState, REF_A), 'conflict-keep');
});

// --- コピーあり・refId一致 ---

test('resolveImportAction: コピーあり・refId一致・未反映 -> reuse-and-update（中断した取り込みの再開）', () => {
    const sheetState: SheetFulltextState = { status: 'not_retrieved', url: '' };
    assert.equal(resolveImportAction(copyForA, sheetState, REF_A), 'reuse-and-update');
});

test('resolveImportAction: コピーあり・refId一致・cachedかつURL一致 -> already-done（応答喪失後の再試行）', () => {
    const sheetState: SheetFulltextState = { status: 'cached', url: copyForA.webViewLink };
    assert.equal(resolveImportAction(copyForA, sheetState, REF_A), 'already-done');
});

test('resolveImportAction: コピーあり・refId一致・cachedだがURL不一致 -> conflict-keep', () => {
    const sheetState: SheetFulltextState = { status: 'cached', url: 'https://drive.google.com/file/d/someone-elses-copy/view' };
    assert.equal(resolveImportAction(copyForA, sheetState, REF_A), 'conflict-keep');
});

// --- コピーあり・refId不一致（別Referenceへの対応付け） ---

test('resolveImportAction: コピーあり・refId不一致・未反映 -> 流用せずcopy-and-update（sourceFileId重複は許容）', () => {
    const sheetState: SheetFulltextState = { status: 'not_retrieved', url: '' };
    assert.equal(resolveImportAction(copyForA, sheetState, REF_B), 'copy-and-update');
});

test('resolveImportAction: コピーあり・refId不一致・cachedかつURLがそのコピーと一致 -> refId不一致でもURL一致ならalready-done', () => {
    // 実運用上は起こりにくいが、URL一致を最優先の判定材料とする設計（コメント参照）
    const sheetState: SheetFulltextState = { status: 'cached', url: copyForA.webViewLink };
    assert.equal(resolveImportAction(copyForA, sheetState, REF_B), 'already-done');
});

// --- appProperties.refId が無い孤立コピー ---

test('resolveImportAction: refId不明の既存コピー・未反映 -> 流用せずcopy-and-update', () => {
    const sheetState: SheetFulltextState = { status: 'not_retrieved', url: '' };
    assert.equal(resolveImportAction(copyNoRefId, sheetState, REF_A), 'copy-and-update');
});

test('resolveImportAction: refId不明の既存コピー・cachedかつURL一致 -> already-done', () => {
    const sheetState: SheetFulltextState = { status: 'cached', url: copyNoRefId.webViewLink };
    assert.equal(resolveImportAction(copyNoRefId, sheetState, REF_A), 'already-done');
});

// --- 実行直後（今作った/再利用したコピー）の事後検証を模したケース ---

test('resolveImportAction: 新規作成直後のコピーで再検証し、まだcachedでなければ更新に進む', () => {
    const justCreated: ImportedCopyMatch = { id: 'new1', webViewLink: 'https://drive.google.com/file/d/new1/view', refId: REF_A };
    const sheetState: SheetFulltextState = { status: 'not_retrieved', url: '' };
    assert.equal(resolveImportAction(justCreated, sheetState, REF_A), 'reuse-and-update');
});

test('resolveImportAction: 新規作成直後のコピーで再検証し、他ユーザーが先にcached済みならconflict-keep', () => {
    const justCreated: ImportedCopyMatch = { id: 'new1', webViewLink: 'https://drive.google.com/file/d/new1/view', refId: REF_A };
    const sheetState: SheetFulltextState = { status: 'cached', url: 'https://drive.google.com/file/d/someone-elses-copy/view' };
    assert.equal(resolveImportAction(justCreated, sheetState, REF_A), 'conflict-keep');
});
