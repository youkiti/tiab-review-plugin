import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// KNOWN_ISSUES.md の軽い形式検査。process.cwd()（リポジトリ直下）から読む。
const text = readFileSync(join(process.cwd(), 'KNOWN_ISSUES.md'), 'utf8');
const APPENDIX_HEADING = '## 付録: 版とコミットの対応 / Appendix: versions and commits';

const appendixStart = text.indexOf(APPENDIX_HEADING);
const mainPart = appendixStart >= 0 ? text.slice(0, appendixStart) : text;
const appendixPart = appendixStart >= 0 ? text.slice(appendixStart) : '';

// 一覧表の行（先頭セルが KI-NNN）。
const tableRows = mainPart
    .split('\n')
    .filter((line) => /^\| KI-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

test('付録の見出しがある', () => {
    assert.ok(appendixStart >= 0);
});

test('一覧表: ID が KI-NNN で重複せず、7列ある', () => {
    assert.ok(tableRows.length > 0);
    const ids = tableRows.map((row) => row[0]);
    for (const id of ids) assert.match(id, /^KI-\d{3}$/);
    assert.equal(new Set(ids).size, ids.length);
    for (const row of tableRows) assert.equal(row.length, 7);
});

test('一覧表: 修正版の欄が vX.Y.Z・未リリース・未修正のどれかで始まる', () => {
    for (const row of tableRows) {
        assert.match(row[5], /^(v\d+\.\d+\.\d+|未リリース|未修正)/, `${row[0]} の修正版: ${row[5]}`);
    }
});

test('一覧表にある ID ごとに「### KI-NNN」の節がある', () => {
    for (const row of tableRows) {
        assert.match(mainPart, new RegExp(`^### ${row[0]}( |$)`, 'm'), `${row[0]} の節が無い`);
    }
});

test('付録: 版が重複せず、先頭が v0.1.0・末尾が v0.57.2、コミットが7桁以上の16進数', () => {
    const rows = appendixPart
        .split('\n')
        .filter((line) => /^\| v\d/.test(line))
        .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    assert.ok(rows.length > 0);
    const versions = rows.map((row) => row[0]);
    assert.equal(new Set(versions).size, versions.length);
    assert.equal(versions[0], 'v0.1.0');
    assert.equal(versions[versions.length - 1], 'v0.57.2');
    for (const row of rows) assert.match(row[1], /^[0-9a-f]{7,}$/, `${row[0]} のコミット: ${row[1]}`);
});
