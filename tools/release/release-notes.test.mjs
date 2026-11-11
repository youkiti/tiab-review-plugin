import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChangelogSection, readConceptDoi, buildReleaseNotes } from './release-notes.mjs';

const changelog = [
  '# 変更履歴 / Changelog', '', '前文', '',
  '## v0.57.3（2026-11-12）', '', '### 画面 / Interface', '', '- 新しい変更', '  A new change', '',
  '## v0.57.2（2026-11-09）', '', '- 前の変更', '',
  '## v0.57.1（2026-11-07）', '', '- さらに前', '',
].join('\n');

test('CHANGELOG の節: 先頭の版・途中の版・末尾の版を、見出し行を除いて切り出す', () => {
  assert.equal(extractChangelogSection(changelog, '0.57.3'), '### 画面 / Interface\n\n- 新しい変更\n  A new change');
  assert.equal(extractChangelogSection(changelog, '0.57.2'), '- 前の変更');
  assert.equal(extractChangelogSection(changelog, '0.57.1'), '- さらに前');
});

test('CHANGELOG の節: 無い版は null。版番号は前方一致にしない', () => {
  assert.equal(extractChangelogSection(changelog, '0.57.9'), null);
  assert.equal(extractChangelogSection(changelog, '0.57'), null);
  assert.equal(extractChangelogSection('', '0.57.3'), null);
});

test('CHANGELOG の節: CRLF と BOM があっても切り出せる', () => {
  const crlf = `﻿${changelog.replace(/\n/g, '\r\n')}`;
  assert.equal(extractChangelogSection(crlf, '0.57.2'), '- 前の変更');
});

test('DOI の定数: 空は null、値があれば返す、定数が無くても null', () => {
  assert.equal(readConceptDoi("export const TIAB_REVIEW_CONCEPT_DOI = '';\n"), null);
  assert.equal(readConceptDoi("/** 説明 */\nexport const TIAB_REVIEW_CONCEPT_DOI = '10.5281/zenodo.1234567';\n"), '10.5281/zenodo.1234567');
  assert.equal(readConceptDoi('export const OTHER = 1;'), null);
  assert.equal(readConceptDoi(undefined), null);
});

test('リリースノート: 節の後に空行を挟んで案内2行。DOI が無ければ1行', () => {
  const withDoi = buildReleaseNotes('- 変更\n  Change', '10.5281/zenodo.1234567');
  assert.equal(withDoi, [
    '- 変更', '  Change', '',
    'Chrome Web Store で配布しています。この Release に拡張機能の zip は添付しません。 / Distributed through the Chrome Web Store; no extension zip is attached to this release.',
    '引用 / Cite: https://doi.org/10.5281/zenodo.1234567', '',
  ].join('\n'));
  const noDoi = buildReleaseNotes('- 変更', null);
  assert.ok(!noDoi.includes('引用 / Cite'));
  assert.equal(noDoi.trim().split('\n').length, 3);
});

test('リリースノート: 節が無ければ案内だけ', () => {
  assert.ok(buildReleaseNotes(null, null).startsWith('Chrome Web Store で配布しています'));
});
