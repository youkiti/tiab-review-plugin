import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDriveImportState } from '../src/lib/drive-import-classify';
import type { ImportedCopyMatch } from '../src/lib/drive-import-action';
import type { FulltextSourceClaim, ReferenceFulltextRowState } from '../src/lib/sheets-api';

// Issue #73 Phase 2 Step 4b: 表示用3値判定（純関数）のテスト。
// classifyDriveImportState(sourceFileId, claimsForSource, existingCopy, byRefId) の判定順:
//   1. claimsForSource に有効なクレームがあれば done（Drive検索の結果は不要）
//   2. Driveコピーのみ -> resolveImportAction 経由の判定（sheetStateは byRefId から引く。
//      claimsForSource ではなく byRefId を使う理由: claimsForSource は W列
//      （fulltext_drive_source_id）が非空の行しか含まれないため、本Issue修正前に
//      取り込まれた既存ファイル（W/X空）では sheetState が見つからず誤って incomplete に
//      なる退行を招く。byRefId は全行を対象にしているためこれを避けられる）
//   3. どちらも無ければ none

const SOURCE = 'source-1';

function claim(overrides: Partial<FulltextSourceClaim>): FulltextSourceClaim {
    return { refId: 'ref-x', copyId: 'copy-x', status: 'cached', url: 'https://drive.google.com/file/d/copy-x/view', ...overrides };
}

function rowState(overrides: Partial<ReferenceFulltextRowState>): ReferenceFulltextRowState {
    return { status: 'not_retrieved', url: '', sourceFileId: '', copyFileId: '', ...overrides };
}

/** byRefId は空のままでよいテスト用の既定値（判定順1のみを検証するテストで使う） */
const EMPTY_BY_REF_ID: Map<string, ReferenceFulltextRowState> = new Map();

test('classifyDriveImportState: 他人のクレーム（自分からはDriveコピーが見えない）でも有効なら done になる', () => {
    const validClaim = claim({ refId: 'ref-1', copyId: 'copy-1', url: 'https://drive.google.com/file/d/copy-1/view' });
    // existingCopy=null: drive.fileスコープでは他人が作成したコピーが自分からは見えない
    const result = classifyDriveImportState(SOURCE, [validClaim], null, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'done');
    assert.equal(result.existingCopy?.refId, 'ref-1', 'クレーム由来のrefIdがプリセットに使えること');
});

test('classifyDriveImportState: 同一sourceに複数クレームがあるケースでも、有効なクレームが1件あればdoneになる', () => {
    const staleClaim = claim({ refId: 'ref-1', copyId: 'stale', url: 'https://drive.google.com/file/d/different/view' }); // 無効(食い違い)
    const validClaim = claim({ refId: 'ref-2', copyId: 'copy-2', url: 'https://drive.google.com/file/d/copy-2/view' });
    const result = classifyDriveImportState(SOURCE, [staleClaim, validClaim], null, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'done');
    assert.equal(result.existingCopy?.refId, 'ref-2');
});

test('classifyDriveImportState: 担当外文献（stateには無いが全文献には在る）でもクレームがあればdoneになる（判定順1）', () => {
    // 判定は claims（全文献横断のクレーム配列）だけで完結し、state.references のような
    // 担当割り振り絞り込みには一切依存しない設計であることそのものを検証する。
    const claimForUnassignedRef = claim({ refId: 'ref-not-in-my-assignment', copyId: 'copy-9', url: 'https://drive.google.com/file/d/copy-9/view' });
    const result = classifyDriveImportState(SOURCE, [claimForUnassignedRef], null, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'done');
    assert.equal(result.existingCopy?.refId, 'ref-not-in-my-assignment');
});

test('classifyDriveImportState: 担当外文献でも、シートがcachedでURL一致なら done になる（判定順2でも担当絞り込みに依存しない）', () => {
    // クレーム（W/X）は無い（＝本Issue修正前に取り込まれた既存ファイルのケースと同じ状況）が、
    // byRefId（全行対象・担当割り振りに関わらず含む）にはこの ref の現在の行状態が入っている。
    const existingCopy: ImportedCopyMatch = {
        id: 'copy-unassigned', webViewLink: 'https://drive.google.com/file/d/copy-unassigned/view', refId: 'ref-not-in-my-assignment',
    };
    const byRefId = new Map([
        ['ref-not-in-my-assignment', rowState({ status: 'cached', url: existingCopy.webViewLink })],
    ]);
    const result = classifyDriveImportState(SOURCE, [], existingCopy, byRefId);
    assert.equal(result.state, 'done');
});

test('classifyDriveImportState: existingCopyがある場合はそちらを優先して返す（refIdが一致する場合）', () => {
    const validClaim = claim({ refId: 'ref-1', copyId: 'copy-1', url: 'https://drive.google.com/file/d/copy-1/view' });
    const existingCopy: ImportedCopyMatch = { id: 'copy-1', webViewLink: 'https://drive.google.com/file/d/copy-1/view', refId: 'ref-1' };
    const result = classifyDriveImportState(SOURCE, [validClaim], existingCopy, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'done');
    assert.equal(result.existingCopy, existingCopy);
});

// ---------------------------------------------------------------------------
// 判定順2（Driveコピーのみ・クレーム無し）のフォールバック
// ---------------------------------------------------------------------------

test('classifyDriveImportState [退行防止]: クレーム無し(W/X空)＋Driveコピーあり＋シートはcachedでURL一致 -> done'
    + '（本Issue修正前に取り込まれた既存ファイル全てが該当する。byRefIdをclaimsForSource由来にすると'
    + 'sheetStateが見つからずincompleteに誤表示される退行だった）', () => {
    const existingCopy: ImportedCopyMatch = {
        id: 'legacy-copy', webViewLink: 'https://drive.google.com/file/d/legacy-copy/view', refId: 'ref-1',
    };
    // claimsForSource は空（W/X列がまだ書かれていない旧取り込み）だが、byRefId には
    // その行の「今の」状態（cached・URL一致）が入っている
    const byRefId = new Map([
        ['ref-1', rowState({ status: 'cached', url: existingCopy.webViewLink })],
    ]);
    const result = classifyDriveImportState(SOURCE, [], existingCopy, byRefId);
    assert.equal(result.state, 'done');
});

test('classifyDriveImportState: クレーム無し(W/X空)＋Driveコピーあり＋シートはnot_retrieved -> incomplete（reuse-and-update相当）', () => {
    const existingCopy: ImportedCopyMatch = {
        id: 'new-copy', webViewLink: 'https://drive.google.com/file/d/new-copy/view', refId: 'ref-1',
    };
    const byRefId = new Map([
        ['ref-1', rowState({ status: 'not_retrieved', url: '' })],
    ]);
    const result = classifyDriveImportState(SOURCE, [], existingCopy, byRefId);
    assert.equal(result.state, 'incomplete');
});

test('classifyDriveImportState: クレーム無し＋Driveコピーあり＋その ref がシートに存在しない(行が削除された) -> incomplete', () => {
    const existingCopy: ImportedCopyMatch = {
        id: 'orphan-copy', webViewLink: 'https://drive.google.com/file/d/orphan-copy/view', refId: 'ref-deleted',
    };
    // byRefId に 'ref-deleted' のエントリが無い（Referencesの行が削除された想定）
    const result = classifyDriveImportState(SOURCE, [], existingCopy, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'incomplete');
});

test('classifyDriveImportState: クレームが無効なときはDrive側へフォールバックする（byRefIdの現在URLがexistingCopyと一致すればdone）', () => {
    const existingCopy: ImportedCopyMatch = {
        id: 'actual-copy', webViewLink: 'https://drive.google.com/file/d/actual-copy/view', refId: 'ref-1',
    };
    const staleClaim = claim({ refId: 'ref-1', copyId: 'stale', url: existingCopy.webViewLink, status: 'cached' });
    // staleClaim は copyId(stale) と url由来ID(actual-copy) が食い違うため無効（判定順1では不採用）
    const byRefId = new Map([
        ['ref-1', rowState({ status: 'cached', url: existingCopy.webViewLink, sourceFileId: SOURCE, copyFileId: 'stale' })],
    ]);
    const result = classifyDriveImportState(SOURCE, [staleClaim], existingCopy, byRefId);
    // resolveImportAction(existingCopy, sheetState={status:cached, url:actual-copyのURL, ...}, ...)
    // -> sheetState.url === existingCopy.webViewLink が成立するため already-done(matchedBy=url) -> done
    assert.equal(result.state, 'done');
});

test('classifyDriveImportState: クレームが無効かつDrive側もURL不一致ならincomplete（Drive検索ベースのフォールバック結果）', () => {
    const existingCopy: ImportedCopyMatch = {
        id: 'actual-copy', webViewLink: 'https://drive.google.com/file/d/actual-copy/view', refId: 'ref-1',
    };
    const staleClaim = claim({ refId: 'ref-1', copyId: 'stale', url: 'https://drive.google.com/file/d/some-old-url/view', status: 'cached' });
    const byRefId = new Map([
        ['ref-1', rowState({ status: 'cached', url: 'https://drive.google.com/file/d/some-old-url/view', sourceFileId: SOURCE, copyFileId: 'stale' })],
    ]);
    const result = classifyDriveImportState(SOURCE, [staleClaim], existingCopy, byRefId);
    assert.equal(result.state, 'incomplete');
});

test('classifyDriveImportState: クレーム無し・Driveコピーのrefが未設定(appProperties.refId欠落) -> incomplete', () => {
    const existingCopy: ImportedCopyMatch = { id: 'copy-orphan', webViewLink: 'https://drive.google.com/file/d/copy-orphan/view' };
    const result = classifyDriveImportState(SOURCE, [], existingCopy, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'incomplete');
});

test('classifyDriveImportState: クレームもDriveコピーも無ければnone', () => {
    const result = classifyDriveImportState(SOURCE, [], null, EMPTY_BY_REF_ID);
    assert.equal(result.state, 'none');
    assert.equal(result.existingCopy, undefined);
});
