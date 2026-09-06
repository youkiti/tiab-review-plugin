import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTargetPages, diffMaterialization, sumCanvasBytes } from '../src/fulltext/pdf-page-window';

function sorted(set: ReadonlySet<number>): number[] {
    return [...set].sort((a, b) => a - b);
}

test('computeTargetPages: 可視ページの前後をウィンドウ幅ぶん含める', () => {
    const target = computeTargetPages([5], 1, 10);
    assert.deepEqual(sorted(target), [4, 5, 6]);
});

test('computeTargetPages: 先頭ページは前方向にはみ出さない', () => {
    const target = computeTargetPages([1], 1, 10);
    assert.deepEqual(sorted(target), [1, 2]);
});

test('computeTargetPages: 末尾ページは後方向にはみ出さない', () => {
    const target = computeTargetPages([10], 1, 10);
    assert.deepEqual(sorted(target), [9, 10]);
});

test('computeTargetPages: 可視が0件なら空集合', () => {
    const target = computeTargetPages([], 1, 10);
    assert.equal(target.size, 0);
});

test('computeTargetPages: 総ページ数が0なら常に空集合', () => {
    const target = computeTargetPages([1], 1, 0);
    assert.equal(target.size, 0);
});

test('computeTargetPages: 総ページ1ページなら常にそのページだけ', () => {
    const target = computeTargetPages([1], 1, 1);
    assert.deepEqual(sorted(target), [1]);
});

test('computeTargetPages: 可視が飛び飛びでも各周辺を個別に含める', () => {
    const target = computeTargetPages([2, 8], 1, 10);
    assert.deepEqual(sorted(target), [1, 2, 3, 7, 8, 9]);
});

test('computeTargetPages: ウィンドウが重なる場合は重複なく1つの集合になる', () => {
    const target = computeTargetPages([5, 6], 1, 10);
    assert.deepEqual(sorted(target), [4, 5, 6, 7]);
});

test('diffMaterialization: 新規実体化と解放を求める', () => {
    const current = new Set([1, 2, 3]);
    const target = new Set([2, 3, 4]);
    const { toMaterialize, toRelease } = diffMaterialization(current, target);
    assert.deepEqual(toMaterialize, [4]);
    assert.deepEqual(toRelease, [1]);
});

test('diffMaterialization: 変化なしなら両方空', () => {
    const current = new Set([1, 2]);
    const target = new Set([2, 1]);
    const { toMaterialize, toRelease } = diffMaterialization(current, target);
    assert.deepEqual(toMaterialize, []);
    assert.deepEqual(toRelease, []);
});

test('diffMaterialization: current が空なら全部が新規実体化', () => {
    const current = new Set<number>();
    const target = new Set([3, 1, 2]);
    const { toMaterialize, toRelease } = diffMaterialization(current, target);
    assert.deepEqual(toMaterialize, [1, 2, 3]);
    assert.deepEqual(toRelease, []);
});

test('diffMaterialization: target が空なら全部解放', () => {
    const current = new Set([3, 1, 2]);
    const target = new Set<number>();
    const { toMaterialize, toRelease } = diffMaterialization(current, target);
    assert.deepEqual(toMaterialize, []);
    assert.deepEqual(toRelease, [1, 2, 3]);
});

test('sumCanvasBytes: width * height * 4 の合計', () => {
    const bytes = sumCanvasBytes([{ width: 100, height: 50 }, { width: 10, height: 10 }]);
    assert.equal(bytes, 100 * 50 * 4 + 10 * 10 * 4);
});

test('sumCanvasBytes: 空配列は0', () => {
    assert.equal(sumCanvasBytes([]), 0);
});
