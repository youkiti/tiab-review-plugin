import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getUserSheetAccess, isUserAdmin } from '../src/lib/drive-permissions';
import { pickSheetAccessBanner, pickScreeningCompletion } from '../src/lib/sheet-access-banner';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { initialState, reducer } from '../src/sidepanel/store/reducer';
import { getEncourageMessage } from '../src/sidepanel/store/selectors';
import { renderDecisionButtonAccess } from '../src/sidepanel/render/layout';

const adapter: PlatformAdapter = {
    getAuthToken: async () => 'test-token',
    forceReauth: async () => 'test-token',
    clearAuth: async () => {},
    storageGet: async () => ({}),
    storageSet: async () => {},
    storageRemove: async () => {},
    storageClear: async () => {},
    onMessage: () => {},
    emitMessage: () => {},
    getMessage: (key, args) => [key, ...(args ?? [])].join(':'),
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: {
        llm: true,
        ml: true,
        fulltext: true,
        importExport: true,
        createProject: true,
    },
};
const originalFetch = globalThis.fetch;
test.beforeEach(() => {
    setPlatform(adapter);
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
});
test.afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restoreAll();
});

for (const role of ['owner', 'writer', 'reader', 'commenter', 'absent', 'failed']) {
    for (const capability of [true, false, 'missing', 'empty', '403', '404', 'exception'] as const) {
        test(`権限 ${role}・canEdit ${capability} の管理者と編集可否`, async () => {
            let calls = 0;
            globalThis.fetch = async input => {
                calls += 1;
                const url = String(input);
                if (url.includes('/permissions?')) {
                    if (role === 'failed') {
                        throw new Error('通信失敗');
                    }
                    return Response.json({ permissions: role === 'absent' ? [] : [{ role, emailAddress: 'self' }] });
                }
                if (capability === 'exception') {
                    throw new Error('通信失敗');
                }
                if (capability === '403' || capability === '404') {
                    return Response.json({}, { status: Number(capability) });
                }
                return Response.json(capability === 'missing' ? {} : {
                    capabilities: capability === 'empty' ? {} : { canEdit: capability },
                });
            };
            const directAdmin = role === 'owner' || role === 'writer';
            const expected = {
                isAdmin: directAdmin || ((role === 'absent' || role === 'failed') && capability === true),
                editAccess: directAdmin || capability === true ? 'editable' : capability === false ? 'readonly' : 'unknown',
            };
            assert.deepEqual(await getUserSheetAccess('sheet', 'self'), expected);
            assert.equal(calls, directAdmin ? 1 : 2);
            assert.equal(await isUserAdmin('sheet', 'self'), expected.isAdmin);
        });
    }
}

test('認証を取得できない想定外の例外でも読み取り専用と断定しない', async () => {
    setPlatform({ ...adapter, getAuthToken: async () => { throw new Error('認証失敗'); } });
    assert.deepEqual(await getUserSheetAccess('sheet', 'self'), { isAdmin: false, editAccess: 'unknown' });
});

test('接続時の読み取り専用の帯を優先し、メールアドレスを渡す', () => {
    assert.deepEqual(pickSheetAccessBanner({ editAccess: 'readonly', deniedUnsentCount: 5, userEmail: 'self' }), {
        messageKey: 'screening_sheetReadonly', args: ['self'],
    });
    for (const editAccess of ['editable', 'unknown'] as const) {
        assert.deepEqual(pickSheetAccessBanner({ editAccess, deniedUnsentCount: 5, userEmail: 'self' }), {
            messageKey: 'screening_sheetDeniedUnsent', args: ['5'],
        });
        assert.equal(pickSheetAccessBanner({ editAccess, deniedUnsentCount: 0, userEmail: 'self' }), null);
    }
});

test('未送信がある間だけ完了の見出しと励ましを置き換え、完了通知を止める', () => {
    assert.deepEqual(pickScreeningCompletion(767, 5), {
        titleKey: 'screening_tiabUnsentTitle', titleArgs: ['767', '5'],
        progressKey: 'screening_progressUnsent', progressArgs: ['5'], canCelebrate: false,
    });
    assert.deepEqual(pickScreeningCompletion(767, 0), {
        titleKey: 'screening_tiabDoneTitle', titleArgs: ['767'],
        progressKey: 'progress_complete', progressArgs: [], canCelebrate: true,
    });
});

test('切替・戻る・ログアウトでは編集可否と未送信件数をリセットする', () => {
    const state = { ...initialState, data: { ...initialState.data,
        spreadsheetId: 'sheet', userEmail: 'self', sheetEditAccess: 'readonly' as const, unsentCount: 5,
    } };
    for (const action of [
        { type: 'data/setSpreadsheetId', id: 'other' },
        { type: 'data/setUserEmail', email: 'other' },
        { type: 'reset/back' }, { type: 'reset/logout' },
    ] as const) {
        const next = reducer(state, action);
        assert.equal(next.data.sheetEditAccess, 'unknown');
        assert.equal(next.data.unsentCount, 0);
    }
});

test('ヘルプに日英の未送信を送信ボタン名がある', () => {
    const html = readFileSync('docs/help.html', 'utf8');
    for (const lang of ['ja', 'en']) {
        const messages = JSON.parse(readFileSync(`src/_locales/${lang}/messages.json`, 'utf8'));
        assert.ok(html.includes(messages.screening_sendUnsent.message), lang);
    }
});

test('読み取り専用の間だけ5つの判定ボタンを無効化し、切替・戻るでも解除する', () => {
    const ids = ['btn-include', 'btn-maybe', 'btn-exclude', 'ml-btn-include', 'ml-btn-exclude'];
    const buttons = new Map(ids.map(id => [id, { disabled: false } as HTMLButtonElement]));
    const root = { getElementById: (id: string) => buttons.get(id) ?? null };
    let state = initialState;
    for (const [action, expected] of [
        [{ type: 'data/setSheetEditAccess', editAccess: 'readonly' }, true],
        [{ type: 'data/setSheetEditAccess', editAccess: 'editable' }, false],
        [{ type: 'data/setSheetEditAccess', editAccess: 'readonly' }, true],
        [{ type: 'data/setSpreadsheetId', id: 'other' }, false],
        [{ type: 'data/setSheetEditAccess', editAccess: 'readonly' }, true],
        [{ type: 'reset/back' }, false],
        [{ type: 'data/setSheetEditAccess', editAccess: 'readonly' }, true],
        [{ type: 'data/setSheetEditAccess', editAccess: 'unknown' }, false],
    ] as const) {
        state = reducer(state, action);
        renderDecisionButtonAccess(state.data.sheetEditAccess, root);
        for (const id of ids) {
            assert.equal(buttons.get(id)!.disabled, expected, id);
        }
    }
});

test('Store の進捗文も未送信件数を表示する', () => {
    const references = [{ ref_id: 'ref', title: '文献', status: 'include', myDecision: {
        decision: 'include', reviewer_id: 'self', client_version: 'test-human',
    } }] as typeof initialState.data.references;
    const state = { ...initialState, data: { ...initialState.data, references, userEmail: 'self', unsentCount: 5 } };
    assert.equal(getEncourageMessage(state), 'screening_progressUnsent:5');
    assert.equal(getEncourageMessage({ ...state, data: { ...state.data, unsentCount: 0 } }), 'progress_complete');
});
