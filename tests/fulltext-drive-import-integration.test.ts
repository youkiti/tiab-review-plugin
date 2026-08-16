/**
 * PR #105（Issue #73 Phase 2）実機確認の代替となる結合テスト。
 *
 * 手書きの fetch フェイクではなく、デモモードのインメモリ Sheets ストア
 * （src/demo/sheet-store.ts、A1レンジを実際にパースして読み書きする）と
 * fetch モック（src/demo/fetch-mock.ts）へ本物の sheets-api.ts を接続し、
 * 「既存プロジェクトを開いてDrive取り込みを実行する」流れをそのまま走らせる。
 *
 * 確認したいのは PR 本文が実機確認を求めている2点、および回帰修正
 * （ensureHeaders の W/X ヘッダー保護）の3点目:
 *   1. 既存22列プロジェクトで References に W/X 列が追記され、既存の判定・担当割り振り（V列）が壊れない
 *   2. Drive 直接取り込み後、別アカウント（＝Drive検索が空を返す視点）から「取り込み済み」と判定される
 *   3. ユーザーが独自の23/24列目を足していた既存プロジェクトでは、ensureHeaders がその列名・データを
 *      改名/上書きせず保持する（Drive直接取り込みは fail-fast、それ以外の経路は T:U のみ書いて続行する）
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getReferences,
    getFulltextClaimsSnapshot,
    updateReferenceFulltextUrl,
    updateReferenceFulltextSets,
    invalidateFulltextDriveColumnsMemo,
} from '../src/lib/sheets-api';
import { classifyDriveImportState } from '../src/lib/drive-import-classify';
import { resolveImportAction } from '../src/lib/drive-import-action';
import { installDemoFetchMock } from '../src/demo/fetch-mock';
import { resetDemoStore, readRange } from '../src/demo/sheet-store';
import { DEMO_SPREADSHEET_ID } from '../src/demo/constants';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';

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
installDemoFetchMock();

/** PR 適用前（22列）の References ヘッダー */
const OLD_HEADERS_22 = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
];

const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
];

const COPY_A_ID = '1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SOURCE_A_ID = '1SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS';
const copyUrl = (id: string) => `https://drive.google.com/file/d/${id}/view`;

/** 22列の既存プロジェクトを模したストアを用意する（V列＝担当割り振りは全行に入っている） */
function seedLegacyProject(): void {
    const row = (n: number, ftUrl: string, ftStatus: string, ftSet: string): string[] => {
        const r = new Array(22).fill('');
        r[0] = `ref-${n}`;
        r[1] = `Title ${n}`;
        r[2] = `Abstract ${n}`;
        r[3] = '2024';
        r[11] = `1000000${n}`;
        r[18] = 'set-1';        // S列 screening_set
        r[19] = ftUrl;          // T列 fulltext_url
        r[20] = ftStatus;       // U列 fulltext_status
        r[21] = ftSet;          // V列 fulltext_set（担当割り振り）
        return r;
    };
    resetDemoStore('PR105 legacy project', {
        References: [
            OLD_HEADERS_22,
            row(1, '', 'not_retrieved', 'ft-group-1'),
            row(2, 'https://example.org/oa/2.pdf', 'retrieved', 'ft-group-2'),
            // 旧クライアントが Drive 取り込み済み（T:U だけ書かれている＝未バックフィル分）
            row(3, copyUrl('1LEGACYLEGACYLEGACYLEGACYLEGACYLE'), 'cached', 'ft-group-1'),
        ],
        Decisions: [
            DECISIONS_HEADERS,
            ['d1', 'ref-1', 'a@example.com', 'include', '', '', '', '2026-01-01T00:00:00Z', '0.30.0-human', '', 'tiab'],
            ['d2', 'ref-3', 'b@example.com', 'exclude', 'PICOミスマッチ', '', '', '2026-01-02T00:00:00Z', '0.30.0-human', '', 'fulltext'],
        ],
    });
    invalidateFulltextDriveColumnsMemo();
}

function referencesRows(): string[][] {
    return readRange('References!A1:Z100') ?? [];
}

// ---------------------------------------------------------------------------
// 確認1: 既存22列プロジェクトへの W/X 追記と、V列・判定の非破壊
// ---------------------------------------------------------------------------

test('確認1-a: 既存22列シートへDrive直接取り込みするとW/Xが追記され、V列(fulltext_set)は全行そのまま', async () => {
    seedLegacyProject();

    const before = referencesRows();
    assert.equal(before[0].length, 22, '前提: 移行前のヘッダーは22列');

    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    const after = referencesRows();

    // ヘッダーが24列へ拡張され、末尾2列が期待名になっている
    assert.equal(after[0][22], 'fulltext_drive_source_id');
    assert.equal(after[0][23], 'fulltext_drive_copy_id');
    assert.deepEqual(after[0].slice(0, 22), OLD_HEADERS_22, 'A〜V列のヘッダー名は不変');

    // 対象行の T/U/W/X
    assert.equal(after[1][19], copyUrl(COPY_A_ID));
    assert.equal(after[1][20], 'cached');
    assert.equal(after[1][22], SOURCE_A_ID);
    assert.equal(after[1][23], COPY_A_ID);

    // V列（担当割り振り）は全行そのまま
    assert.equal(after[1][21], 'ft-group-1');
    assert.equal(after[2][21], 'ft-group-2');
    assert.equal(after[3][21], 'ft-group-1');

    // 触っていない行の T/U も不変
    assert.equal(after[2][19], 'https://example.org/oa/2.pdf');
    assert.equal(after[2][20], 'retrieved');
    assert.equal(after[3][20], 'cached');

    // Decisions（判定ログ）は無傷
    const decisions = readRange('Decisions!A1:K100') ?? [];
    assert.equal(decisions.length, 3);
    assert.equal(decisions[2][4], 'PICOミスマッチ');
});

test('確認1-b: 移行後も getReferences が fulltext_set と新2列を正しく読める', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    const refs = await getReferences(DEMO_SPREADSHEET_ID);
    assert.equal(refs.length, 3);
    assert.equal(refs[0].fulltext_set, 'ft-group-1');
    assert.equal(refs[1].fulltext_set, 'ft-group-2');
    assert.equal(refs[2].fulltext_set, 'ft-group-1');
    assert.equal(refs[0].fulltext_drive_source_id, SOURCE_A_ID);
    assert.equal(refs[0].fulltext_drive_copy_id, COPY_A_ID);
    assert.equal(refs[1].fulltext_drive_source_id, undefined);
});

test('確認1-c: 取り込み後にフルテキスト担当割り振り(V列)を更新してもW/Xは壊れない（逆も同様）', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    await updateReferenceFulltextSets(DEMO_SPREADSHEET_ID, [
        { refId: 'ref-1', fulltextSet: 'ft-group-9' },
        { refId: 'ref-2', fulltextSet: 'ft-group-9' },
    ]);

    const after = referencesRows();
    assert.equal(after[1][21], 'ft-group-9', 'V列は更新される');
    assert.equal(after[1][22], SOURCE_A_ID, 'W列は担当更新で消えない');
    assert.equal(after[1][23], COPY_A_ID, 'X列は担当更新で消えない');

    // 逆順: 担当更新のあとにOA取得（driveSource=null）でW/Xがクリアされ、V列は残る
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', 'https://example.org/oa/1.pdf', 'retrieved', null
    );
    const after2 = referencesRows();
    assert.equal(after2[1][21], 'ft-group-9', 'V列はOA更新で消えない');
    assert.equal(after2[1][22], '', 'W列はDrive取り込み以外の経路でクリアされる');
    assert.equal(after2[1][23], '', 'X列も同様');
});

// ---------------------------------------------------------------------------
// 確認2: 別アカウント（Drive検索が空を返す視点）からの「取り込み済み」判定
// ---------------------------------------------------------------------------

test('確認2-a: 取り込み後、Driveコピーが見えない別アカウント視点でも done になる', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    // 別アカウント: Picker で同じ source PDF を選び直した直後にスナップショットを取得する
    const snapshot = await getFulltextClaimsSnapshot(DEMO_SPREADSHEET_ID);
    const claims = snapshot.bySourceId.get(SOURCE_A_ID) ?? [];
    assert.equal(claims.length, 1);
    assert.equal(claims[0].refId, 'ref-1');

    // drive.file スコープのため findImportedCopy は null（＝他人のコピーは見えない）
    const classification = classifyDriveImportState(SOURCE_A_ID, claims, null, snapshot.byRefId);
    assert.equal(classification.state, 'done');
    assert.equal(classification.existingCopy?.refId, 'ref-1');
    assert.equal(classification.existingCopy?.id, COPY_A_ID);
});

test('確認2-b: 別アカウントが実行フェーズまで進んでも already-done(source-id) で新規コピーを作らない', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    const snapshot = await getFulltextClaimsSnapshot(DEMO_SPREADSHEET_ID);
    const sheetState = snapshot.byRefId.get('ref-1');
    assert.ok(sheetState);
    const resolved = resolveImportAction(null, sheetState, 'ref-1', SOURCE_A_ID);
    assert.equal(resolved.action, 'already-done');
    assert.equal(resolved.matchedBy, 'source-id');
});

test('確認2-c: 未取り込みの別PDFは none のまま（誤って done にならない）', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    const snapshot = await getFulltextClaimsSnapshot(DEMO_SPREADSHEET_ID);
    const other = classifyDriveImportState('1OTHEROTHEROTHEROTHEROTHEROTHEROT', [], null, snapshot.byRefId);
    assert.equal(other.state, 'none');
});

test('確認2-d: 未バックフィルの旧取り込み分（W/X空）は従来どおり別アカウントからは none', async () => {
    seedLegacyProject();
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
        { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
    );

    // ref-3 は cached だが W/X が空（旧クライアントの取り込み）
    const snapshot = await getFulltextClaimsSnapshot(DEMO_SPREADSHEET_ID);
    const ref3 = snapshot.byRefId.get('ref-3');
    assert.equal(ref3?.status, 'cached');
    assert.equal(ref3?.sourceFileId, '');

    const legacySource = '1LEGACYSOURCELEGACYSOURCELEGACYSO';
    const result = classifyDriveImportState(legacySource, [], null, snapshot.byRefId);
    assert.equal(result.state, 'none', '未バックフィル分は移行されるまで従来どおり');
});

// ---------------------------------------------------------------------------
// 確認3: ユーザーが独自の23/24列目を足していた既存プロジェクト（ensureHeaders 回帰修正）
// ---------------------------------------------------------------------------

test('確認3-a: 独自列が23列目(W1のみ)にある場合、Drive直接取り込みはthrowし、ヘッダー名・W列データが保持される', async () => {
    const row = (n: number, memo: string): string[] => {
        const r = new Array(23).fill('');
        r[0] = `ref-${n}`;
        r[1] = `Title ${n}`;
        r[20] = 'not_retrieved';
        r[21] = 'ft-group-1';
        r[22] = memo;   // W列にユーザー独自データ
        return r;
    };
    resetDemoStore('PR105 custom column project', {
        References: [
            [...OLD_HEADERS_22, 'my_memo'],
            row(1, 'ユーザーの大事なメモ1'),
            row(2, 'ユーザーの大事なメモ2'),
        ],
        Decisions: [DECISIONS_HEADERS],
    });
    invalidateFulltextDriveColumnsMemo();

    await assert.rejects(
        updateReferenceFulltextUrl(
            DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
            { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
        ),
        'Drive直接取り込みはW/X列がユーザー独自列と衝突しているためfail-fastでthrowすること'
    );

    const after = referencesRows();
    assert.equal(after[0][22], 'my_memo', 'W1のユーザー独自ヘッダー名がensureHeadersに改名されないこと');
    assert.equal(after[1][22], 'ユーザーの大事なメモ1', 'ref-1のW列データが上書きされず元のままであること');
    assert.equal(after[2][22], 'ユーザーの大事なメモ2', 'ref-2のW列データも元のままであること');
});

test('確認3-b: 独自列が23・24列目にある場合、Drive直接取り込みはthrowするがOA経路(driveSource=null)は成功し独自列が保持される', async () => {
    const row = (n: number): string[] => {
        const r = new Array(24).fill('');
        r[0] = `ref-${n}`;
        r[20] = 'not_retrieved';
        r[21] = 'ft-group-1';
        r[22] = `メモ${n}`;
        r[23] = `タグ${n}`;
        return r;
    };
    resetDemoStore('PR105 custom 2 columns', {
        References: [
            [...OLD_HEADERS_22, 'my_memo', 'my_tag'],
            row(1),
            row(2),
        ],
        Decisions: [DECISIONS_HEADERS],
    });
    invalidateFulltextDriveColumnsMemo();

    await assert.rejects(
        updateReferenceFulltextUrl(
            DEMO_SPREADSHEET_ID, 'ref-1', copyUrl(COPY_A_ID), 'cached',
            { sourceFileId: SOURCE_A_ID, copyFileId: COPY_A_ID }
        ),
        'Drive直接取り込みはW/X列がユーザー独自列と衝突しているためfail-fastでthrowすること'
    );

    // OA検索（driveSource=null）は T:U だけ書いて続行できること
    await updateReferenceFulltextUrl(
        DEMO_SPREADSHEET_ID, 'ref-2', 'https://example.org/oa/2.pdf', 'retrieved', null
    );
    const after = referencesRows();
    assert.equal(after[0][22], 'my_memo', 'W1のユーザー独自ヘッダー名は保持される');
    assert.equal(after[0][23], 'my_tag', 'X1のユーザー独自ヘッダー名も保持される');
    assert.equal(after[2][19], 'https://example.org/oa/2.pdf', 'OA経路はブロックされない');
    assert.equal(after[2][22], 'メモ2', 'ユーザー独自W列は保持される');
    assert.equal(after[2][23], 'タグ2', 'ユーザー独自X列は保持される');
});
