import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTargetPages, diffMaterialization, sumCanvasBytes, capTargetPagesByBytes } from '../src/fulltext/pdf-page-window';

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

// ---------------------------------------------------------------------------
// capTargetPagesByBytes（Issue #156（#150 工程5）PR3: canvas合計バイト数の安全弁）
// ---------------------------------------------------------------------------

test('capTargetPagesByBytes: 合計が上限に収まる場合はtargetがそのまま返る', () => {
    const target = new Set([4, 5, 6]);
    // minPagesを0にして、「最小保証件数だから残る」のではなく「バイト数の上限内だから残る」
    // ことを検証する（合計300 <= maxBytes 1000）。
    const result = capTargetPagesByBytes(target, [5], () => 100, 1000, 0);
    assert.deepEqual(sorted(result), [4, 5, 6]);
});

test('capTargetPagesByBytes: 上限を超える場合、可視ページから遠いものが落ちる', () => {
    const target = new Set([3, 4, 5, 6, 7]); // 可視ページ5からの距離: 3→2, 4→1, 5→0, 6→1, 7→2
    // 1ページ100バイト・上限300バイト → 最も近い3件（距離0,1,1の5,4,6）はちょうど収まり、
    // 距離2の2件（3,7）は4件目以降として打ち切られる。
    const result = capTargetPagesByBytes(target, [5], () => 100, 300, 0);
    assert.deepEqual(sorted(result), [4, 5, 6]);
});

test('capTargetPagesByBytes: minPages件までは上限を超えていても必ず残る', () => {
    const target = new Set([4, 5, 6]);
    // 1ページ1000バイト・上限100バイト（1ページぶんの見積りにすら満たない）。
    // minPagesが機能していなければ1件も採用されないはずだが、minPages=3で全件残ることを見る。
    const result = capTargetPagesByBytes(target, [5], () => 1000, 100, 3);
    assert.deepEqual(sorted(result), [4, 5, 6]);
});

test('capTargetPagesByBytes: minPagesが0なら、上限に収まらない1ページ目すら採用されない（比較対照）', () => {
    // 直前のテストがminPagesの効果で通っているのであって、上限判定そのものが無効化されている
    // わけではないことを示す対照テスト。同じmaxBytes/bytesOfでminPagesだけ0にすると空になる。
    const target = new Set([4, 5, 6]);
    const result = capTargetPagesByBytes(target, [5], () => 1000, 100, 0);
    assert.deepEqual(sorted(result), []);
});

test('capTargetPagesByBytes: 同距離のときの採用順はページ番号昇順で決定的である', () => {
    const target = new Set([4, 6]); // どちらも可視ページ5から距離1
    // 1件ぶんしか収まらない上限にして、ページ番号が小さい4が優先されることを固定する。
    const result = capTargetPagesByBytes(target, [5], () => 100, 100, 0);
    assert.deepEqual(sorted(result), [4]);
});

test('capTargetPagesByBytes: visiblePagesが空なら距離を測れないため絞り込まずtargetをそのまま返す', () => {
    const target = new Set([1, 2, 3]);
    // バイト数だけ見れば上限(50)を大きく超えるが、距離の基準点(visiblePages)が無いため
    // 絞り込みを諦めて安全側（そのまま返す）に倒すことを固定する。
    const result = capTargetPagesByBytes(target, [], () => 100, 50, 0);
    assert.deepEqual(sorted(result), [1, 2, 3]);
});
