import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoiUrl, buildPubmedUrl, buildGoogleScholarUrl } from '../src/lib/external-record-url';

test('buildDoiUrl: https://doi.org/{doi} 形式を組み立てる', () => {
    assert.equal(buildDoiUrl('10.1000/example'), 'https://doi.org/10.1000%2Fexample');
});

test('buildPubmedUrl: https://pubmed.ncbi.nlm.nih.gov/{pmid}/ 形式を組み立てる', () => {
    assert.equal(buildPubmedUrl('12345678'), 'https://pubmed.ncbi.nlm.nih.gov/12345678/');
});

test('buildDoiUrl: 危険な文字はencodeURIComponentでエスケープされる（スキーム注入不可）', () => {
    const url = buildDoiUrl('javascript:alert(1)');
    assert.ok(url.startsWith('https://doi.org/'));
    assert.equal(new URL(url).protocol, 'https:');
});

test('buildGoogleScholarUrl: DOIがあればDOIで検索する（タイトルより優先）', () => {
    assert.equal(
        buildGoogleScholarUrl({ doi: '10.1000/example', title: 'Some title' }),
        'https://scholar.google.com/scholar?q=10.1000%2Fexample'
    );
});

test('buildGoogleScholarUrl: DOIの前後空白は取り除く', () => {
    assert.equal(
        buildGoogleScholarUrl({ doi: '  10.1000/example \n' }),
        'https://scholar.google.com/scholar?q=10.1000%2Fexample'
    );
});

test('buildGoogleScholarUrl: DOIが空白だけならタイトルの完全一致で検索する', () => {
    assert.equal(
        buildGoogleScholarUrl({ doi: '   ', title: 'Effect of X on Y' }),
        'https://scholar.google.com/scholar?q=' + encodeURIComponent('"Effect of X on Y"')
    );
});

test('buildGoogleScholarUrl: DOIが無ければタイトルをダブルクォートで囲んで検索する', () => {
    assert.equal(
        buildGoogleScholarUrl({ title: 'Effect of X on Y' }),
        'https://scholar.google.com/scholar?q=%22Effect%20of%20X%20on%20Y%22'
    );
});

test('buildGoogleScholarUrl: タイトル中の引用符（半角・全角）を除き、連続空白を1つに畳む', () => {
    assert.equal(
        buildGoogleScholarUrl({ title: '  The "quoted"   \u201Ctitle\u201D \n here ' }),
        'https://scholar.google.com/scholar?q=' + encodeURIComponent('"The quoted title here"')
    );
});

test('buildGoogleScholarUrl: DOIもタイトルも無い（空・空白・引用符だけ）なら null', () => {
    assert.equal(buildGoogleScholarUrl({}), null);
    assert.equal(buildGoogleScholarUrl({ doi: '', title: '' }), null);
    assert.equal(buildGoogleScholarUrl({ doi: '  ', title: '  ' }), null);
    assert.equal(buildGoogleScholarUrl({ title: '"" \u201C\u201D' }), null);
});

test('buildGoogleScholarUrl: & や # を含むタイトルでもクエリが壊れない', () => {
    const url = buildGoogleScholarUrl({ title: 'A & B #1: C=D' });
    assert.ok(url);
    const parsed = new URL(url);
    assert.equal(parsed.hash, '');
    assert.deepEqual([...parsed.searchParams.keys()], ['q']);
    assert.equal(parsed.searchParams.get('q'), '"A & B #1: C=D"');
});
