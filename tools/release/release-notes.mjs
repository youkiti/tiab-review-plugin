// GitHub Release の本文を作る純関数。Node 標準モジュールのみ。release.mjs の段6から呼ぶ。

// `## vX.Y.Z（` で始まる見出しの次の行から、次の `## ` の直前まで。見出し行は含めない。無ければ null。
export function extractChangelogSection(changelogText, version) {
  const lines = String(changelogText ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## v${version}（`));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

// src/lib/citation.ts の TIAB_REVIEW_CONCEPT_DOI を読む。空・見つからないときは null。
export function readConceptDoi(citationTsText) {
  const match = /TIAB_REVIEW_CONCEPT_DOI = '([^']*)'/.exec(String(citationTsText ?? ''));
  return match && match[1].trim() ? match[1].trim() : null;
}

// CHANGELOG の節（日英の両方）の後に、空行を挟んで案内を足す。DOI が null なら引用の行は出さない。
export function buildReleaseNotes(section, doi) {
  const lines = ['Chrome Web Store で配布しています。この Release に拡張機能の zip は添付しません。 / Distributed through the Chrome Web Store; no extension zip is attached to this release.'];
  if (doi) lines.push(`引用 / Cite: https://doi.org/${doi}`);
  const head = section ? `${section}\n\n` : '';
  return `${head}${lines.join('\n')}\n`;
}
