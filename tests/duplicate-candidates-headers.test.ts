import test from 'node:test';
import assert from 'node:assert/strict';
import { DUPLICATE_CANDIDATES_HEADERS } from '../src/lib/sheets-api';

// Issue #145 チャンク2: Duplicate_Candidates タブのヘッダー列がドリフトしていないかの回帰テスト。
//
// tests/publication-candidates-headers.test.ts と同じ流儀。src/demo/seed.ts は
// sample/pubmed-srws-psgad-set.nbib を raw-text importする（`declare module '*.nbib'`、
// webpackのローダー前提）ため、tsc + `node --test` で動く本テストランナーからは直接 import
// できない（require時に .nbib をJSとして読もうとして落ちる）。そのため seed.ts 側の期待値を
// ここへ直書きし、sheets-api.ts の実エクスポートと突き合わせる。
// seed.ts の DUPLICATE_CANDIDATES_HEADERS を変更したときは、必ずこの配列も追従させること。
const EXPECTED_SEED_MIRROR = [
    'candidate_id', 'ref_id_a', 'ref_id_b', 'match_type', 'match_key',
    'status', 'suggested_at', 'decided_by', 'decided_at', 'kept_ref_id',
];

test('DUPLICATE_CANDIDATES_HEADERS: src/demo/seed.ts のミラーと一字一句一致する', () => {
    assert.deepEqual(DUPLICATE_CANDIDATES_HEADERS, EXPECTED_SEED_MIRROR);
});

test('DUPLICATE_CANDIDATES_HEADERS: Issue #145 チャンク2 指定どおりの列順', () => {
    assert.deepEqual(DUPLICATE_CANDIDATES_HEADERS, [
        'candidate_id', 'ref_id_a', 'ref_id_b', 'match_type', 'match_key',
        'status', 'suggested_at', 'decided_by', 'decided_at', 'kept_ref_id',
    ]);
});
