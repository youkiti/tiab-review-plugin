import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseReviewCriteria,
    serializeReviewCriteria,
    needsCriteriaNotice,
    llmCriteriaToText,
} from '../src/lib/review-criteria';
import type { ReviewCriteria } from '../src/lib/review-criteria';
import type { LlmCriteria } from '../src/lib/types';

// ===== parseReviewCriteria =====

test('parseReviewCriteria: 正常なJSONを往復できる', () => {
    const criteria: ReviewCriteria = {
        text: '組入基準: 成人RCT\n除外基準: 動物実験',
        updated_at: '2026-08-17T00:00:00.000Z',
        updated_by: 'reviewer@example.com',
    };
    const parsed = parseReviewCriteria(JSON.stringify(criteria));
    assert.deepEqual(parsed, criteria);
});

test('parseReviewCriteria: 空文字・undefined・null は null を返す', () => {
    assert.equal(parseReviewCriteria(''), null);
    assert.equal(parseReviewCriteria(undefined), null);
    assert.equal(parseReviewCriteria(null), null);
});

test('parseReviewCriteria: text が空文字のJSONは null を返す', () => {
    assert.equal(parseReviewCriteria(JSON.stringify({ text: '', updated_at: '2026-01-01', updated_by: 'a@b.com' })), null);
});

test('parseReviewCriteria: text が文字列でないJSONは null を返す', () => {
    assert.equal(parseReviewCriteria(JSON.stringify({ text: 123 })), null);
});

test('parseReviewCriteria: 壊れたJSON（非空）は raw 全体を text とみなす', () => {
    const raw = '組入基準: これはJSONではない自由記述テキスト';
    const parsed = parseReviewCriteria(raw);
    assert.deepEqual(parsed, { text: raw, updated_at: '', updated_by: '' });
});

test('parseReviewCriteria: updated_at / updated_by 欠損は空文字にフォールバックする', () => {
    const parsed = parseReviewCriteria(JSON.stringify({ text: '本文のみ' }));
    assert.deepEqual(parsed, { text: '本文のみ', updated_at: '', updated_by: '' });
});

test('parseReviewCriteria: updated_at / updated_by が文字列以外なら空文字にフォールバックする', () => {
    const parsed = parseReviewCriteria(JSON.stringify({ text: '本文', updated_at: 123, updated_by: null }));
    assert.deepEqual(parsed, { text: '本文', updated_at: '', updated_by: '' });
});

// ===== serializeReviewCriteria =====

test('serializeReviewCriteria → parseReviewCriteria の往復で改行を含むtextが保たれる', () => {
    const criteria: ReviewCriteria = {
        text: '1行目\n2行目\n\n4行目（空行を挟む）',
        updated_at: '2026-08-17T12:34:56.000Z',
        updated_by: 'youkiti@gmail.com',
    };
    const roundTripped = parseReviewCriteria(serializeReviewCriteria(criteria));
    assert.deepEqual(roundTripped, criteria);
});

// ===== needsCriteriaNotice =====

test('needsCriteriaNotice: criteria が null なら false', () => {
    assert.equal(needsCriteriaNotice(null, null), false);
    assert.equal(needsCriteriaNotice(null, '2026-01-01'), false);
});

test('needsCriteriaNotice: 一度も見ていない（lastSeenUpdatedAt が null）なら true', () => {
    const criteria: ReviewCriteria = { text: '本文', updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'a@b.com' };
    assert.equal(needsCriteriaNotice(criteria, null), true);
});

test('needsCriteriaNotice: updated_at が空文字（手編集値）なら false', () => {
    const criteria: ReviewCriteria = { text: '本文', updated_at: '', updated_by: '' };
    assert.equal(needsCriteriaNotice(criteria, '2026-01-01T00:00:00.000Z'), false);
});

test('needsCriteriaNotice: lastSeenUpdatedAt と updated_at が異なれば true', () => {
    const criteria: ReviewCriteria = { text: '本文', updated_at: '2026-02-01T00:00:00.000Z', updated_by: 'a@b.com' };
    assert.equal(needsCriteriaNotice(criteria, '2026-01-01T00:00:00.000Z'), true);
});

test('needsCriteriaNotice: lastSeenUpdatedAt と updated_at が同じなら false', () => {
    const criteria: ReviewCriteria = { text: '本文', updated_at: '2026-01-01T00:00:00.000Z', updated_by: 'a@b.com' };
    assert.equal(needsCriteriaNotice(criteria, '2026-01-01T00:00:00.000Z'), false);
});

// ===== llmCriteriaToText =====

test('llmCriteriaToText: null なら空文字', () => {
    assert.equal(llmCriteriaToText(null, true), '');
});

test('llmCriteriaToText: PICOの並び順どおりに出力される', () => {
    const criteria: LlmCriteria = {
        template: 'pico',
        fields: { O: 'アウトカムの値', P: '対象患者の値', I: '介入の値', C: '比較対照の値' },
    };
    const text = llmCriteriaToText(criteria, true);
    assert.equal(text, [
        'P (対象患者/集団): 対象患者の値',
        'I (介入): 介入の値',
        'C (比較対照): 比較対照の値',
        'O (アウトカム): アウトカムの値',
    ].join('\n'));
});

test('llmCriteriaToText: 空フィールドは省かれる', () => {
    const criteria: LlmCriteria = {
        template: 'pico',
        fields: { P: '対象患者の値', I: '', C: '   '.trim(), O: 'アウトカムの値' },
    };
    const text = llmCriteriaToText(criteria, true);
    assert.equal(text, [
        'P (対象患者/集団): 対象患者の値',
        'O (アウトカム): アウトカムの値',
    ].join('\n'));
});

test('llmCriteriaToText: 標準フィールドに無いカスタムキーは末尾に来る', () => {
    const criteria: LlmCriteria = {
        template: 'pico',
        fields: { P: '対象患者の値', custom_key: 'カスタム値' },
    };
    const text = llmCriteriaToText(criteria, true);
    assert.equal(text, [
        'P (対象患者/集団): 対象患者の値',
        'custom_key: カスタム値',
    ].join('\n'));
});

test('llmCriteriaToText: japanese=false なら英語ラベルになる', () => {
    const criteria: LlmCriteria = {
        template: 'peco',
        fields: { P: 'population value', E: 'exposure value', C: 'comparator value', O: 'outcome value' },
    };
    const text = llmCriteriaToText(criteria, false);
    assert.equal(text, [
        'P (Population): population value',
        'E (Exposure): exposure value',
        'C (Comparator): comparator value',
        'O (Outcome): outcome value',
    ].join('\n'));
});
