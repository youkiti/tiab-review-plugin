import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWithMap, findQuoteItems, bboxToRect } from '../src/fulltext/pdf-text-match';

// テキストアイテム配列から rawText と charItemIndex を構築するテスト用ヘルパー
// （pdf-renderer の buildTextIndex と同じ規約: アイテム連結 + EOL 改行）
function buildIndex(items: Array<{ str: string; eol?: boolean }>): { raw: string; charItemIndex: number[] } {
    let raw = '';
    const charItemIndex: number[] = [];
    items.forEach((it, idx) => {
        for (const ch of it.str) { raw += ch; charItemIndex.push(idx); }
        if (it.eol) { raw += '\n'; charItemIndex.push(idx); }
    });
    return { raw, charItemIndex };
}

test('normalizeWithMap: 連続空白を1つに圧縮し小文字化する', () => {
    const { norm, map } = normalizeWithMap('Hello   World', false);
    assert.equal(norm, 'hello world');
    // map は norm の各文字に対応する元indexを持つ
    assert.equal(map.length, norm.length);
    // 'w' は元の 'World' の W 位置(8)を指す
    assert.equal(norm[6], 'w');
    assert.equal(map[6], 8);
});

test('normalizeWithMap: stripPunct で記号を除去する（空白は1つ保持）', () => {
    const { norm } = normalizeWithMap('co-morbid (n=10)', true);
    // ハイフン・括弧・等号は除去、語間の空白は1つに圧縮して保持
    assert.equal(norm, 'comorbid n10');
});

test('findQuoteItems: 複数アイテムにまたがる quote を該当アイテムに解決する', () => {
    const { raw, charItemIndex } = buildIndex([
        { str: 'Randomized ' },
        { str: 'controlled ' },
        { str: 'trial of aspirin' },
    ]);
    const items = findQuoteItems(raw, charItemIndex, 'controlled trial');
    assert.deepEqual(items, [1, 2]);
});

test('findQuoteItems: 空白ゆらぎを吸収してマッチする', () => {
    const { raw, charItemIndex } = buildIndex([
        { str: 'mean   age', eol: true },
        { str: 'was 65 years' },
    ]);
    // quote 側は空白1つでも、改行をまたいでもマッチする
    const items = findQuoteItems(raw, charItemIndex, 'mean age was 65');
    assert.deepEqual(items, [0, 1]);
});

test('findQuoteItems: 記号差はラフマッチで吸収する', () => {
    const { raw, charItemIndex } = buildIndex([{ str: 'co-morbidities were excluded' }]);
    const items = findQuoteItems(raw, charItemIndex, 'comorbidities were excluded');
    assert.deepEqual(items, [0]);
});

test('findQuoteItems: 一致しない場合は null', () => {
    const { raw, charItemIndex } = buildIndex([{ str: 'placebo group' }]);
    assert.equal(findQuoteItems(raw, charItemIndex, 'surgical intervention'), null);
});

test('bboxToRect: 正規化座標をピクセル矩形へ変換する', () => {
    const rect = bboxToRect([0.1, 0.2, 0.5, 0.4], 1000, 800);
    assert.deepEqual(rect, { left: 100, top: 160, width: 400, height: 160 });
});

test('bboxToRect: 座標が逆でも入れ替えて正の矩形にする', () => {
    const rect = bboxToRect([0.5, 0.4, 0.1, 0.2], 1000, 800);
    assert.deepEqual(rect, { left: 100, top: 160, width: 400, height: 160 });
});

test('bboxToRect: 値域外(>1)は null', () => {
    assert.equal(bboxToRect([0, 0, 1.5, 1], 1000, 800), null);
});

test('bboxToRect: 面積ゼロは null', () => {
    assert.equal(bboxToRect([0.3, 0.3, 0.3, 0.6], 1000, 800), null);
});
