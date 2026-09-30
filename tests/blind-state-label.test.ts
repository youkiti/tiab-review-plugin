import test from 'node:test';
import assert from 'node:assert/strict';
import { blindStateLabelKey } from '../src/sidepanel/ui/blind-state';

test('確定状態に応じてBlind中・キー開封中の表示を切り替える', () => {
    assert.equal(blindStateLabelKey(false), 'blind_stateClosed');
    assert.equal(blindStateLabelKey(true), 'blind_stateOpened');
    assert.equal(blindStateLabelKey(false), 'blind_stateClosed');
});
