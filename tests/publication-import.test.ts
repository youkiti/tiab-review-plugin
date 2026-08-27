import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImportedPublicationReference, resolveImportedFulltextSet } from '../src/lib/publication-import';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';

const NONE_ASSIGNMENT: FulltextAssignmentConfig = { status: 'none', groupCount: 2, reviewerMap: {} };
const CONFIGURED_ASSIGNMENT: FulltextAssignmentConfig = {
    status: 'configured',
    groupCount: 2,
    reviewerMap: { 'ft-group-1': ['alice@example.com'] },
};

// ---------------------------------------------------------------------------
// buildImportedPublicationReference
// ---------------------------------------------------------------------------

test('buildImportedPublicationReference: record_type/related_ref_id/source/dedupe_keyが期待どおり', () => {
    const registrationRef = {
        ref_id: 'reg-1',
        pmid: 'NCT01234567',
        url: 'https://clinicaltrials.gov/study/NCT01234567',
        source: 'ClinicalTrials.gov',
    };
    const candidate = {
        pmid: '99999999',
        doi: '10.1000/example',
        title: 'A Randomized Trial of Example',
        journal: 'Example Journal',
        year: 2025,
        trial_id: 'NCT01234567',
    };

    const result = buildImportedPublicationReference({
        candidate,
        registrationRef,
        refId: 'new-ref-1',
        importedBy: 'reviewer@example.com',
        importedAt: '2026-08-27T00:00:00.000Z',
    });

    assert.equal(result.ref_id, 'new-ref-1');
    assert.equal(result.record_type, 'article');
    assert.equal(result.related_ref_id, 'reg-1');
    assert.equal(result.source, 'Registry linkage (NCT01234567)');
    // generateDedupeKey は pmid を最優先するため pmid ベースのキーになる
    assert.equal(result.dedupe_key, 'pmid:99999999');
    assert.equal(result.title, candidate.title);
    assert.equal(result.journal, candidate.journal);
    assert.equal(result.year, candidate.year);
    assert.equal(result.pmid, candidate.pmid);
    assert.equal(result.doi, candidate.doi);
    assert.equal(result.imported_by, 'reviewer@example.com');
    assert.equal(result.imported_at, '2026-08-27T00:00:00.000Z');
    // fulltext_url/fulltext_status/url はこの関数では設定しない
    assert.equal(result.fulltext_url, undefined);
    assert.equal(result.fulltext_status, undefined);
    assert.equal(result.url, undefined);
});

test('buildImportedPublicationReference: DOIのみの候補はdoiベースのdedupe_keyになる', () => {
    const registrationRef = {
        ref_id: 'reg-2',
        pmid: 'NCT01234567',
        url: 'https://clinicaltrials.gov/study/NCT01234567',
        source: 'ClinicalTrials.gov',
    };
    const candidate = {
        doi: '10.1000/DOI-Example',
        title: 'Some Title',
        trial_id: 'NCT01234567',
    };

    const result = buildImportedPublicationReference({
        candidate,
        registrationRef,
        refId: 'new-ref-2',
        importedBy: 'reviewer@example.com',
        importedAt: '2026-08-27T00:00:00.000Z',
    });

    assert.equal(result.dedupe_key, 'doi:10.1000/doi-example');
});

test('buildImportedPublicationReference: registrationRefから試験IDが取れない場合は"(不明)"になる', () => {
    const registrationRef = {
        ref_id: 'reg-3',
        pmid: '', // extractTrialId() は空文字なら null を返す
        url: '',
        source: 'ICTRP',
    };
    const candidate = {
        pmid: '11111111',
        title: 'Untitled Trial Result',
        trial_id: '',
    };

    const result = buildImportedPublicationReference({
        candidate,
        registrationRef,
        refId: 'new-ref-3',
        importedBy: 'reviewer@example.com',
        importedAt: '2026-08-27T00:00:00.000Z',
    });

    assert.equal(result.source, 'Registry linkage (不明)');
    assert.equal(result.related_ref_id, 'reg-3');
    assert.equal(result.record_type, 'article');
});

test('buildImportedPublicationReference: titleが候補に無い場合は空文字にフォールバックする', () => {
    const registrationRef = {
        ref_id: 'reg-4',
        pmid: 'NCT09999999',
        url: '',
        source: 'ClinicalTrials.gov',
    };
    const candidate = {
        pmid: '22222222',
        trial_id: 'NCT09999999',
    };

    const result = buildImportedPublicationReference({
        candidate,
        registrationRef,
        refId: 'new-ref-4',
        importedBy: 'reviewer@example.com',
        importedAt: '2026-08-27T00:00:00.000Z',
    });

    assert.equal(result.title, '');
});

// ---------------------------------------------------------------------------
// resolveImportedFulltextSet
// ---------------------------------------------------------------------------

test('resolveImportedFulltextSet: 割り振り設定済みならregistration行のfulltext_setをコピーする', () => {
    const result = resolveImportedFulltextSet({ fulltext_set: 'ft-group-1' }, CONFIGURED_ASSIGNMENT);
    assert.equal(result, 'ft-group-1');
});

test('resolveImportedFulltextSet: 割り振り未設定なら空文字を返す', () => {
    const result = resolveImportedFulltextSet({ fulltext_set: 'ft-group-1' }, NONE_ASSIGNMENT);
    assert.equal(result, '');
});

test('resolveImportedFulltextSet: 割り振り設定済みでもregistration行のfulltext_setが空なら空文字', () => {
    const result = resolveImportedFulltextSet({ fulltext_set: '' }, CONFIGURED_ASSIGNMENT);
    assert.equal(result, '');
});
