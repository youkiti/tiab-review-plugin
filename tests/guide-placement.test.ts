import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInDialogCardPosition, computeModalWaitPosition, computeTourCardPosition } from '../src/guide-ui/placement';

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

/** ダイアログの中の対象の配置の検査用。カードは通常表示の寸法（320x175）、小さい表示は 200x30。 */
const inDialog = (
    viewport: { width: number; height: number },
    target: { top: number; bottom: number } | null,
    footer: { top: number; bottom: number } | null,
) => computeInDialogCardPosition({
    viewport, card: { width: 320, height: 175 }, compactCard: { width: 200, height: 30 }, margin: 8, gap: 8, pad: 3,
    target: target ? { ...target, left: 40, right: 400 } : null,
    footer,
});

const overlapsVertically = (top: number, height: number, box: { top: number; bottom: number }): boolean =>
    top < box.bottom && top + height > box.top;

// 担当セットのウィザードの実測に近い寸法（フッター = ボタン列）
const wide = { width: 500, height: 1000 };
const wideFooter = { top: 691, bottom: 772 };
const narrow = { width: 400, height: 700 };
const narrowFooter = { top: 541, bottom: 622 };

test('computeInDialogCardPosition 1: 対象の下に収まり、フッターに重ならなければ、そこに通常表示（500×1000、上部の入力欄）', () => {
    const position = inDialog(wide, { top: 468, bottom: 501 }, wideFooter);
    assert.deepEqual(position, { left: 40, top: 512, compact: false });
});

test('computeInDialogCardPosition 2: 下がフッターに重なるなら、対象の上に通常表示（下部の入力欄。500×1000・400×700）', () => {
    const wideLower = inDialog(wide, { top: 600, bottom: 633 }, wideFooter);
    assert.equal(wideLower.compact, false);
    assert.equal(wideLower.top, 600 - 3 - 8 - 175);
    const narrowLower = inDialog(narrow, { top: 440, bottom: 473 }, narrowFooter);
    assert.equal(narrowLower.compact, false);
    assert.equal(narrowLower.top, 440 - 3 - 8 - 175);
    const narrowUpper = inDialog(narrow, { top: 324, bottom: 357 }, narrowFooter);
    assert.equal(narrowUpper.compact, false, '下に置くとフッターに 2px かかるので、上に置く');
    assert.equal(narrowUpper.top, 324 - 3 - 8 - 175);
});

test('computeInDialogCardPosition 3: 上にも下にも置けないときは、対象にもフッターにも重ならない端（フッターのボタンが対象なら上端）', () => {
    for (const [viewport, footer, target] of [
        [wide, wideFooter, { top: 708, bottom: 756 }],
        [narrow, narrowFooter, { top: 558, bottom: 606 }],
    ] as const) {
        const position = inDialog(viewport, target, footer);
        assert.deepEqual({ top: position.top, compact: position.compact }, { top: 8, compact: false });
        assert.equal(overlapsVertically(position.top, 175, footer), false, 'フッターを覆わない');
        assert.equal(overlapsVertically(position.top, 175, target), false, '対象を覆わない');
    }
    // 上端が対象に重なり、下端が空いているなら下端
    const bottomEdge = inDialog(narrow, { top: 20, bottom: 80 }, { top: 90, bottom: 150 });
    assert.deepEqual({ top: bottomEdge.top, compact: bottomEdge.compact }, { top: 700 - 8 - 175, compact: false });
});

test('computeInDialogCardPosition 4: 対象とフッターの両方を避けられないときは、対象を覆わない端に通常表示（見出しなどには重なってよい）', () => {
    // 対象が大きく、上端は対象に、下端はフッターに重なる。対象を覆わない下端を選ぶ（フッターは対象より優先度が低い）
    const position = inDialog(narrow, { top: 60, bottom: 400 }, { top: 560, bottom: 640 });
    assert.equal(position.compact, false);
    assert.equal(overlapsVertically(position.top, 175, { top: 60 - 3, bottom: 400 + 3 }), false, '対象を覆わない');
    assert.equal(position.top, 700 - 8 - 175);
});

test('computeInDialogCardPosition 5: どう置いても対象の半分以上を覆うときだけ、小さい表示に落とす', () => {
    const position = inDialog({ width: 400, height: 300 }, { top: 40, bottom: 260 }, null);
    assert.equal(position.compact, true);
    assert.ok(position.top >= 8 && position.top + 30 <= 300 - 8, '画面内に収まる');
});

test('computeInDialogCardPosition: 対象が無いときは通常の配置', () => {
    const position = inDialog(narrow, null, narrowFooter);
    assert.equal(position.compact, false);
});
