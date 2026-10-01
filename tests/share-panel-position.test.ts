import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSharePanelPosition, SHARE_PANEL_MARGIN } from '../src/sidepanel/utils/share-panel-position';

for (const [viewportWidth, left] of [[485, 351], [345, 159]]) {
    test(`画面幅 ${viewportWidth} の実測位置から右端の余白まで左へ移動する`, () => {
        const result = computeSharePanelPosition(left, 300, viewportWidth);
        assert.equal(result.width, 300);
        assert.equal(result.offset, viewportWidth - SHARE_PANEL_MARGIN - 300 - left);
        assert.ok(left + result.offset >= SHARE_PANEL_MARGIN);
        assert.equal(left + result.offset + result.width, viewportWidth - SHARE_PANEL_MARGIN);
    });
}

test('画面内に収まる位置では幅とボタン左端からの位置を変えない', () => {
    assert.deepEqual(computeSharePanelPosition(32, 300, 385), { offset: 0, width: 300 });
});

test('パネルより狭い画面では幅を縮めて左右の余白を確保する', () => {
    const result = computeSharePanelPosition(159, 300, 280);
    assert.equal(result.width, 280 - SHARE_PANEL_MARGIN * 2);
    assert.equal(159 + result.offset, SHARE_PANEL_MARGIN);
    assert.equal(159 + result.offset + result.width, 280 - SHARE_PANEL_MARGIN);
});

test('基準位置が画面外でも左端の余白より左へ出さない', () => {
    const left = -20;
    const result = computeSharePanelPosition(left, 300, 345);
    assert.equal(left + result.offset, SHARE_PANEL_MARGIN);
    assert.equal(result.width, 300);
});

test('指定された余白を使って位置と幅を計算する', () => {
    const margin = SHARE_PANEL_MARGIN * 2;
    const result = computeSharePanelPosition(351, 300, 280, margin);
    assert.deepEqual(result, { offset: margin - 351, width: 280 - margin * 2 });
});
