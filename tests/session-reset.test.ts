import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { AppState } from '../src/sidepanel/store/types';
import {
    createInitialState,
    initialState,
    reducer,
    KEPT_ON_BACK,
    KEPT_ON_LOGOUT,
} from '../src/sidepanel/store/reducer';
import { initializeStore } from '../src/sidepanel/store';
import * as compat from '../src/sidepanel/store/compat';
import {
    state,
    createLegacySessionState,
    _getLegacySessionStateForTest,
    type LegacySessionState,
} from '../src/sidepanel/state';
import {
    registerSessionReset,
    runSessionResets,
    _getSessionResetNamesForTest,
    _clearSessionResetsForTest,
} from '../src/sidepanel/session-reset';
import { resetFulltextSession } from '../src/sidepanel/features/fulltext/tab';
import {
    createFulltextTabSession,
    _getFulltextTabSessionForTest,
} from '../src/sidepanel/features/fulltext/tab';
import {
    createFulltextAiSession,
    _getFulltextAiSessionForTest,
    type FulltextAiSessionState,
} from '../src/sidepanel/features/fulltext/ai';
import {
    createFulltextResultsSession,
    _getFulltextResultsSessionForTest,
    type FulltextResultsSessionState,
} from '../src/sidepanel/features/fulltext/results';
import {
    createFulltextChecklistSession,
    _getFulltextChecklistSessionForTest,
    _getFulltextChecklistStoredForTest,
    _setFulltextChecklistStoredForTest,
    type FulltextChecklistSessionState,
} from '../src/sidepanel/features/fulltext/checklist';
import {
    createPublicationCandidatesSession,
    _getPublicationCandidatesSessionForTest,
    type PublicationCandidatesSessionState,
} from '../src/sidepanel/features/fulltext/publication-candidates';
import {
    createReasonEditorSession,
    _getReasonEditorSessionForTest,
    type ReasonEditorSessionState,
} from '../src/sidepanel/features/fulltext/reason-editor';
import type { FulltextTabSessionState } from '../src/sidepanel/features/fulltext/tab';
import { parseUserSettings } from '../src/lib/user-settings';
import { createInitialMlState } from '../src/lib/ml/types';

/**
 * 戻る・ログアウトの初期化の網羅テスト。
 * 型注釈つきの完全なリテラルにしてあるので、AppState / LegacySessionState に項目を足すと
 * この fixture を更新するまで typecheck が落ちる。
 */

function dirtyState(): AppState {
    return {
        data: {
            references: [{ ref_id: 'r1' } as AppState['data']['references'][number]],
            spreadsheetId: 'sheet-x',
            userEmail: 'dirty@example.test',
            highlightKeywords: { include: ['rct'], exclude: ['case report'] },
            llmConfig: { ...createInitialState().data.llmConfig, llm_screening_prompt: 'dirty prompt' },
            mlState: { ...createInitialMlState(), isTraining: true } as AppState['data']['mlState'],
            isAdmin: true,
            sheetEditAccess: 'editable',
            unsentCount: 3,
            fulltextPoolRule: { dirty: true } as unknown as AppState['data']['fulltextPoolRule'],
            fulltextAssignment: { ...createInitialState().data.fulltextAssignment, status: 'configured' },
            assignmentConfig: { ...createInitialState().data.assignmentConfig, status: 'configured' },
            assignmentSets: new Set(['s1']),
            selectedAssignmentSets: new Set(['s1']),
            selectedFulltextSets: new Set(['s1']),
            sourceFiles: new Set(['f1']),
            selectedSourceFiles: new Set(['f1']),
            availableReviewers: new Set(['a@example.test']),
            enabledReviewers: new Set(['a@example.test']),
            activeLlmExecutionIds: new Set(['e1']),
            currentBatchDecisions: [{ ref_id: 'r1' } as AppState['data']['currentBatchDecisions'][number]],
            failedRefIds: ['r1'],
            failedSourceExecutionId: 'e1',
        },
        ui: {
            view: 'screening',
            currentTab: 'ml',
            screening: {
                currentIndex: 4,
                currentFilter: 'all',
                searchQuery: 'dirty query',
                isKeyOpened: true,
                activeTermFilters: [{ term: 'x', type: 'include' }],
            },
            flags: { loading: true, exportMenuOpen: true, shareInputOpen: true, settingsOpen: true },
            settings: { ...parseUserSettings({}), autoNavigateAfterDecision: !parseUserSettings({}).autoNavigateAfterDecision },
            toast: { message: 'dirty', duration: 1 },
        },
    };
}

function dirtyLegacy(): LegacySessionState {
    return {
        allReferences: [{ ref_id: 'r1' } as LegacySessionState['allReferences'][number]],
        reviewHistoryRefIds: ['r1'],
        reviewHistoryCursor: 0,
        reviewHistoryReturnRefId: 'r2',
        lastRenderedRefId: 'r1',
        importStats: { dirty: {} } as unknown as LegacySessionState['importStats'],
        reviewCriteria: { dirty: true } as unknown as LegacySessionState['reviewCriteria'],
        excludeReasonConfig: { dirty: true } as unknown as LegacySessionState['excludeReasonConfig'],
        // AbortController は中止の検査と分けるため、この検査では null にしておく
        batchAbortController: null,
        currentExecutionId: 'e1',
        llmRuns: [{ run_id: 'run' } as LegacySessionState['llmRuns'][number]],
        llmExecutions: [{ execution_id: 'e1' } as LegacySessionState['llmExecutions'][number]],
        forceNewLlmRun: true,
        llmTargetMode: 'selection',
        llmTargetRefIds: new Set(['r1']),
        consensusMode: true,
    };
}

type Kept = { readonly data: readonly string[]; readonly ui: readonly string[] };

function assertReset(dirty: AppState, after: AppState, kept: Kept, view: AppState['ui']['view']): void {
    const initial = createInitialState();
    for (const key of Object.keys(initial.data) as (keyof AppState['data'])[]) {
        const expected = kept.data.includes(key) ? dirty.data[key] : initial.data[key];
        assert.deepEqual(after.data[key], expected, `data.${key}`);
    }
    for (const key of Object.keys(initial.ui) as (keyof AppState['ui'])[]) {
        if (key === 'view') continue;
        const expected = kept.ui.includes(key) ? dirty.ui[key] : initial.ui[key];
        assert.deepEqual(after.ui[key], expected, `ui.${key}`);
    }
    assert.equal(after.ui.view, view);
}

test('fixture は AppState の全項目を初期値と違う値にしている（足し忘れの検出）', () => {
    const dirty = dirtyState();
    const initial = createInitialState();
    for (const key of Object.keys(initial.data) as (keyof AppState['data'])[]) {
        assert.notDeepEqual(dirty.data[key], initial.data[key], `data.${key}`);
    }
    for (const key of Object.keys(initial.ui) as (keyof AppState['ui'])[]) {
        assert.notDeepEqual(dirty.ui[key], initial.ui[key], `ui.${key}`);
    }
    for (const key of Object.keys(initial.ui.screening) as (keyof AppState['ui']['screening'])[]) {
        assert.notDeepEqual(dirty.ui.screening[key], initial.ui.screening[key], `ui.screening.${key}`);
    }
    for (const key of Object.keys(initial.ui.flags) as (keyof AppState['ui']['flags'])[]) {
        assert.notDeepEqual(dirty.ui.flags[key], initial.ui.flags[key], `ui.flags.${key}`);
    }
});

test('reset/back は KEPT_ON_BACK 以外をすべて初期値に戻す', () => {
    const dirty = dirtyState();
    const after = reducer(dirty, { type: 'reset/back' });
    assertReset(dirty, after, KEPT_ON_BACK, 'project');
    assert.equal(after.data.userEmail, 'dirty@example.test');
});

test('reset/logout は KEPT_ON_LOGOUT 以外をすべて初期値に戻す', () => {
    const dirty = dirtyState();
    const after = reducer(dirty, { type: 'reset/logout' });
    assertReset(dirty, after, KEPT_ON_LOGOUT, 'login');
    assert.equal(after.data.userEmail, '');
});

test('初期化後の Set・配列は initialState の実体と別物', () => {
    for (const type of ['reset/back', 'reset/logout'] as const) {
        const after = reducer(dirtyState(), { type });
        assert.notEqual(after.data.sourceFiles, initialState.data.sourceFiles);
        assert.notEqual(after.data.enabledReviewers, initialState.data.enabledReviewers);
        assert.notEqual(after.data.currentBatchDecisions, initialState.data.currentBatchDecisions);
        assert.notEqual(after.ui.screening.activeTermFilters, initialState.ui.screening.activeTermFilters);
    }
});

test('state.ts の legacy セッション状態は戻る・ログアウトで全項目が初期値に戻る', () => {
    const dirty = dirtyLegacy();
    const initial = createLegacySessionState();
    for (const key of Object.keys(initial) as (keyof LegacySessionState)[]) {
        if (key === 'batchAbortController') continue;
        assert.notDeepEqual(dirty[key], initial[key], key);
    }
    for (const reset of [() => state.resetForBack(), () => state.resetForLogout()]) {
        Object.assign(_getLegacySessionStateForTest(), dirtyLegacy());
        reset();
        assert.deepEqual(_getLegacySessionStateForTest(), createLegacySessionState());
    }
});

test('state.ts の最上位の let は _session の1つだけ（モジュール変数は LegacySessionState に入れる）', () => {
    const source = readFileSync('src/sidepanel/state.ts', 'utf8');
    const matches = source.match(/^let\s/gm) ?? [];
    assert.equal(matches.length, 1);
    assert.match(source, /^let _session\b/m);
});

test('実行中の一括判定がある状態で戻る・ログアウトすると中止して制御を捨てる', () => {
    initializeStore();
    try {
        for (const reset of [compat.resetForBack, compat.resetForLogout]) {
            const controller = new AbortController();
            state.setBatchAbortController(controller);
            assert.equal(reset(), true);
            assert.equal(controller.signal.aborted, true);
            assert.equal(state.batchAbortController, null);
            // 実行中が無ければ false
            assert.equal(reset(), false);
        }
    } finally {
        initializeStore();
    }
});

// ---------------------------------------------------------------------------
// 遅延チャンクの機能の初期化の登録（session-reset.ts）
// ---------------------------------------------------------------------------

test('resetForBack・resetForLogout は登録された初期化を呼び、true が返ると戻り値が true になる', () => {
    initializeStore();
    _clearSessionResetsForTest();
    try {
        for (const [reset, reason] of [[compat.resetForBack, 'back'], [compat.resetForLogout, 'logout']] as const) {
            const reasons: string[] = [];
            let aborted = false;
            registerSessionReset('probe', r => { reasons.push(r); return aborted; });
            assert.equal(reset(), false);
            aborted = true;
            assert.equal(reset(), true);
            assert.deepEqual(reasons, [reason, reason]);
        }
        // 登録が無ければ今までどおり（一括判定の中止だけで決まる）
        _clearSessionResetsForTest();
        assert.equal(compat.resetForBack(), false);
        // 一括判定の中止と登録された初期化の結果は OR される
        registerSessionReset('probe', () => true);
        state.setBatchAbortController(new AbortController());
        assert.equal(compat.resetForLogout(), true);
    } finally {
        _clearSessionResetsForTest();
        initializeStore();
    }
});

test('登録された初期化は、Store と state.ts の初期化より前に呼ばれる', () => {
    initializeStore();
    _clearSessionResetsForTest();
    try {
        compat.setReferences([{ ref_id: 'r1' } as AppState['data']['references'][number]]);
        let seenReferences = -1;
        registerSessionReset('probe', () => {
            seenReferences = state.references.length;
            return false;
        });
        compat.resetForBack();
        assert.equal(seenReferences, 1);
        assert.equal(state.references.length, 0);
    } finally {
        _clearSessionResetsForTest();
        initializeStore();
    }
});

// ---------------------------------------------------------------------------
// 全文タブのセッション状態（features/fulltext/）
// ---------------------------------------------------------------------------

/** 型注釈つきの完全なリテラル。各ファイルの State に項目を足すと、この fixture を更新するまで typecheck が落ちる */
function dirtyFulltextAi(): FulltextAiSessionState {
    return {
        aiAbort: { cancelled: false },
        aiInitialized: true,
        aiScope: 'assigned',
        judgedRefIds: new Set(['r1']),
    };
}

function dirtyFulltextTab(): FulltextTabSessionState {
    return {
        viewFilter: 'missing',
        bulkRun: { cancelled: false },
        uploadTargetRefId: 'r1',
        publicationCandidates: [{ candidate_id: 'c1' } as FulltextTabSessionState['publicationCandidates'][number]],
    };
}

function dirtyFulltextResults(): FulltextResultsSessionState {
    return { currentMode: 'results', resultsMode: true, enabledJudges: new Set(['a@example.test']) };
}

function dirtyFulltextChecklist(): FulltextChecklistSessionState {
    return {
        lastCandidates: [{ ref_id: 'r1' } as FulltextChecklistSessionState['lastCandidates'][number]],
        manualOpenOverride: true,
        lastRegrantResultKey: 'sheet-x|dirty@example.test',
        permissionsSnapshot: { linkShareRole: 'reader', folderPermissionEmails: ['a@example.test'], folderId: 'f1' },
        permissionsSnapshotSpreadsheetId: 'sheet-x',
    };
}

function dirtyPublicationCandidates(): PublicationCandidatesSessionState {
    return { expandedRefIds: new Set(['r1']) };
}

function dirtyReasonEditor(): ReasonEditorSessionState {
    return { draft: [{ key: 'k1', label: 'dirty', labelEn: 'dirty' }] };
}

function dirtyAllFulltext(): void {
    Object.assign(_getFulltextAiSessionForTest(), dirtyFulltextAi());
    Object.assign(_getFulltextTabSessionForTest(), dirtyFulltextTab());
    Object.assign(_getFulltextResultsSessionForTest(), dirtyFulltextResults());
    Object.assign(_getFulltextChecklistSessionForTest(), dirtyFulltextChecklist());
    Object.assign(_getPublicationCandidatesSessionForTest(), dirtyPublicationCandidates());
    Object.assign(_getReasonEditorSessionForTest(), dirtyReasonEditor());
}

test('全文タブの fixture は各セッション状態の全項目を初期値と違う値にしている（足し忘れの検出）', () => {
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
        [dirtyFulltextAi() as unknown as Record<string, unknown>, createFulltextAiSession() as unknown as Record<string, unknown>, 'ai'],
        [dirtyFulltextTab() as unknown as Record<string, unknown>, createFulltextTabSession() as unknown as Record<string, unknown>, 'tab'],
        [dirtyFulltextResults() as unknown as Record<string, unknown>, createFulltextResultsSession() as unknown as Record<string, unknown>, 'results'],
        [dirtyFulltextChecklist() as unknown as Record<string, unknown>, createFulltextChecklistSession() as unknown as Record<string, unknown>, 'checklist'],
        [dirtyPublicationCandidates() as unknown as Record<string, unknown>, createPublicationCandidatesSession() as unknown as Record<string, unknown>, 'publication-candidates'],
        [dirtyReasonEditor() as unknown as Record<string, unknown>, createReasonEditorSession() as unknown as Record<string, unknown>, 'reason-editor'],
    ];
    for (const [dirty, initial, name] of pairs) {
        for (const key of Object.keys(initial)) {
            assert.notDeepEqual(dirty[key], initial[key], `${name}.${key}`);
        }
        assert.deepEqual(Object.keys(dirty).sort(), Object.keys(initial).sort(), `${name} のキー`);
    }
});

test('全文タブは setupFulltextTabListeners が登録するまで session-reset に現れない（開かなければチャンクも読まれない）', () => {
    // この時点では setupFulltextTabListeners を呼んでいない（DOM が無いため呼べない）ので、登録は空のまま
    assert.equal(_getSessionResetNamesForTest().includes('fulltext'), false);
    const tabSource = readFileSync('src/sidepanel/features/fulltext/tab.ts', 'utf8');
    assert.match(tabSource, /registerSessionReset\('fulltext', resetFulltextSession\)/);
    // compat.ts・初期バンドル側から、全文タブのモジュールを直接 import していない
    const compatSource = readFileSync('src/sidepanel/store/compat.ts', 'utf8');
    assert.doesNotMatch(compatSource, /features\/fulltext/);
});

test('resetFulltextSession は戻る・ログアウトで全文タブの全セッション状態を初期値に戻す', () => {
    // DOM が無い（読み込み前と同じ）ので入力欄の初期化は何もしない
    for (const reason of ['back', 'logout'] as const) {
        dirtyAllFulltext();
        assert.equal(resetFulltextSession(reason), true, '実行中の処理があったので true');
        assert.deepEqual(_getFulltextAiSessionForTest(), createFulltextAiSession());
        assert.deepEqual(_getFulltextTabSessionForTest(), createFulltextTabSession());
        assert.deepEqual(_getFulltextResultsSessionForTest(), createFulltextResultsSession());
        assert.deepEqual(_getFulltextChecklistSessionForTest(), createFulltextChecklistSession());
        assert.deepEqual(_getPublicationCandidatesSessionForTest(), createPublicationCandidatesSession());
        assert.deepEqual(_getReasonEditorSessionForTest(), createReasonEditorSession());
        // 実行中の処理が無ければ false
        assert.equal(resetFulltextSession(reason), false);
    }
});

test('resetFulltextSession は実行中の全文の AI 一括判定・一括 OA 検索の中断フラグを立ててから初期化する', () => {
    dirtyAllFulltext();
    const aiRun = _getFulltextAiSessionForTest().aiAbort!;
    const bulkRun = _getFulltextTabSessionForTest().bulkRun!;
    assert.equal(aiRun.cancelled, false);
    assert.equal(bulkRun.cancelled, false);
    resetFulltextSession('back');
    assert.equal(aiRun.cancelled, true);
    assert.equal(bulkRun.cancelled, true);
    // 初期化後は実行の印が外れている（切り替えた後のプロジェクトですぐ実行を始められる）
    assert.equal(_getFulltextAiSessionForTest().aiAbort, null);
    assert.equal(_getFulltextTabSessionForTest().bulkRun, null);
    assert.equal(_getFulltextAiSessionForTest().aiInitialized, false);
});

test('一括 OA 検索だけが実行中でも、AI 判定だけが実行中でも true を返す', () => {
    dirtyAllFulltext();
    _getFulltextAiSessionForTest().aiAbort = null;
    assert.equal(resetFulltextSession('back'), true);
    dirtyAllFulltext();
    _getFulltextTabSessionForTest().bulkRun = null;
    assert.equal(resetFulltextSession('back'), true);
});

test('アクセスの確認結果は、戻るでは残り、ログアウトでは消える', () => {
    const stored = { 'sheet-x|dirty@example.test': { unreadableCount: 2, totalCachedCount: 5, checkedAt: '2026-01-01T00:00:00.000Z' } };
    _setFulltextChecklistStoredForTest(stored, ['sheet-x|dirty@example.test']);
    resetFulltextSession('back');
    assert.deepEqual(_getFulltextChecklistStoredForTest(), { storedResults: stored, storedResultsLoaded: true, confirmed: ['sheet-x|dirty@example.test'] });
    resetFulltextSession('logout');
    assert.deepEqual(_getFulltextChecklistStoredForTest(), { storedResults: {}, storedResultsLoaded: false, confirmed: [] });
});

test('権限の取得中に初期化すると、取得結果を捨てる印（spreadsheetId を空にする）が立つ', () => {
    dirtyAllFulltext();
    resetFulltextSession('back');
    // checklist.ts は取得完了時に permissionsSnapshotSpreadsheetId の一致を見て結果を捨てる
    assert.equal(_getFulltextChecklistSessionForTest().permissionsSnapshotSpreadsheetId, '');
    assert.equal(_getFulltextChecklistSessionForTest().permissionsSnapshot, null);
});

// ---------------------------------------------------------------------------
// 最上位のモジュール変数の検査（全文タブ。足し忘れの検出）
// ---------------------------------------------------------------------------

/**
 * src/sidepanel/features/fulltext/ 配下の最上位の let と `const X = new Set|Map` の許可の一覧。
 * 全文タブにモジュール変数を足すときは、そのファイルの `session`（戻る・ログアウトで作り直す）に入れるか、
 * 残す理由をここに書いて足す。
 */
const FULLTEXT_TOP_LEVEL_ALLOWED: Record<string, string> = {
    // 配線（プロジェクトに属さない）
    '_rerenderTab': '再描画の関数の配線（assignment-ui.ts・results.ts・drive-import/result-view.ts）',
    'feature': '読み込んだチャンク（lazy.ts）',
    'activation': '読み込み中の合流（lazy.ts。プロジェクトの切替で捨てられる）',
    'deps': '依存の配線（publication-candidates.ts）',
    // 中止しない短い処理の実行中の印（各処理の終わりで今までどおり戻る）
    'regrantInProgress': 'アクセスの再付与の確認の実行中',
    'importInProgress': 'Drive からの取り込みの実行中',
    '_ftSaving': '担当の保存中',
    '_wizardOpen': '担当の設定の画面が開いているか',
    'importInFlight': '論文候補の取り込みの実行中の印',
    'dismissInFlight': '論文候補の却下の実行中の印',
    'importedRefIdByCandidateId': '論文候補の取り込みの途中で失敗したときの復旧用',
    // 各ファイルのまとめたオブジェクト
    'session': '戻る・ログアウトで作り直すセッション状態',
    // アクセスの確認結果（キーにプロジェクトとアカウントを含む。ログアウトのときだけ消す）
    'storedResults': 'checklist.ts: ログアウトで消す（resetFulltextChecklistSession）',
    'storedResultsLoaded': 'checklist.ts: ログアウトで戻す',
    'confirmedThisSession': 'checklist.ts: ログアウトで消す',
    'permissionsSnapshotLoading': 'checklist.ts: 取得の完了・失敗でだけ変える（結果は session の印で捨てる）',
};

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...listTsFiles(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

test('全文タブの最上位の let と new Set/Map は、許可の一覧にあるものだけ', () => {
    const unknown: string[] = [];
    for (const file of listTsFiles('src/sidepanel/features/fulltext')) {
        const source = readFileSync(file, 'utf8');
        const names = [
            ...[...source.matchAll(/^let\s+(\w+)/gm)].map(m => m[1]),
            ...[...source.matchAll(/^const\s+(\w+)\s*=\s*new\s+(?:Set|Map)\b/gm)].map(m => m[1]),
        ];
        for (const name of names) {
            if (!(name in FULLTEXT_TOP_LEVEL_ALLOWED)) unknown.push(`${file}: ${name}`);
        }
    }
    assert.deepEqual(unknown, [], '全文タブにモジュール変数を足したときは、session に入れるか、許可の一覧に残す理由を書いて足す');
});
