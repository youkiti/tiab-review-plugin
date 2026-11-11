import test from 'node:test';
import assert from 'node:assert/strict';
import {
    registerSessionReset,
    runSessionResets,
    _getSessionResetNamesForTest,
    _clearSessionResetsForTest,
} from '../src/sidepanel/session-reset';
import type { SessionResetReason } from '../src/sidepanel/session-reset';

/**
 * 遅延チャンクの機能が戻る・ログアウトの初期化を登録する仕組み（session-reset.ts）。
 * 登録は module スコープの Map なので、各テストの前後で空にする。
 */

function withCleanRegistry(fn: () => void): () => void {
    return () => {
        _clearSessionResetsForTest();
        try {
            fn();
        } finally {
            _clearSessionResetsForTest();
        }
    };
}

test('登録が無ければ何もせず false を返す', withCleanRegistry(() => {
    assert.deepEqual(_getSessionResetNamesForTest(), []);
    assert.equal(runSessionResets('back'), false);
    assert.equal(runSessionResets('logout'), false);
}));

test('登録順に呼び、reason を渡す', withCleanRegistry(() => {
    const calls: string[] = [];
    registerSessionReset('a', reason => { calls.push(`a:${reason}`); return false; });
    registerSessionReset('b', reason => { calls.push(`b:${reason}`); return false; });
    runSessionResets('back');
    runSessionResets('logout');
    assert.deepEqual(calls, ['a:back', 'b:back', 'a:logout', 'b:logout']);
    assert.deepEqual(_getSessionResetNamesForTest(), ['a', 'b']);
}));

test('同じ name は上書きされ、古い関数は呼ばれない（登録順は最初のまま）', withCleanRegistry(() => {
    const calls: string[] = [];
    registerSessionReset('a', () => { calls.push('a-old'); return false; });
    registerSessionReset('b', () => { calls.push('b'); return false; });
    registerSessionReset('a', () => { calls.push('a-new'); return false; });
    runSessionResets('back');
    assert.deepEqual(calls, ['a-new', 'b']);
    assert.deepEqual(_getSessionResetNamesForTest(), ['a', 'b']);
}));

test('1つが例外を投げても残りは呼ばれ、name を付けて console.error に出す', withCleanRegistry(() => {
    const calls: string[] = [];
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
        registerSessionReset('first', () => { calls.push('first'); return false; });
        registerSessionReset('broken', () => { throw new Error('boom'); });
        registerSessionReset('last', () => { calls.push('last'); return true; });
        const aborted = runSessionResets('back');
        assert.deepEqual(calls, ['first', 'last']);
        // 例外を投げた関数があっても、残りの結果は OR される
        assert.equal(aborted, true);
    } finally {
        console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /broken/);
}));

test('戻り値は1つでも true なら true（すべて false なら false）', withCleanRegistry(() => {
    registerSessionReset('a', () => false);
    registerSessionReset('b', () => false);
    assert.equal(runSessionResets('back'), false);
    registerSessionReset('c', () => true);
    assert.equal(runSessionResets('back'), true);
    // true の後ろに false が続いても true のまま
    registerSessionReset('d', () => false);
    assert.equal(runSessionResets('logout'), true);
}));

test('reason は back と logout の2値', withCleanRegistry(() => {
    const seen: SessionResetReason[] = [];
    registerSessionReset('a', reason => { seen.push(reason); return false; });
    runSessionResets('back');
    runSessionResets('logout');
    assert.deepEqual(seen, ['back', 'logout']);
}));
