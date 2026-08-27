import test from 'node:test';
import assert from 'node:assert/strict';
import { PUBLICATION_CANDIDATES_HEADERS } from '../src/lib/sheets-api';

// Issue #118 チャンク2 パスB: Publication_Candidates タブのヘッダー列がドリフトしていないかの回帰テスト。
//
// src/demo/seed.ts は sample/pubmed-srws-psgad-set.nbib を raw-text importする（`declare module
// '*.nbib'`、webpackのローダー前提）ため、tsc + `node --test` で動く本テストランナーからは
// 直接 import できない（require時に .nbib をJSとして読もうとして落ちる）。
// tests/references-headers-record-type.test.ts が REFERENCES_HEADERS に対して行っているのと
// 同じ流儀（seed.ts側の期待値をここへ直書きし、sheets-api.ts の実エクスポートと突き合わせる）を踏襲する。
// seed.ts の PUBLICATION_CANDIDATES_HEADERS を変更したときは、必ずこの配列も追従させること。
const EXPECTED_SEED_MIRROR = [
    'candidate_id', 'ref_id', 'trial_id', 'pmid', 'doi',
    'title', 'journal', 'year', 'strategy', 'status',
    'suggested_at', 'decided_by', 'decided_at', 'imported_ref_id',
];

test('PUBLICATION_CANDIDATES_HEADERS: src/demo/seed.ts のミラーと一字一句一致する', () => {
    assert.deepEqual(PUBLICATION_CANDIDATES_HEADERS, EXPECTED_SEED_MIRROR);
});

test('PUBLICATION_CANDIDATES_HEADERS: issue #118 指定どおりの列順', () => {
    assert.deepEqual(PUBLICATION_CANDIDATES_HEADERS, [
        'candidate_id', 'ref_id', 'trial_id', 'pmid', 'doi',
        'title', 'journal', 'year', 'strategy', 'status',
        'suggested_at', 'decided_by', 'decided_at', 'imported_ref_id',
    ]);
});
