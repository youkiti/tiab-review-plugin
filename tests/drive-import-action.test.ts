import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImportAction, shouldBackfillDriveColumns } from '../src/lib/drive-import-action';
import type { ImportedCopyMatch, SheetFulltextState } from '../src/lib/drive-import-action';

const REF_A = 'ref-a';
const REF_B = 'ref-b';

const SOURCE_1 = 'source-1';
const SOURCE_2 = 'source-2';

const copyForA: ImportedCopyMatch = { id: 'copy1', webViewLink: 'https://drive.google.com/file/d/copy1/view', refId: REF_A };
const copyNoRefId: ImportedCopyMatch = { id: 'copy2', webViewLink: 'https://drive.google.com/file/d/copy2/view' };

/** sourceFileId/copyFileId を省略できるヘルパー（既定は空文字＝Drive直接取り込み以外の経路） */
function sheetState(overrides: Partial<SheetFulltextState>): SheetFulltextState {
    return { status: 'not_retrieved', url: '', sourceFileId: '', copyFileId: '', ...overrides };
}

// --- シート行が見つからない -> 常に 'error' ---

test('resolveImportAction: シートに対象行が無ければ既存コピーの有無に関わらずerror', () => {
    assert.equal(resolveImportAction(null, undefined, REF_A, SOURCE_1).action, 'error');
    assert.equal(resolveImportAction(copyForA, undefined, REF_A, SOURCE_1).action, 'error');
});

// --- コピーなし ---

test('resolveImportAction: コピーなし・未反映(not_retrieved) -> copy-and-update', () => {
    const state = sheetState({ status: 'not_retrieved' });
    assert.equal(resolveImportAction(null, state, REF_A, SOURCE_1).action, 'copy-and-update');
});

test('resolveImportAction: コピーなし・retrieved(外部URLのみ) -> cachedではないのでcopy-and-update', () => {
    const state = sheetState({ status: 'retrieved', url: 'https://example.com/paper.pdf' });
    assert.equal(resolveImportAction(null, state, REF_A, SOURCE_1).action, 'copy-and-update');
});

test('resolveImportAction: コピーなし・unavailable -> copy-and-update', () => {
    const state = sheetState({ status: 'unavailable' });
    assert.equal(resolveImportAction(null, state, REF_A, SOURCE_1).action, 'copy-and-update');
});

test('resolveImportAction: コピーなし・cached(他経路で確保済み)・クレーム無し -> 上書きしないのでconflict-keep', () => {
    const state = sheetState({ status: 'cached', url: 'https://drive.google.com/file/d/other/view' });
    assert.equal(resolveImportAction(null, state, REF_A, SOURCE_1).action, 'conflict-keep');
});

// --- コピーあり・refId一致 ---

test('resolveImportAction: コピーあり・refId一致・未反映 -> reuse-and-update（中断した取り込みの再開）', () => {
    const state = sheetState({ status: 'not_retrieved' });
    assert.equal(resolveImportAction(copyForA, state, REF_A, SOURCE_1).action, 'reuse-and-update');
});

test('resolveImportAction: コピーあり・refId一致・cachedかつURL一致 -> already-done（応答喪失後の再試行、matchedBy=url）', () => {
    const state = sheetState({ status: 'cached', url: copyForA.webViewLink });
    const result = resolveImportAction(copyForA, state, REF_A, SOURCE_1);
    assert.equal(result.action, 'already-done');
    assert.equal(result.matchedBy, 'url');
});

test('resolveImportAction: コピーあり・refId一致・cachedだがURL不一致・クレーム無し -> conflict-keep', () => {
    const state = sheetState({ status: 'cached', url: 'https://drive.google.com/file/d/someone-elses-copy/view' });
    assert.equal(resolveImportAction(copyForA, state, REF_A, SOURCE_1).action, 'conflict-keep');
});

// --- コピーあり・refId不一致（別Referenceへの対応付け） ---

test('resolveImportAction: コピーあり・refId不一致・未反映 -> 流用せずcopy-and-update（sourceFileId重複は許容）', () => {
    const state = sheetState({ status: 'not_retrieved' });
    assert.equal(resolveImportAction(copyForA, state, REF_B, SOURCE_1).action, 'copy-and-update');
});

test('resolveImportAction: コピーあり・refId不一致・cachedかつURLがそのコピーと一致 -> refId不一致でもURL一致ならalready-done', () => {
    // 実運用上は起こりにくいが、URL一致を最優先の判定材料とする設計（コメント参照）
    const state = sheetState({ status: 'cached', url: copyForA.webViewLink });
    assert.equal(resolveImportAction(copyForA, state, REF_B, SOURCE_1).action, 'already-done');
});

// --- appProperties.refId が無い孤立コピー ---

test('resolveImportAction: refId不明の既存コピー・未反映 -> 流用せずcopy-and-update', () => {
    const state = sheetState({ status: 'not_retrieved' });
    assert.equal(resolveImportAction(copyNoRefId, state, REF_A, SOURCE_1).action, 'copy-and-update');
});

test('resolveImportAction: refId不明の既存コピー・cachedかつURL一致 -> already-done', () => {
    const state = sheetState({ status: 'cached', url: copyNoRefId.webViewLink });
    assert.equal(resolveImportAction(copyNoRefId, state, REF_A, SOURCE_1).action, 'already-done');
});

// --- 実行直後（今作った/再利用したコピー）の事後検証を模したケース ---

test('resolveImportAction: 新規作成直後のコピーで再検証し、まだcachedでなければ更新に進む', () => {
    const justCreated: ImportedCopyMatch = { id: 'new1', webViewLink: 'https://drive.google.com/file/d/new1/view', refId: REF_A };
    const state = sheetState({ status: 'not_retrieved' });
    assert.equal(resolveImportAction(justCreated, state, REF_A, SOURCE_1).action, 'reuse-and-update');
});

test('resolveImportAction: 新規作成直後のコピーで再検証し、他ユーザーが先にcached済み(別実体・クレーム無し)ならconflict-keep', () => {
    const justCreated: ImportedCopyMatch = { id: 'new1', webViewLink: 'https://drive.google.com/file/d/new1/view', refId: REF_A };
    const state = sheetState({ status: 'cached', url: 'https://drive.google.com/file/d/someone-elses-copy/view' });
    assert.equal(resolveImportAction(justCreated, state, REF_A, SOURCE_1).action, 'conflict-keep');
});

// ---------------------------------------------------------------------------
// source-id 経由の already-done（Issue #73 Phase 2: 他人が取り込み済みのsourceを再実行）
// ---------------------------------------------------------------------------

test('resolveImportAction: 自分からはコピーが見えなくても、シートのクレームが有効かつsourceFileId一致ならalready-done（matchedBy=source-id）', () => {
    const state = sheetState({
        status: 'cached',
        url: 'https://drive.google.com/file/d/other-users-copy/view',
        sourceFileId: SOURCE_1,
        copyFileId: 'other-users-copy',
    });
    // existingCopy=null: drive.fileスコープでは他人が作成したコピーが見えない
    const result = resolveImportAction(null, state, REF_A, SOURCE_1);
    assert.equal(result.action, 'already-done');
    assert.equal(result.matchedBy, 'source-id');
});

test('resolveImportAction: 他人が取り込み済みのsourceを再実行 -> conflict-keepではなくalready-done（成功・no-op）になる（Issue#71症状1・2の解消）', () => {
    // 自分は今回このfile(SOURCE_1)を対象refへ取り込もうとしているが、既に別の実行で
    // 有効なクレームが記録済み。自分からはそのコピーは見えない(existingCopy=null)。
    const state = sheetState({
        status: 'cached',
        url: 'https://drive.google.com/file/d/teammates-copy/view',
        sourceFileId: SOURCE_1,
        copyFileId: 'teammates-copy',
    });
    const result = resolveImportAction(null, state, REF_A, SOURCE_1);
    assert.notEqual(result.action, 'conflict-keep');
    assert.equal(result.action, 'already-done');
});

test('resolveImportAction: url一致とsource-id一致が両方成立する場合はmatchedBy=urlを優先する', () => {
    const state = sheetState({
        status: 'cached',
        url: copyForA.webViewLink,
        sourceFileId: SOURCE_1,
        copyFileId: 'copy1', // extractDriveFileId(copyForA.webViewLink) === 'copy1' なので有効クレーム
    });
    const result = resolveImportAction(copyForA, state, REF_A, SOURCE_1);
    assert.equal(result.action, 'already-done');
    assert.equal(result.matchedBy, 'url', '両方成立時はurlを優先する（バックフィル判定がurlのときだけ行われるため）');
});

test('resolveImportAction: クレームが無効（copyIdがURL由来IDと食い違うstaleクレーム）なら source-id 一致でも already-done にならない', () => {
    // 旧版クライアントがT:Uだけ書いてW:Xをクリアしなかったケースを模す:
    // sourceFileIdは今回のsourceと一致しているが、urlから抽出できるファイルIDとcopyFileIdが食い違う
    const state = sheetState({
        status: 'cached',
        url: 'https://drive.google.com/file/d/some-other-pdf/view', // extractDriveFileId => 'some-other-pdf'
        sourceFileId: SOURCE_1,
        copyFileId: 'stale-copy-id', // 食い違い
    });
    const result = resolveImportAction(null, state, REF_A, SOURCE_1);
    assert.equal(result.action, 'conflict-keep', 'staleクレームはalready-doneの根拠にならない');
});

test('resolveImportAction: クレームは有効だがsourceFileIdが今回のsourceと異なる場合はalready-doneにならない', () => {
    const state = sheetState({
        status: 'cached',
        url: 'https://drive.google.com/file/d/other-copy/view',
        sourceFileId: SOURCE_2, // 今回のimportSourceFileId(SOURCE_1)とは別
        copyFileId: 'other-copy',
    });
    const result = resolveImportAction(null, state, REF_A, SOURCE_1);
    assert.equal(result.action, 'conflict-keep');
});

test('resolveImportAction: statusがcachedでなければクレーム有効条件を満たさずconflict-keepにならない（copy-and-updateに進む）', () => {
    const state = sheetState({
        status: 'retrieved', // cachedでない
        url: 'https://drive.google.com/file/d/some-copy/view',
        sourceFileId: SOURCE_1,
        copyFileId: 'some-copy',
    });
    // statusがcachedでない分岐なのでそもそもクレーム判定は通らず、cached分岐にも入らない
    assert.equal(resolveImportAction(null, state, REF_A, SOURCE_1).action, 'copy-and-update');
});

// ---------------------------------------------------------------------------
// shouldBackfillDriveColumns（バックフィル書き込み条件・純関数）
// ---------------------------------------------------------------------------

test('shouldBackfillDriveColumns: 3条件すべて一致・W/Xが空 -> true', () => {
    const state = sheetState({ status: 'cached', url: copyForA.webViewLink });
    assert.equal(shouldBackfillDriveColumns(REF_A, state, copyForA), true);
});

test('shouldBackfillDriveColumns: W/Xが既に埋まっている -> false（上書きしない）', () => {
    const state = sheetState({ status: 'cached', url: copyForA.webViewLink, sourceFileId: SOURCE_1 });
    assert.equal(shouldBackfillDriveColumns(REF_A, state, copyForA), false);
});

test('shouldBackfillDriveColumns: status !== cached -> false', () => {
    const state = sheetState({ status: 'retrieved', url: copyForA.webViewLink });
    assert.equal(shouldBackfillDriveColumns(REF_A, state, copyForA), false);
});

test('shouldBackfillDriveColumns: existingCopy.refId が対象refIdと不一致 -> false', () => {
    const state = sheetState({ status: 'cached', url: copyForA.webViewLink });
    assert.equal(shouldBackfillDriveColumns(REF_B, state, copyForA), false);
});

test('shouldBackfillDriveColumns: URLがexistingCopy.webViewLinkと不一致 -> false', () => {
    const state = sheetState({ status: 'cached', url: 'https://drive.google.com/file/d/different/view' });
    assert.equal(shouldBackfillDriveColumns(REF_A, state, copyForA), false);
});
