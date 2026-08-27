import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoiUrl, buildPubmedUrl } from '../src/lib/external-record-url';

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
