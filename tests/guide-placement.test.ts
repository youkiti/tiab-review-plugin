import test from 'node:test';
import assert from 'node:assert/strict';
import { computeModalWaitPosition, computeTourCardPosition } from '../src/sidepanel/features/guide/placement';

const viewport = { width: 400, height: 800 };
const card = { width: 320, height: 120 };
const base = { viewport, card, margin: 8, gap: 8, pad: 3 };
const box = (top: number, bottom: number, left = 20, right = 380) => ({ top, bottom, left, right });
const inRange = (top: number, v = viewport, c = card, margin = 8): boolean =>
    top >= margin && top <= v.height - c.height - margin;

test('対象が画面内で下に空きがあれば、対象の下に置く', () => {
    const pos = computeTourCardPosition({ ...base, target: box(100, 150) });
    assert.equal(pos.top, 150 + 3 + 8);
});

test('下に空きが無く上にあれば、対象の上に置く', () => {
    const pos = computeTourCardPosition({ ...base, target: box(600, 700) });
    assert.equal(pos.top, 600 - 3 - 8 - 120);
});

test('上下とも無ければ画面下端に置く', () => {
    const pos = computeTourCardPosition({ ...base, target: box(60, 760) });
    assert.equal(pos.top, 800 - 120 - 8);
});

test('対象が画面の上に外れていても、カードは画面内（画面下端）に収まる', () => {
    const pos = computeTourCardPosition({ ...base, target: box(-900, -300) });
    assert.ok(inRange(pos.top));
    assert.equal(pos.top, 800 - 120 - 8);
});

test('対象が画面の下に外れていても、カードは画面内（画面下端）に収まる', () => {
    const pos = computeTourCardPosition({ ...base, target: box(1500, 1700) });
    assert.ok(inRange(pos.top));
    assert.equal(pos.top, 800 - 120 - 8);
});

test('対象が無いときは画面下端の中央', () => {
    const pos = computeTourCardPosition({ ...base, target: null });
    assert.deepEqual(pos, { left: 40, top: 800 - 120 - 8 });
});

test('カードが画面より高いとき top は margin', () => {
    const tall = { width: 320, height: 900 };
    for (const target of [null, box(100, 150), box(-900, -300), box(1500, 1700)]) {
        assert.equal(computeTourCardPosition({ ...base, card: tall, target }).top, 8);
    }
});

test('左右のはみ出しは画面内に収まる', () => {
    const right = computeTourCardPosition({ ...base, target: box(100, 150, 300, 395) });
    assert.equal(right.left, 400 - 320 - 8);
    const left = computeTourCardPosition({ ...base, target: box(100, 150, -50, 10) });
    assert.equal(left.left, 8);
    const narrow = computeTourCardPosition({ ...base, viewport: { width: 200, height: 800 }, target: box(100, 150, 0, 100) });
    assert.equal(narrow.left, 8);
});

const modalBase = { viewport, card, compactCard: { width: 200, height: 28 }, margin: 8, gap: 8 };

test('ダイアログ待ち: ダイアログの下に収まれば下端（通常表示）', () => {
    const pos = computeModalWaitPosition({ ...modalBase, dialog: { top: 100, bottom: 500 }, footer: { top: 440, bottom: 500 } });
    assert.deepEqual(pos, { left: 40, top: 800 - 120 - 8, compact: false });
});

test('ダイアログ待ち: 下に収まらず上に収まれば画面上端（通常表示）', () => {
    const pos = computeModalWaitPosition({ ...modalBase, dialog: { top: 200, bottom: 700 }, footer: { top: 640, bottom: 700 } });
    assert.deepEqual(pos, { left: 40, top: 8, compact: false });
});

test('ダイアログ待ち: どちらにも収まらなければ小さい表示で左寄せ・上端', () => {
    const pos = computeModalWaitPosition({ ...modalBase, dialog: { top: 40, bottom: 780 }, footer: { top: 700, bottom: 780 } });
    assert.deepEqual(pos, { left: 8, top: 8, compact: true });
});

test('ダイアログ待ち: 小さい表示の上端がフッターに重なるなら、重ならない位置を選ぶ', () => {
    const pos = computeModalWaitPosition({ ...modalBase, dialog: { top: 0, bottom: 480 }, footer: { top: 0, bottom: 20 }, viewport: { width: 400, height: 480 } });
    assert.equal(pos.compact, true);
    assert.ok(pos.top >= 20 + 8, `top=${pos.top} がフッターと重なっている`);
});

test('ダイアログの寸法が取れないときは下端の通常表示', () => {
    const pos = computeModalWaitPosition({ ...modalBase, dialog: null, footer: null });
    assert.equal(pos.compact, false);
    assert.equal(pos.top, 800 - 120 - 8);
});
