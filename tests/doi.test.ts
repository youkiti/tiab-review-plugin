import test from 'node:test';
import assert from 'node:assert/strict';
import { stripDoiPrefix } from '../src/lib/doi';

// PR #146 レビュー指摘: duplicate-detect.ts と pdf-title-match.ts が別々の接頭辞剥がし
// 正規表現を持っていたため、http://doi.org/ と https://dx.doi.org/ の2形式を片方だけが
// 取りこぼしていた。共有関数 stripDoiPrefix() が4形式すべてを剥がすことを固定する。

test('stripDoiPrefix: https://doi.org/ の接頭辞を剥がす', () => {
    assert.equal(stripDoiPrefix('https://doi.org/10.1002/art.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: http://doi.org/ の接頭辞を剥がす', () => {
    assert.equal(stripDoiPrefix('http://doi.org/10.1002/art.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: https://dx.doi.org/ の接頭辞を剥がす', () => {
    assert.equal(stripDoiPrefix('https://dx.doi.org/10.1002/art.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: http://dx.doi.org/ の接頭辞を剥がす', () => {
    assert.equal(stripDoiPrefix('http://dx.doi.org/10.1002/art.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: doi: 接頭辞を剥がす', () => {
    assert.equal(stripDoiPrefix('doi:10.1002/art.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: 接頭辞なしはそのまま（小文字化のみ）', () => {
    assert.equal(stripDoiPrefix('10.1002/ART.41108'), '10.1002/art.41108');
});

test('stripDoiPrefix: 検証はしない。DOIの形をしていない値もそのまま返る', () => {
    assert.equal(stripDoiPrefix('e98323'), 'e98323');
});

test('stripDoiPrefix: 前後の空白はtrimされる', () => {
    assert.equal(stripDoiPrefix('  https://doi.org/10.1002/art.41108  '), '10.1002/art.41108');
});
