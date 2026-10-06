import test from 'node:test';
import assert from 'node:assert/strict';
import { salvageTruncatedFulltextJudge as salvage } from '../src/lib/fulltext-judge-salvage';
import { RECITATION_TEXT } from './fixtures/fulltext-recitation';

const prefix = '{"decision":"include","include_probability":1,"reason":"理由","evidence":[';
const item = { quote: '引用 " } ] {', page: 2, bbox: [515, 655, 748, 685], polarity: 'include' };
const completeItem = JSON.stringify(item);

test('実際の打ち切り本文から完結した判定と最初の根拠を取り出す', () => {
    const result = salvage(RECITATION_TEXT);
    assert.ok(result);
    assert.equal(result.decision, 'include');
    assert.equal(result.include_probability, 1);
    assert.ok(result.reason.startsWith('本研究は'));
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].page, 2);
    assert.deepEqual(result.evidence[0].bbox, item.bbox);
    assert.equal(result.evidence[0].polarity, 'include');
});

test('三件目の座標の数値が途中でも完結した二件だけを保つ', () => {
    assert.deepEqual(salvage(prefix + completeItem + ',' + completeItem + ',{"bbox":[12,3.4e')?.evidence, [item, item]);
});

test('配列の開始直後・要素後のカンマ・引用内の構造文字・末尾のエスケープを扱う', () => {
    assert.deepEqual(salvage(prefix)?.evidence, []);
    assert.deepEqual(salvage(prefix + completeItem + ',')?.evidence, [item]);
    assert.deepEqual(salvage(prefix + completeItem + ',{"quote":"途中\\')?.evidence, [item]);
});

test('判定・理由の途中や必須値の不正は取り出さない', () => {
    for (const input of [
        '{"decision":"inc',
        '{"decision":"include","include_probability":1,"reason":"途中',
        prefix.replace('"include"', '"unknown"'),
        prefix.replace('"include_probability":1,', ''),
        prefix.replace('"include_probability":1', '"include_probability":"1"'),
        prefix.replace('"include_probability":1', '"include_probability":1e999'),
        prefix.replace('"reason":"理由"', '"reason":null'),
    ]) assert.equal(salvage(input), null, input);
});

test('空・完結済み・配列ルート・根拠配列の外・不正構文は取り出さない', () => {
    for (const input of [
        '', prefix + ']}', '[' + prefix, prefix + '],"other":',
        prefix + completeItem + ',,', prefix + '{"quote":"不正\\x',
        prefix + '{"bbox":[1.e', prefix + completeItem + ',]',
        prefix.replace('"evidence":[', '"nested":{"evidence":['),
        prefix.replace('"evidence":[', '"decision":"exclude","evidence":['),
    ]) assert.equal(salvage(input), null, input);
});

test('確率・座標を正規化せず、列挙された判定をそのまま返す', () => {
    for (const decision of ['include', 'exclude', 'maybe']) {
        const result = salvage(prefix.replace('"include"', JSON.stringify(decision))
            .replace('"include_probability":1', '"include_probability":2') + completeItem);
        assert.equal(result?.decision, decision);
        assert.equal(result?.include_probability, 2);
        assert.deepEqual(result?.evidence[0].bbox, item.bbox);
    }
});
