import test from 'node:test';
import assert from 'node:assert/strict';
import { isImeComposing } from '../src/lib/ime-composition';

// 実事故ケース: フルテキストの補足メモに日本語を入力中、変換確定の Enter で
// 次の文献へ進んでしまっていた（Enter を「保存して次へ」に割り当てているため）。
test('IME 変換確定の Enter（isComposing=true）は変換中と判定する', () => {
    assert.equal(isImeComposing({ isComposing: true, keyCode: 229 }), true);
});

test('isComposing を立てない IME でも keyCode 229 なら変換中と判定する', () => {
    assert.equal(isImeComposing({ keyCode: 229 }), true);
});

test('compositionstart / compositionend で追跡した変換状態でも変換中と判定する', () => {
    assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }, true), true);
});

test('変換確定後の Enter は変換中ではない（＝保存して次へ進んでよい）', () => {
    assert.equal(isImeComposing({ isComposing: false, keyCode: 13 }, false), false);
});

test('IME を使わない通常の Enter は変換中ではない', () => {
    assert.equal(isImeComposing({ keyCode: 13 }), false);
});

test('isComposing / keyCode を持たないイベントは変換中ではない（通常キーを塞がない）', () => {
    assert.equal(isImeComposing({}), false);
});
