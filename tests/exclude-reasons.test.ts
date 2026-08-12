import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EXCLUDE_REASON_VALUES,
    EXCLUDE_REASON_LABELS_EN,
    excludeReasonRank,
    excludeReasonLabel,
    pickPrimaryExcludeReason,
    hasExcludeReasonConflict,
} from '../src/lib/exclude-reasons';

test('pickPrimaryExcludeReason: 順序に依存せず番号の小さい理由が勝つ', () => {
    assert.equal(pickPrimaryExcludeReason(['outcome', 'population']), 'population');
    assert.equal(pickPrimaryExcludeReason(['population', 'outcome']), 'population');
});

test('pickPrimaryExcludeReason: 空文字混在は無視し、有効な理由だけで選ぶ', () => {
    assert.equal(pickPrimaryExcludeReason(['', 'duplicate', '']), 'duplicate');
});

test('pickPrimaryExcludeReason: 全部空文字なら空文字を返す', () => {
    assert.equal(pickPrimaryExcludeReason(['', '', '']), '');
    assert.equal(pickPrimaryExcludeReason([]), '');
});

test('pickPrimaryExcludeReason: 未知の理由のみでも落とさずそのまま返す', () => {
    assert.equal(pickPrimaryExcludeReason(['legacy_reason']), 'legacy_reason');
});

test('pickPrimaryExcludeReason: 未知と既知が混在すれば既知が勝つ', () => {
    assert.equal(pickPrimaryExcludeReason(['legacy_reason', 'comparator']), 'comparator');
    assert.equal(pickPrimaryExcludeReason(['comparator', 'legacy_reason']), 'comparator');
});

test('hasExcludeReasonConflict: 有効な理由が2種類以上あれば true', () => {
    assert.equal(hasExcludeReasonConflict(['population', 'outcome']), true);
});

test('hasExcludeReasonConflict: 理由が1種類のみなら false', () => {
    assert.equal(hasExcludeReasonConflict(['population', 'population']), false);
});

test('hasExcludeReasonConflict: 空文字は比較対象から除外する', () => {
    assert.equal(hasExcludeReasonConflict(['population', '', 'population']), false);
    assert.equal(hasExcludeReasonConflict(['', '']), false);
    assert.equal(hasExcludeReasonConflict([]), false);
});

test('excludeReasonRank: 既知の理由は EXCLUDE_REASON_VALUES の並び順どおりの有限値を返す', () => {
    EXCLUDE_REASON_VALUES.forEach((reason, idx) => {
        assert.equal(excludeReasonRank(reason), idx);
    });
});

test('excludeReasonRank: 未知の理由・空文字でも有限値を返す（最下位扱い）', () => {
    const unknownRank = excludeReasonRank('legacy_reason');
    const emptyRank = excludeReasonRank('');
    assert.equal(Number.isFinite(unknownRank), true);
    assert.equal(Number.isFinite(emptyRank), true);
    // 既知の理由より必ず下位（値が大きい）であること
    for (const reason of EXCLUDE_REASON_VALUES) {
        assert.ok(unknownRank > excludeReasonRank(reason));
        assert.ok(emptyRank > excludeReasonRank(reason));
    }
});

test('excludeReasonLabel: 既知の理由は日本語ラベルを返す', () => {
    assert.equal(excludeReasonLabel('population'), 'Population 不適合');
    assert.equal(excludeReasonLabel('duplicate'), '重複');
});

test('excludeReasonLabel: 未知の理由はそのまま返す', () => {
    assert.equal(excludeReasonLabel('legacy_reason'), 'legacy_reason');
});

test('excludeReasonLabel: 空文字は空文字のまま返す（呼び出し側の置き換えを壊さない）', () => {
    assert.equal(excludeReasonLabel(''), '');
});

test('EXCLUDE_REASON_LABELS_EN: 全 EXCLUDE_REASON_VALUES に対して空でない英語ラベルが引ける', () => {
    for (const reason of EXCLUDE_REASON_VALUES) {
        const label = EXCLUDE_REASON_LABELS_EN[reason];
        assert.equal(typeof label, 'string');
        assert.ok(label.length > 0);
    }
});
