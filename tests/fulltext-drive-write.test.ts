import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFulltextUrlUpdateData,
    validateFulltextDriveHeaders,
} from '../src/lib/fulltext-drive-write';
import type { FulltextUrlUpdateEntry } from '../src/lib/fulltext-drive-write';

// Issue #73 Phase 2（データ層チャンク）の純関数テスト。
// - buildFulltextUrlUpdateData: T:U と W:X の2レンジ生成、V列に触れないこと、
//   driveSource: null で W/X が空文字になること、行解決に失敗した ref の除外、
//   includeDriveColumns=false で T:U のみになること
// - validateFulltextDriveHeaders: W/X 空 / 期待名一致 / 別名（ユーザー独自列）の3ケース
//   （メッセージは持たず、実際のヘッダー名だけを返す。文言はUI側 i18n の責務）

test('buildFulltextUrlUpdateData: includeDriveColumns=true では1エントリにつき T:U と W:X の2つの非連続レンジを生成する', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        {
            refId: 'ref1',
            fulltextUrl: 'https://drive.google.com/file/d/copy-1/view',
            status: 'cached',
            driveSource: { sourceFileId: 'source-1', copyFileId: 'copy-1' },
        },
    ];
    const rowByRefId = new Map([['ref1', 5]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', true);

    assert.equal(data.length, 2);
    assert.deepEqual(data[0], {
        range: 'References!T5:U5',
        values: [['https://drive.google.com/file/d/copy-1/view', 'cached']],
    });
    assert.deepEqual(data[1], {
        range: 'References!W5:X5',
        values: [['source-1', 'copy-1']],
    });
});

test('buildFulltextUrlUpdateData: includeDriveColumns=false では T:U のみが返り、W:X は生成されない', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        { refId: 'ref1', fulltextUrl: 'url1', status: 'cached', driveSource: null },
        { refId: 'ref2', fulltextUrl: 'url2', status: 'retrieved', driveSource: null },
    ];
    const rowByRefId = new Map([['ref1', 2], ['ref2', 3]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', false);

    assert.equal(data.length, 2, '2エントリ × T:Uのみ = 2件');
    assert.deepEqual(data[0], { range: 'References!T2:U2', values: [['url1', 'cached']] });
    assert.deepEqual(data[1], { range: 'References!T3:U3', values: [['url2', 'retrieved']] });
    assert.ok(data.every((d) => !d.range.includes('W') && !d.range.includes('X')), 'W/X レンジが1件も含まれないこと');
});

test('buildFulltextUrlUpdateData: 生成されるレンジはV列を含まない（T:Xの連続レンジにしない）', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        { refId: 'ref1', fulltextUrl: 'url', status: 'cached', driveSource: null },
    ];
    const rowByRefId = new Map([['ref1', 3]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', true);

    for (const update of data) {
        assert.ok(!update.range.includes('V'), `V列を含むレンジが生成された: ${update.range}`);
        assert.notEqual(update.range, 'References!T3:X3', 'T:X の連続レンジになっていないこと');
    }
});

test('buildFulltextUrlUpdateData: driveSource が null のとき W/X の値は空文字になる（クリア）', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        { refId: 'ref1', fulltextUrl: '', status: 'not_retrieved', driveSource: null },
    ];
    const rowByRefId = new Map([['ref1', 7]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', true);
    const wxUpdate = data.find((d) => d.range.startsWith('References!W'));

    assert.ok(wxUpdate, 'W:X レンジが省略されず生成されること（クリアとして書く）');
    assert.deepEqual(wxUpdate!.values, [['', '']]);
});

test('buildFulltextUrlUpdateData: 行番号解決に失敗した ref は結果から除外される', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        { refId: 'ref-found', fulltextUrl: 'url', status: 'cached', driveSource: null },
        { refId: 'ref-missing', fulltextUrl: 'url', status: 'cached', driveSource: null },
    ];
    const rowByRefId = new Map([['ref-found', 2]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', true);

    assert.equal(data.length, 2, '見つかった1件分（T:U + W:X）のみ生成されること');
    assert.ok(data.every((d) => d.range.includes('2')));
});

test('buildFulltextUrlUpdateData: 複数エントリを渡すと件数分だけレンジが積まれる', () => {
    const entries: FulltextUrlUpdateEntry[] = [
        { refId: 'ref1', fulltextUrl: 'url1', status: 'cached', driveSource: null },
        { refId: 'ref2', fulltextUrl: 'url2', status: 'retrieved', driveSource: { sourceFileId: 's2', copyFileId: 'c2' } },
    ];
    const rowByRefId = new Map([['ref1', 2], ['ref2', 3]]);

    const data = buildFulltextUrlUpdateData(entries, rowByRefId, 'References', true);

    assert.equal(data.length, 4, '2エントリ × 2レンジ = 4件');
});

// ---------------------------------------------------------------------------
// validateFulltextDriveHeaders
// ---------------------------------------------------------------------------

test('validateFulltextDriveHeaders: W/X が空文字（未使用）なら ok', () => {
    const headers = Array(24).fill('');
    headers[0] = 'ref_id';
    const result = validateFulltextDriveHeaders(headers);
    assert.equal(result.ok, true);
    assert.equal(result.actualW, '');
    assert.equal(result.actualX, '');
});

test('validateFulltextDriveHeaders: W/X が期待名と一致すれば ok', () => {
    const headers = Array(24).fill('');
    headers[22] = 'fulltext_drive_source_id';
    headers[23] = 'fulltext_drive_copy_id';
    const result = validateFulltextDriveHeaders(headers);
    assert.equal(result.ok, true);
    assert.equal(result.actualW, 'fulltext_drive_source_id');
    assert.equal(result.actualX, 'fulltext_drive_copy_id');
});

test('validateFulltextDriveHeaders: W/X がユーザー独自の別名なら ok=false で実際のヘッダー名を返す（メッセージは持たない）', () => {
    const headers = Array(24).fill('');
    headers[22] = 'my_custom_column';
    headers[23] = 'another_custom_column';
    const result = validateFulltextDriveHeaders(headers);
    assert.equal(result.ok, false);
    assert.equal(result.actualW, 'my_custom_column');
    assert.equal(result.actualX, 'another_custom_column');
    assert.ok(!('message' in result), 'ユーザー向け文言は純関数側で組み立てないこと（i18n はUI側の責務）');
});

test('validateFulltextDriveHeaders: W だけ別名でも ok=false になる', () => {
    const headers = Array(24).fill('');
    headers[22] = 'my_custom_column';
    headers[23] = 'fulltext_drive_copy_id';
    const result = validateFulltextDriveHeaders(headers);
    assert.equal(result.ok, false);
    assert.equal(result.actualW, 'my_custom_column');
    assert.equal(result.actualX, 'fulltext_drive_copy_id');
});

test('validateFulltextDriveHeaders: ヘッダー行がW/X列に満たない短い配列でも ok（空扱い）', () => {
    const headers = ['ref_id', 'title'];
    const result = validateFulltextDriveHeaders(headers);
    assert.equal(result.ok, true);
    assert.equal(result.actualW, '');
    assert.equal(result.actualX, '');
});
