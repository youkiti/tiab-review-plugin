import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/sidepanel/state';

// PR #113 のレビュー指摘の回帰テスト。
// state.resetForBack() / resetForLogout() のどちらも _consensusMode をリセットしていなかったため、
// 合議モードONのプロジェクトからBack（またはログアウト）で別のブラインドプロジェクトへ切り替えると
// state.consensusMode が true のまま残り、合議トグル・バッジが非表示のまま
// '-human-consensus' として判定が保存され続けてしまう不具合があった
// （合議はブラインド中に成立しないため、これは仕様の反転になる）。
// resetForBack() / resetForLogout() の呼び出し後に consensusMode が必ず false に戻ることを固定する。

test('resetForBack: consensusMode を false に戻す', () => {
    state.setConsensusMode(true);
    assert.equal(state.consensusMode, true);

    state.resetForBack();

    assert.equal(state.consensusMode, false);
});

test('resetForLogout: consensusMode を false に戻す', () => {
    state.setConsensusMode(true);
    assert.equal(state.consensusMode, true);

    state.resetForLogout();

    assert.equal(state.consensusMode, false);
});
