// 本文の組み立てと、参考文献除去・文字数上限の境界を検証する。
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTextFromPdfDocument, prepareFulltextForTypeSafe, FULLTEXT_TEXT_MAX_CHARS } from '../src/lib/pdf-text-extract';

test('全ページを順に読み、改行・ページ境界と空白以外の文字数を保持する', async () => {
    const visited: number[] = [];
    const result = await extractTextFromPdfDocument({
        numPages: 2,
        async getPage(n) {
            visited.push(n);
            return { async getTextContent() {
                return { items: n === 1
                    ? [{ str: ' A\t', hasEOL: true }, { str: 'B' }, { str: 42 }, null]
                    : [{ str: '本文 ' }, { str: '終', hasEOL: true }] };
            } };
        },
    });
    assert.deepEqual(visited, [1, 2]);
    assert.deepEqual(result, { text: ' A\t\nB\n\n本文 終\n', totalTextLength: 5, numPages: 2 });
});

test('各行を整形し、連続する空行をまとめる', () => {
    const raw = '  A \t B  \r\n\n \n\n C  ';
    assert.deepEqual(prepareFulltextForTypeSafe(raw), {
        text: 'A B\n\nC', rawLength: raw.length, referencesRemoved: false, truncated: false,
    });
});

test('番号・コロン・大文字・日本語の参考文献見出しを除く', () => {
    for (const heading of ['12 References', '12. REFERENCE LIST:', 'XII. Bibliography:',
        'Literature cited', 'Works cited', '参考文献', '引用文献:', '文献']) {
        const body = '本文'.repeat(100);
        const result = prepareFulltextForTypeSafe(`${body}\n${heading}\n引用`);
        assert.equal(result.text, body, heading);
        assert.equal(result.referencesRemoved, true);
    }
});

test('40%より前の見出しと、行の一部の見出し語は除去しない', () => {
    for (const raw of ['References\n' + '本文'.repeat(100), '本文'.repeat(100) + '\nReferences in this paper\n終']) {
        assert.equal(prepareFulltextForTypeSafe(raw).text, raw);
        assert.equal(prepareFulltextForTypeSafe(raw).referencesRemoved, false);
    }
});

test('40%以降の最後の見出しから後ろを除去する', () => {
    const body = '本文'.repeat(100) + '\nReferences\n途中\n';
    assert.equal(prepareFulltextForTypeSafe(body + '参考文献\n引用').text, body.trimEnd());
});

test('見出しがない本文の既定上限と指定上限を守る', () => {
    const raw = '字'.repeat(FULLTEXT_TEXT_MAX_CHARS + 1);
    const result = prepareFulltextForTypeSafe(raw);
    assert.equal(result.text.length, 85000);
    assert.equal(result.truncated, true);
    assert.equal(result.referencesRemoved, false);
    assert.equal(result.rawLength, 85001);
    assert.equal(prepareFulltextForTypeSafe(raw.slice(1)).truncated, false);
    assert.equal(prepareFulltextForTypeSafe('abcdef', 3).text, 'abc');
});
