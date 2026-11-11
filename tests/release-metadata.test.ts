import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// コンパイル後は .tmp/tests/ に置かれるため、__dirname でなく cwd（npm test はリポジトリ直下）から読む。
const read = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8').replace(/^﻿/, '');

const AUTHORS: ReadonlyArray<{ family: string; given: string }> = [
    { family: 'Kataoka', given: 'Yuki' },
    { family: 'Banno', given: 'Masahiro' },
    { family: 'Kyo', given: 'Michihito' },
    { family: 'Nakao', given: 'Shuri' },
    { family: 'Sato', given: 'Tomoo' },
    { family: 'Taito', given: 'Shunsuke' },
    { family: 'Takayama', given: 'Tomohiro' },
    { family: 'Tsuge', given: 'Takahiro' },
    { family: 'Tsujimoto', given: 'Yasushi' },
    { family: 'So', given: 'Ryuhei' },
    { family: 'Furukawa', given: 'Toshi A.' },
];

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, '$2');

/** CITATION.cff の `authors:` 節を読む（YAML パーサを使わず、この形式の行だけを扱う）。 */
function readCffAuthors(text: string): Array<Record<string, string>> {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex(line => line === 'authors:');
    assert.ok(start >= 0, 'authors: が無い');
    const authors: Array<Record<string, string>> = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line)) break;
        if (/^\s*(#|$)/.test(line)) continue;
        const entry = /^\s*(- )?([a-z-]+):\s*(.*)$/.exec(line);
        assert.ok(entry, `authors の行を読めない: ${line}`);
        if (entry[1]) authors.push({});
        authors[authors.length - 1][entry[2]] = unquote(entry[3]);
    }
    return authors;
}

const packageVersion = (): string => (JSON.parse(read('package.json')) as { version: string }).version;

test('CHANGELOG.md に、package.json の版の見出し（## vX.Y.Z（YYYY-MM-DD））がある', () => {
    const heading = new RegExp(`^## v${packageVersion().replace(/\./g, '\\.')}（(\\d{4}-\\d{2}-\\d{2})）\\s*$`, 'm');
    assert.match(read('CHANGELOG.md'), heading);
});

test('CITATION.cff: version が package.json と一致し、date-released が CHANGELOG の見出しの日付と一致する', () => {
    const cff = read('CITATION.cff');
    const version = /^version: (.*)$/m.exec(cff)?.[1].trim();
    assert.equal(unquote(version ?? ''), packageVersion());
    const released = unquote(/^date-released: (.*)$/m.exec(cff)?.[1] ?? '');
    const heading = new RegExp(`^## v${packageVersion().replace(/\./g, '\\.')}（(\\d{4}-\\d{2}-\\d{2})）`, 'm').exec(read('CHANGELOG.md'));
    assert.ok(heading, 'CHANGELOG に現在の版の見出しが無い');
    assert.equal(released, heading[1]);
});

test('CITATION.cff: authors が決定事項の11名・順序どおり。affiliation と orcid はあれば形式が正しい', () => {
    const authors = readCffAuthors(read('CITATION.cff'));
    assert.deepEqual(
        authors.map(a => ({ family: a['family-names'], given: a['given-names'] })),
        AUTHORS,
    );
    for (const author of authors) {
        if ('affiliation' in author) assert.ok(author.affiliation.length > 0, 'affiliation が空');
        if ('orcid' in author) assert.match(author.orcid, /^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/);
    }
});

test('.zenodo.json: creators が決定事項の11名（Family, Given）・順序どおりで、license は MIT', () => {
    const zenodo = JSON.parse(read('.zenodo.json')) as {
        creators: Array<{ name: string; affiliation?: string; orcid?: string }>;
        license: string;
    };
    assert.deepEqual(zenodo.creators.map(c => c.name), AUTHORS.map(a => `${a.family}, ${a.given}`));
    assert.equal(zenodo.license, 'MIT');
    for (const creator of zenodo.creators) {
        if ('affiliation' in creator) assert.ok((creator.affiliation ?? '').length > 0, 'affiliation が空');
        if ('orcid' in creator) assert.match(creator.orcid ?? '', /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/);
    }
});
