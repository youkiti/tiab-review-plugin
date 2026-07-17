import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfPickerRedirect, validatePickedFiles, MAX_PICKED_FILES } from '../src/lib/drive-picker-result';

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/picker';

test('parsePdfPickerRedirect: files=<JSON> フラグメントを配列として取り出す', () => {
    const files = [{ id: '1', name: 'a.pdf', mimeType: 'application/pdf' }];
    const url = `${REDIRECT}#files=${encodeURIComponent(JSON.stringify(files))}`;
    const result = parsePdfPickerRedirect(url);
    assert.notEqual(result, null);
    assert.notEqual(result, 'cancelled');
    assert.deepEqual((result as { files: unknown[] }).files, files);
});

test('parsePdfPickerRedirect: cancelled=1 は "cancelled" を返す', () => {
    const result = parsePdfPickerRedirect(`${REDIRECT}#cancelled=1`);
    assert.equal(result, 'cancelled');
});

test('parsePdfPickerRedirect: filesもcancelledも無ければnull', () => {
    const result = parsePdfPickerRedirect(`${REDIRECT}#`);
    assert.equal(result, null);
});

test('parsePdfPickerRedirect: filesが不正なJSONならnull', () => {
    const result = parsePdfPickerRedirect(`${REDIRECT}#files=not-json`);
    assert.equal(result, null);
});

test('parsePdfPickerRedirect: filesが配列でないJSONならnull', () => {
    const url = `${REDIRECT}#files=${encodeURIComponent(JSON.stringify({ id: '1' }))}`;
    assert.equal(parsePdfPickerRedirect(url), null);
});

test('parsePdfPickerRedirect: URLとして解釈できない文字列はnull', () => {
    assert.equal(parsePdfPickerRedirect('not a url'), null);
});

test('validatePickedFiles: id/name/mimeTypeがすべてstringの要素のみ有効とする', () => {
    const raw: unknown[] = [
        { id: '1', name: 'a.pdf', mimeType: 'application/pdf' },
        { id: '2', name: 'b.pdf', mimeType: 'application/pdf' },
    ];
    const { valid, invalidCount, duplicateCount, overflowCount } = validatePickedFiles(raw);
    assert.equal(valid.length, 2);
    assert.equal(invalidCount, 0);
    assert.equal(duplicateCount, 0);
    assert.equal(overflowCount, 0);
});

test('validatePickedFiles: 形状不正な要素は除外してカウントする（1件の不正で全体を捨てない）', () => {
    const raw: unknown[] = [
        { id: '1', name: 'a.pdf', mimeType: 'application/pdf' }, // 妥当
        { id: '2', name: 'b.pdf' },                              // mimeType欠落
        { id: 3, name: 'c.pdf', mimeType: 'application/pdf' },   // idが数値
        null,                                                    // オブジェクトでない
        'string-value',                                          // オブジェクトでない
        { id: '', name: 'd.pdf', mimeType: 'application/pdf' },  // id空文字
    ];
    const { valid, invalidCount } = validatePickedFiles(raw);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].id, '1');
    assert.equal(invalidCount, 5);
});

test('validatePickedFiles: 同一idの重複は1件にまとめてduplicateCountで数える', () => {
    const raw: unknown[] = [
        { id: '1', name: 'a.pdf', mimeType: 'application/pdf' },
        { id: '1', name: 'a-dup.pdf', mimeType: 'application/pdf' },
        { id: '2', name: 'b.pdf', mimeType: 'application/pdf' },
        { id: '1', name: 'a-dup2.pdf', mimeType: 'application/pdf' },
    ];
    const { valid, duplicateCount } = validatePickedFiles(raw);
    assert.equal(valid.length, 2);
    assert.deepEqual(valid.map(f => f.id), ['1', '2']);
    // 最初に出現した要素を採用する
    assert.equal(valid[0].name, 'a.pdf');
    assert.equal(duplicateCount, 2);
});

test('validatePickedFiles: MAX_PICKED_FILES件を超えた分は切り捨ててoverflowCountで数える', () => {
    const raw: unknown[] = Array.from({ length: MAX_PICKED_FILES + 5 }, (_, i) => ({
        id: `id-${i}`, name: `file-${i}.pdf`, mimeType: 'application/pdf',
    }));
    const { valid, overflowCount, invalidCount, duplicateCount } = validatePickedFiles(raw);
    assert.equal(valid.length, MAX_PICKED_FILES);
    assert.equal(overflowCount, 5);
    assert.equal(invalidCount, 0);
    assert.equal(duplicateCount, 0);
});

test('validatePickedFiles: 重複除去後にMAX_PICKED_FILES以下になればoverflowは発生しない', () => {
    const raw: unknown[] = [
        ...Array.from({ length: MAX_PICKED_FILES }, (_, i) => ({ id: `id-${i}`, name: `f${i}.pdf`, mimeType: 'application/pdf' })),
        { id: 'id-0', name: 'dup.pdf', mimeType: 'application/pdf' }, // 既存idの重複（超過分ではない）
    ];
    const { valid, overflowCount, duplicateCount } = validatePickedFiles(raw);
    assert.equal(valid.length, MAX_PICKED_FILES);
    assert.equal(duplicateCount, 1);
    assert.equal(overflowCount, 0);
});

test('validatePickedFiles: 空配列は全カウント0', () => {
    const { valid, invalidCount, duplicateCount, overflowCount } = validatePickedFiles([]);
    assert.equal(valid.length, 0);
    assert.equal(invalidCount, 0);
    assert.equal(duplicateCount, 0);
    assert.equal(overflowCount, 0);
});
