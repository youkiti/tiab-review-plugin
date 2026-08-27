import test from 'node:test';
import assert from 'node:assert/strict';
import { REFERENCES_HEADERS, buildReferenceInsertRow } from '../src/lib/sheets-api';
import type { Reference } from '../src/lib/types';

// Issue #118 チャンク1: References タブに record_type/related_ref_id を末尾追記したことの回帰テスト。
// - REFERENCES_HEADERS の末尾2列が record_type / related_ref_id であること（途中挿入していないこと）
// - addReferences() が組み立てる行（buildReferenceInsertRow）で、fulltext_* 系5列が空文字パディングされ、
//   record_type/related_ref_id が正しい index（24, 25）に載ること

test('REFERENCES_HEADERS: 末尾2列が record_type / related_ref_id であること', () => {
    const headers = REFERENCES_HEADERS;
    assert.equal(headers.length, 26, '既存24列 + 今回追加の2列 = 26列');
    assert.equal(headers[headers.length - 2], 'record_type');
    assert.equal(headers[headers.length - 1], 'related_ref_id');
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
    ]);
});
