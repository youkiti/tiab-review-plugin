import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
