import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERENCES_HEADERS, buildReferenceInsertRow } from '../src/lib/sheets-api';
import type { Reference } from '../src/lib/types';

// Issue #118 チャンク1: References タブに record_type/related_ref_id を末尾追記したことの回帰テスト。
// Issue #145 チャンク2: 上記に続けて duplicate_of（重複の論理削除フラグ）を末尾追記したことの回帰テストも
// 同じファイルへ足す（このファイルが「列追加時のドリフト検出テスト」の前例のため）。
// - REFERENCES_HEADERS の末尾3列が record_type / related_ref_id / duplicate_of であること（途中挿入していないこと）
// - addReferences() が組み立てる行（buildReferenceInsertRow）で、fulltext_* 系5列が空文字パディングされ、
//   record_type/related_ref_id/duplicate_of が正しい index（24, 25, 26）に載ること

test('REFERENCES_HEADERS: record_type / related_ref_id が index 24/25、duplicate_of が末尾（index 26）であること', () => {
    const headers = REFERENCES_HEADERS;
    // 既存24列 + record_type/related_ref_id（Issue #118 チャンク1） + duplicate_of（Issue #145 チャンク2）= 27列
    assert.equal(headers.length, 27);
    assert.equal(headers[24], 'record_type');
    assert.equal(headers[25], 'related_ref_id');
    assert.equal(headers[26], 'duplicate_of');
    // 既存の並びは不変（途中挿入していないこと）
    assert.deepEqual(headers.slice(0, 24), [
        'ref_id', 'title', 'abstract', 'year', 'authors',
        'journal', 'volume', 'issue', 'pages', 'issn',
        'doi', 'pmid', 'url', 'source',
        'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
        'fulltext_url', 'fulltext_status', 'fulltext_set',
        'fulltext_drive_source_id', 'fulltext_drive_copy_id',
    ]);
});

function makeReference(overrides: Partial<Reference> = {}): Reference {
    return {
        ref_id: 'ref-1',
        title: 'Sample Title',
        ...overrides,
    };
}

test('buildReferenceInsertRow: 行の長さが REFERENCES_HEADERS と一致する', () => {
    const row = buildReferenceInsertRow(makeReference());
    assert.equal(row.length, REFERENCES_HEADERS.length);
});

test('buildReferenceInsertRow: fulltext_* 系5列（index 19〜23）は常に空文字でパディングされる', () => {
    const row = buildReferenceInsertRow(makeReference());
    // index 19: fulltext_url, 20: fulltext_status, 21: fulltext_set,
    // 22: fulltext_drive_source_id, 23: fulltext_drive_copy_id
    assert.deepEqual(row.slice(19, 24), ['', '', '', '', '']);
});

test('buildReferenceInsertRow: record_type/related_ref_id が index 24/25 に正しく載る', () => {
    const row = buildReferenceInsertRow(makeReference({
        record_type: 'registration',
        related_ref_id: 'ref-2',
    }));
    assert.equal(row[24], 'registration');
    assert.equal(row[25], 'ref-2');
});

test('buildReferenceInsertRow: record_type/related_ref_id 未設定なら空文字（後方互換のarticle相当）', () => {
    const row = buildReferenceInsertRow(makeReference());
    assert.equal(row[24], '');
    assert.equal(row[25], '');
});

test('buildReferenceInsertRow: duplicate_of が index 26 に正しく載る（Issue #145 チャンク2）', () => {
    const row = buildReferenceInsertRow(makeReference({ duplicate_of: 'ref-keep' }));
    assert.equal(row[26], 'ref-keep');
});

test('buildReferenceInsertRow: duplicate_of 未設定なら空文字', () => {
    const row = buildReferenceInsertRow(makeReference());
    assert.equal(row[26], '');
});

test('buildReferenceInsertRow: 既存フィールド（screening_setまで）の位置は従来どおり', () => {
    const row = buildReferenceInsertRow(makeReference({
        abstract: 'Abstract text',
        year: 2024,
        authors: 'Doe J',
        journal: 'NEJM',
        volume: '1',
        issue: '2',
        pages: '3-4',
        issn: '0000-0000',
        doi: '10.1000/xyz',
        pmid: '12345',
        url: 'https://example.com',
        source: 'PubMed',
        imported_at: '2026-01-01T00:00:00Z',
        imported_by: 'a@example.com',
        dedupe_key: 'pmid:12345',
        source_file: 'sample.nbib',
        screening_set: 'set-1',
    }));

    assert.deepEqual(row, [
        'ref-1', 'Sample Title', 'Abstract text', '2024', 'Doe J',
        'NEJM', '1', '2', '3-4', '0000-0000',
        '10.1000/xyz', '12345', 'https://example.com', 'PubMed',
        '2026-01-01T00:00:00Z', 'a@example.com', 'pmid:12345', 'sample.nbib', 'set-1',
        '', '', '', '', '',
        '', '',
        '',
    ]);
});
