import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEndNoteEnl, parseEndNoteEnlp, isEndNoteLibraryFile } from '../src/lib/endnote-enl-parser';

// テストは .tmp/tests/ 配下にコンパイルされて実行されるため、__dirname ではなく
// リポジトリルート（npm test の cwd）基準で fixtures を解決する。
function loadFixture(name: string): Uint8Array {
    return new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', name)));
}

test('isEndNoteLibraryFile: 拡張子で .enl / .enlp を判定する', () => {
    assert.equal(isEndNoteLibraryFile('lib.enl'), 'enl');
    assert.equal(isEndNoteLibraryFile('LIB.ENLP'), 'enlp');
    assert.equal(isEndNoteLibraryFile('refs.ris'), null);
    assert.equal(isEndNoteLibraryFile('refs.xml'), null);
});

test('parseEndNoteEnl: enl_refs テーブルを読み、ゴミ箱を除外して変換する', () => {
    const refs = parseEndNoteEnl(loadFixture('sample.enl'), 'sample.enl');
    // 3 行のうち trash_state=1 の 1 件はスキップ → 2 件
    assert.equal(refs.length, 2);

    const [a, b] = refs;
    // 1 件目: PubMed 由来（accession 数字 + pubmed URL）→ pmid 採用
    assert.equal(a.title, 'Effect of X on Y');
    assert.equal(a.authors, 'Smith, J.; Doe, A. B.'); // CR 区切りを "; " 連結
    assert.equal(a.year, 2020);
    assert.equal(a.journal, 'Lancet');
    assert.equal(a.volume, '354');
    assert.equal(a.issue, '9173');
    assert.equal(a.pages, '93-9');
    assert.equal(a.issn, '0140-6736');                  // "(Print)" 注記を除去
    assert.equal(a.doi, '10.1016/s0140-6736(99)06154-1');
    assert.equal(a.pmid, '10408483');
    assert.equal(a.dedupe_key, 'pmid:10408483');

    // 2 件目: volume "22(2)" を volume/issue に分離、PubMed シグナル無し → pmid 空
    assert.equal(b.title, 'Volume issue split case');
    assert.equal(b.volume, '22');
    assert.equal(b.issue, '2');
    assert.equal(b.journal, 'Am J Kidney Dis');
    assert.equal(b.source, 'Embase');
    assert.equal(b.pmid, undefined);
    // 長い abstract（オーバーフローページ経由）が欠落なく読めている
    assert.ok((b.abstract ?? '').length > 4000);
    assert.ok((b.abstract ?? '').startsWith('BACKGROUND:'));
    assert.ok((b.abstract ?? '').endsWith('END.'));
});

test('parseEndNoteEnlp: ZIP を解凍し中の refs テーブルを読む', async () => {
    const refs = await parseEndNoteEnlp(loadFixture('sample.enlp'), 'sample.enlp');
    assert.equal(refs.length, 1);
    const r = refs[0];
    assert.equal(r.title, 'Packaged library entry');
    assert.equal(r.journal, 'BMC Nephrol');
    assert.equal(r.volume, '20');
    assert.equal(r.issue, '1');
    assert.equal(r.doi, '10.1186/s12882-019-1283-4');
    assert.equal(r.pmid, '30922296');   // name_of_database=PubMed
    assert.equal(r.issn, '1471-2369');
});
