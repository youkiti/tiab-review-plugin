import test from 'node:test';
import assert from 'node:assert/strict';
import { planPdfPageWindow } from '../src/lib/pdf-page-window';

// Issue #156（#150 工程5）: 表示範囲中心のPDF描画で「次に描画すべきページ」
// 「解放すべきページ」を決める純関数のテスト。DOM・pdf.js には依存しない。

test('planPdfPageWindow: 1ページしか無いPDFでは先頭ページだけを描画対象にする', () => {
    const plan = planPdfPageWindow({
        numPages: 1,
        visiblePages: [],
        radius: 2,
        renderedPages: [],
        maxRenderedPages: 5,
    });
    assert.deepEqual(plan.toRender, [1]);
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: 表示中ページが末尾でも radius 分だけ手前へ広げ、末尾を超えない', () => {
    const plan = planPdfPageWindow({
        numPages: 10,
        visiblePages: [10],
        radius: 2,
        renderedPages: [],
        maxRenderedPages: 10,
    });
    // 先頭ページ(1) + 末尾ページ(10)の前後radius(8,9,10) → {1,8,9,10}
    assert.deepEqual(new Set(plan.toRender), new Set([1, 8, 9, 10]));
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: radius が総ページ数を超えても範囲外へはみ出さない（全ページが対象になる）', () => {
    const plan = planPdfPageWindow({
        numPages: 5,
        visiblePages: [3],
        radius: 100,
        renderedPages: [],
        maxRenderedPages: 100,
    });
    assert.deepEqual(new Set(plan.toRender), new Set([1, 2, 3, 4, 5]));
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: 上限に達すると、既に描画済みでも遠いページから解放される', () => {
    // numPages=5, visible=[5], radius=1 → 望ましいウィンドウは {1,4,5}
    // 優先度: 5→0, 1→0(先頭), 4→距離1 なので 4 が一番弱い。
    // maxRenderedPages=2 なので keep={1,5}、既に描画済みの 4 は解放される。
    const plan = planPdfPageWindow({
        numPages: 5,
        visiblePages: [5],
        radius: 1,
        renderedPages: [1, 2, 3, 4, 5],
        maxRenderedPages: 2,
    });
    assert.deepEqual(plan.toRender, []);
    assert.deepEqual(plan.toRelease, [2, 3, 4]);
});

test('planPdfPageWindow: 描画済み集合の外側（表示範囲から完全に離れたページ）は無条件で解放される', () => {
    const plan = planPdfPageWindow({
        numPages: 20,
        visiblePages: [10],
        radius: 1,
        renderedPages: [1, 2, 3, 10],
        maxRenderedPages: 10,
    });
    // 望ましいウィンドウ {1,9,10,11} には 2,3 が含まれないため解放対象。
    assert.deepEqual(plan.toRelease, [2, 3]);
    assert.deepEqual(new Set(plan.toRender), new Set([9, 11]));
});

test('planPdfPageWindow: 先頭ページと表示中ページを優先し、上限超過時は距離が遠いページから描画対象外になる', () => {
    const plan = planPdfPageWindow({
        numPages: 20,
        visiblePages: [10],
        radius: 5,
        renderedPages: [],
        maxRenderedPages: 3,
    });
    // 望ましいウィンドウ {1,5..15} のうち優先度0は {1,10} だけ。次点(距離1)は9,11で
    // 同着はページ番号昇順のため 9 が selected。maxRenderedPages=3 → keep={1,10,9}。
    assert.deepEqual(plan.toRender, [1, 10, 9]);
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: 表示中ページが複数（隣接しない）でも、それぞれの周辺を独立に含める', () => {
    const plan = planPdfPageWindow({
        numPages: 30,
        visiblePages: [5, 20],
        radius: 1,
        renderedPages: [],
        maxRenderedPages: 30,
    });
    assert.deepEqual(new Set(plan.toRender), new Set([1, 4, 5, 6, 19, 20, 21]));
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: 既に望ましいウィンドウ内にあるページは toRender に含めない（描画済みは再要求しない）', () => {
    const plan = planPdfPageWindow({
        numPages: 10,
        visiblePages: [5],
        radius: 1,
        renderedPages: [4, 5, 6, 1],
        maxRenderedPages: 10,
    });
    assert.deepEqual(plan.toRender, []);
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: numPages が 0 以下なら常に空の計画を返す', () => {
    const plan = planPdfPageWindow({
        numPages: 0,
        visiblePages: [1],
        radius: 2,
        renderedPages: [1],
        maxRenderedPages: 5,
    });
    assert.deepEqual(plan.toRender, []);
    assert.deepEqual(plan.toRelease, []);
});

test('planPdfPageWindow: 範囲外のページ番号（0や総ページ数超過）は無視する', () => {
    const plan = planPdfPageWindow({
        numPages: 5,
        visiblePages: [0, 3, 999],
        radius: 0,
        renderedPages: [0, 999],
        maxRenderedPages: 5,
    });
    assert.deepEqual(new Set(plan.toRender), new Set([1, 3]));
    assert.deepEqual(plan.toRelease, []);
});
