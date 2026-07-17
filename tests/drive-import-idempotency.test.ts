import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportedCopyQuery } from '../src/lib/drive-api';

test('buildImportedCopyQuery: sourceFileId/spreadsheetId双方のappPropertiesとtrashed=falseをandで連結する', () => {
    const q = buildImportedCopyQuery('file123', 'sheet456');
    assert.equal(
        q,
        "appProperties has { key='sourceFileId' and value='file123' } and " +
        "appProperties has { key='spreadsheetId' and value='sheet456' } and trashed=false"
    );
});

test('buildImportedCopyQuery: has{...}の中括弧構文を保つ（Drive APIクエリ文法上必須）', () => {
    const q = buildImportedCopyQuery('a', 'b');
    assert.match(q, /appProperties has \{ key='sourceFileId' and value='a' \}/);
    assert.match(q, /appProperties has \{ key='spreadsheetId' and value='b' \}/);
    assert.match(q, /trashed=false$/);
});

test('buildImportedCopyQuery: 値に含まれるシングルクォート/バックスラッシュをエスケープする', () => {
    const q = buildImportedCopyQuery("id'with\\quote", 'sheet');
    // 入力の生文字: id ' with \ quote
    // 期待するエスケープ後: id \' with \\ quote （'は\'に、\は\\になる）
    const expected = "value='id\\'with\\\\quote'";
    assert.ok(q.includes(expected), `expected query to include ${JSON.stringify(expected)}, got ${q}`);
});

test('buildImportedCopyQuery: has{}を2つ・trashed=falseをandで連結し、orは使わない', () => {
    const q = buildImportedCopyQuery('x', 'y');
    // has{ key=... and value=... } の内側にも "and" が現れるため、
    // トップレベルの節数は "appProperties has {" の出現数 + trashed節で数える
    assert.equal((q.match(/appProperties has \{/g) ?? []).length, 2);
    assert.ok(q.endsWith('and trashed=false'));
    assert.equal(q.includes(' or '), false);
});
