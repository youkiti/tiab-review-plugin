import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getRefAssignmentSet,
    getExpectedReviewersForRef,
} from '../src/lib/assignment-roster';
import type { AssignmentConfig } from '../src/lib/types';

function makeAssignmentConfig(overrides: Partial<AssignmentConfig>): AssignmentConfig {
    return {
        status: 'none',
        calibrationSize: 0,
        groupCount: 1,
        reviewerMap: {},
        ...overrides,
    };
}

test('getRefAssignmentSet: screening_set が空欄なら unassigned', () => {
    assert.equal(getRefAssignmentSet({ screening_set: '' }), 'unassigned');
    assert.equal(getRefAssignmentSet({ screening_set: undefined }), 'unassigned');
    assert.equal(getRefAssignmentSet({ screening_set: '   ' }), 'unassigned');
});

test('getRefAssignmentSet: screening_set があればそのままトリムして返す', () => {
    assert.equal(getRefAssignmentSet({ screening_set: 'group-1' }), 'group-1');
    assert.equal(getRefAssignmentSet({ screening_set: '  calibration  ' }), 'calibration');
});

test('getExpectedReviewersForRef: status が configured 以外なら null', () => {
    const config = makeAssignmentConfig({
        status: 'none',
        reviewerMap: { 'group-1': ['a@x.com'] },
    });
    assert.equal(getExpectedReviewersForRef(config, { screening_set: 'group-1' }), null);

    const dismissed = makeAssignmentConfig({
        status: 'dismissed',
        reviewerMap: { 'group-1': ['a@x.com'] },
    });
    assert.equal(getExpectedReviewersForRef(dismissed, { screening_set: 'group-1' }), null);
});

test('getExpectedReviewersForRef: calibration セットは reviewerMap 全体の和集合', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: {
            'group-1': ['A@X.com', 'b@y.com'],
            'group-2': ['c@z.com', 'b@y.com'],
        },
    });
    const result = getExpectedReviewersForRef(config, { screening_set: 'calibration' });
    assert.deepEqual(result && [...result].sort(), ['a@x.com', 'b@y.com', 'c@z.com']);
});

test('getExpectedReviewersForRef: 通常セットは reviewerMap[setId] を小文字正規化して返す', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { 'group-1': ['A@X.com', ' b@Y.com '] },
    });
    const result = getExpectedReviewersForRef(config, { screening_set: 'group-1' });
    assert.deepEqual(result && [...result].sort(), ['a@x.com', 'b@y.com']);
});

test('getExpectedReviewersForRef: 未登録・空のセットは null（呼び出し側でフォールバックさせる）', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { 'group-1': ['a@x.com'], 'group-2': [] },
    });

    // 未登録セット
    assert.equal(getExpectedReviewersForRef(config, { screening_set: 'group-9' }), null);
    // unassigned（未割り当て）も名簿には無い
    assert.equal(getExpectedReviewersForRef(config, { screening_set: '' }), null);
    // 空配列で登録されているセット
    assert.equal(getExpectedReviewersForRef(config, { screening_set: 'group-2' }), null);
});

test('getExpectedReviewersForRef: calibration でも reviewerMap が空・全員空配列なら null', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { 'group-1': [], 'group-2': [] },
    });
    assert.equal(getExpectedReviewersForRef(config, { screening_set: 'calibration' }), null);
});
