import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseExcludeReasonConfig,
    serializeExcludeReasonConfig,
    resolveExcludeReasonItems,
    nextExcludeReasonKey,
    validateExcludeReasonItems,
    findExcludeReasonPreset,
    EXCLUDE_REASON_PRESETS,
    MAX_EXCLUDE_REASON_ITEMS,
    type ExcludeReasonConfig,
} from '../src/lib/exclude-reason-config';
import {
    DEFAULT_EXCLUDE_REASON_ITEMS,
    excludeReasonLabel,
    excludeReasonLabelEn,
    excludeReasonRank,
    pickPrimaryExcludeReason,
    fallbackExcludeReasonKey,
    normalizeExcludeReasonKey,
    type ExcludeReasonItem,
} from '../src/lib/exclude-reasons';

/** PCC（scoping review）想定のカスタム理由。既定の7区分と件数も並びも異なる。 */
const PCC_ITEMS: ExcludeReasonItem[] = [
    { key: 'population', label: 'Population 不適合', labelEn: 'Ineligible population' },
    { key: 'concept', label: 'Concept 不適合', labelEn: 'Ineligible concept' },
    { key: 'context', label: 'Context 不適合', labelEn: '' },
    { key: 'r1', label: '査読なし文献', labelEn: 'Non-peer-reviewed' },
];

// ---------------------------------------------------------------------------
// parse / serialize
// ---------------------------------------------------------------------------

test('parseExcludeReasonConfig: 空・不正JSONは null（＝既定の区分にフォールバック）', () => {
    assert.equal(parseExcludeReasonConfig(''), null);
    assert.equal(parseExcludeReasonConfig(undefined), null);
    assert.equal(parseExcludeReasonConfig(null), null);
    assert.equal(parseExcludeReasonConfig('{壊れたJSON'), null);
    assert.equal(parseExcludeReasonConfig('[]'), null);
});

test('parseExcludeReasonConfig: items が無い・空・全項目が不正なら null', () => {
    assert.equal(parseExcludeReasonConfig('{"updated_by":"a@example.com"}'), null);
    assert.equal(parseExcludeReasonConfig('{"items":[]}'), null);
    assert.equal(parseExcludeReasonConfig('{"items":[{"key":"","label":"x"},{"key":"y","label":""}]}'), null);
});

test('parseExcludeReasonConfig: 正常な設定は並び順のままパースされる', () => {
    const raw = JSON.stringify({
        items: PCC_ITEMS,
        updated_at: '2026-08-20T00:00:00.000Z',
        updated_by: 'admin@example.com',
    });
    const parsed = parseExcludeReasonConfig(raw);
    assert.ok(parsed);
    assert.deepEqual(parsed.items.map(i => i.key), ['population', 'concept', 'context', 'r1']);
    assert.equal(parsed.updated_by, 'admin@example.com');
});

test('parseExcludeReasonConfig: key 重複は先勝ちで捨て、labelEn 欠落は空文字になる', () => {
    const raw = '{"items":[{"key":"a","label":"A"},{"key":"a","label":"A2"},{"key":"b","label":"B"}]}';
    const parsed = parseExcludeReasonConfig(raw);
    assert.ok(parsed);
    assert.deepEqual(parsed.items, [
        { key: 'a', label: 'A', labelEn: '' },
        { key: 'b', label: 'B', labelEn: '' },
    ]);
});

test('serializeExcludeReasonConfig → parseExcludeReasonConfig で往復できる', () => {
    const config: ExcludeReasonConfig = {
        items: PCC_ITEMS,
        updated_at: '2026-08-20T00:00:00.000Z',
        updated_by: 'admin@example.com',
    };
    const parsed = parseExcludeReasonConfig(serializeExcludeReasonConfig(config));
    assert.deepEqual(parsed, config);
});

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

test('resolveExcludeReasonItems: 未設定なら既定のPICO7区分', () => {
    assert.deepEqual(resolveExcludeReasonItems(null), DEFAULT_EXCLUDE_REASON_ITEMS);
    assert.deepEqual(resolveExcludeReasonItems(undefined), DEFAULT_EXCLUDE_REASON_ITEMS);
});

test('resolveExcludeReasonItems: 設定があればその項目を使う', () => {
    const items = resolveExcludeReasonItems({ items: PCC_ITEMS, updated_at: '', updated_by: '' });
    assert.deepEqual(items.map(i => i.key), ['population', 'concept', 'context', 'r1']);
});

// ---------------------------------------------------------------------------
// キー自動発番
// ---------------------------------------------------------------------------

test('nextExcludeReasonKey: 既存キーと衝突しない最小番号を返す', () => {
    assert.equal(nextExcludeReasonKey([]), 'r1');
    assert.equal(nextExcludeReasonKey(['population', 'r1']), 'r2');
    assert.equal(nextExcludeReasonKey(['r1', 'r2', 'r3']), 'r4');
});

test('nextExcludeReasonKey: 欠番があれば埋める（既に消えたキーを渡せば再利用を避けられる）', () => {
    assert.equal(nextExcludeReasonKey(['r1', 'r3']), 'r2');
    assert.equal(nextExcludeReasonKey(['r1', 'r2', 'r3']), 'r4');
});

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

test('validateExcludeReasonItems: 正常な項目は ok', () => {
    assert.equal(validateExcludeReasonItems(PCC_ITEMS).ok, true);
});

test('validateExcludeReasonItems: 0件は不可（除外の理由が選べなくなる）', () => {
    assert.equal(validateExcludeReasonItems([]).ok, false);
});

test('validateExcludeReasonItems: 空ラベル・ラベル重複・キー重複は不可', () => {
    assert.equal(validateExcludeReasonItems([{ key: 'a', label: '  ', labelEn: '' }]).ok, false);
    assert.equal(validateExcludeReasonItems([
        { key: 'a', label: '同じ', labelEn: '' },
        { key: 'b', label: '同じ', labelEn: '' },
    ]).ok, false);
    assert.equal(validateExcludeReasonItems([
        { key: 'a', label: 'A', labelEn: '' },
        { key: 'a', label: 'B', labelEn: '' },
    ]).ok, false);
});

test('validateExcludeReasonItems: 上限件数を超えたら不可', () => {
    const items = Array.from({ length: MAX_EXCLUDE_REASON_ITEMS + 1 }, (_, i) => ({
        key: `r${i + 1}`, label: `理由${i + 1}`, labelEn: '',
    }));
    assert.equal(validateExcludeReasonItems(items).ok, false);
});

// ---------------------------------------------------------------------------
// プリセット
// ---------------------------------------------------------------------------

test('プリセットはいずれも検証を通り、既定は PICO 7区分と一致する', () => {
    for (const preset of EXCLUDE_REASON_PRESETS) {
        assert.equal(validateExcludeReasonItems(preset.items).ok, true, preset.id);
    }
    assert.deepEqual(findExcludeReasonPreset('pico')?.items, [...DEFAULT_EXCLUDE_REASON_ITEMS]);
});

test('PCC プリセットは Concept / Context を持ち、Intervention/Outcome を持たない', () => {
    const pcc = findExcludeReasonPreset('pcc');
    assert.ok(pcc);
    const keys = pcc.items.map(i => i.key);
    assert.ok(keys.includes('concept'));
    assert.ok(keys.includes('context'));
    assert.equal(keys.includes('intervention'), false);
    assert.equal(keys.includes('outcome'), false);
});

test('findExcludeReasonPreset: 未知の id は undefined', () => {
    assert.equal(findExcludeReasonPreset('unknown'), undefined);
});

// ---------------------------------------------------------------------------
// カスタム理由での表示・優先順位（exclude-reasons.ts のヘルパーとの結合）
// ---------------------------------------------------------------------------

test('カスタム理由でもラベル・優先順位はそのリストの並びで決まる', () => {
    assert.equal(excludeReasonLabel('concept', PCC_ITEMS), 'Concept 不適合');
    assert.equal(excludeReasonRank('population', PCC_ITEMS), 0);
    assert.equal(excludeReasonRank('r1', PCC_ITEMS), 3);
    assert.equal(pickPrimaryExcludeReason(['r1', 'concept'], PCC_ITEMS), 'concept');
});

test('カスタム理由に無いキー（旧設定の理由）は生キーのまま表示され、優先順位は最下位', () => {
    assert.equal(excludeReasonLabel('outcome', PCC_ITEMS), 'outcome');
    assert.equal(excludeReasonRank('outcome', PCC_ITEMS), PCC_ITEMS.length);
    // 過去データが混ざっても、現行リストの理由が代表として選ばれる
    assert.equal(pickPrimaryExcludeReason(['outcome', 'context'], PCC_ITEMS), 'context');
});

test('英語ラベルは未入力なら日本語ラベルで代替する', () => {
    assert.equal(excludeReasonLabelEn('concept', PCC_ITEMS), 'Ineligible concept');
    assert.equal(excludeReasonLabelEn('context', PCC_ITEMS), 'Context 不適合');
    assert.equal(excludeReasonLabelEn('unknown_key', PCC_ITEMS), 'unknown_key');
});

test('fallbackExcludeReasonKey: other があればそれ、無ければ末尾（＝その他相当）', () => {
    assert.equal(fallbackExcludeReasonKey(), 'other');
    assert.equal(fallbackExcludeReasonKey(PCC_ITEMS), 'r1');
    assert.equal(fallbackExcludeReasonKey([]), '');
});

test('normalizeExcludeReasonKey: リストに無いAI出力はフォールバック理由へ寄せる', () => {
    assert.equal(normalizeExcludeReasonKey('concept', PCC_ITEMS), 'concept');
    // 既定リストにしか無い区分をAIが返した場合（設定変更直後など）
    assert.equal(normalizeExcludeReasonKey('study_design', PCC_ITEMS), 'r1');
    assert.equal(normalizeExcludeReasonKey('', PCC_ITEMS), 'r1');
    assert.equal(normalizeExcludeReasonKey(undefined, PCC_ITEMS), 'r1');
    // 既定リストなら 'other' に落ちる（従来挙動）
    assert.equal(normalizeExcludeReasonKey('unknown', DEFAULT_EXCLUDE_REASON_ITEMS), 'other');
});
