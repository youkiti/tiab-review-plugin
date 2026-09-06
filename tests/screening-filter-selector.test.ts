import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decision, ReferenceWithStatus } from '../src/lib/types';
import { DEFAULT_ASSIGNMENT_CONFIG, resolveReferenceAssignmentSet } from '../src/lib/assignment-set';
import { DEFAULT_FULLTEXT_ASSIGNMENT } from '../src/lib/fulltext-assignment';
import { createStore, initializeStore, initialState, type AppState, type Action } from '../src/sidepanel/store';
import { getFilteredReferences, getFilterCounts, collectRefDecisions, getMyManualDecisionStatus } from '../src/sidepanel/store/selectors';
import { state as legacyState } from '../src/sidepanel/state';
import * as compat from '../src/sidepanel/store/compat';

const userEmail = 'me@example.test';

function decision(refId: string, value: Decision['decision'], reviewerId = userEmail): Decision {
    return {
        decision_id: `${refId}:${reviewerId}`,
        ref_id: refId,
        reviewer_id: reviewerId,
        decision: value,
        decided_at: '2026-09-01T00:00:00Z',
        client_version: '0.44.0-human',
    };
}

function ref(refId: string, extra: Partial<ReferenceWithStatus> = {}): ReferenceWithStatus {
    return { ref_id: refId, title: refId, status: 'pending', ...extra };
}

function fixture(refs: ReferenceWithStatus[]): AppState {
    const state: AppState = structuredClone(initialState);
    state.data.references = refs;
    state.data.userEmail = userEmail;
    state.ui.screening.currentFilter = 'all';
    return state;
}

function ids(state: AppState): string[] {
    return getFilteredReferences(state).map(r => r.ref_id);
}

test('ステータスは自分の手動票・有効な不一致・全文候補で絞り込む', () => {
    const state = fixture([
        ref('pending'),
        ref('include', { myDecision: decision('include', 'include') }),
        ref('exclude', { myDecision: decision('exclude', 'exclude') }),
        ref('maybe', { myDecision: decision('maybe', 'maybe') }),
        ref('conflict', { allDecisions: [decision('conflict', 'exclude'), decision('conflict', 'include', 'other@example.test')] }),
        ref('publication', { related_ref_id: 'registration' }),
    ]);
    const expected: [AppState['ui']['screening']['currentFilter'], string[]][] = [
        ['pending', ['pending', 'publication']],
        ['include', ['include']],
        ['exclude', ['exclude', 'conflict']],
        ['maybe', ['maybe']],
        ['conflict', ['conflict']],
        ['fulltext_candidates', ['include', 'publication']],
        ['all', ['pending', 'include', 'exclude', 'maybe', 'conflict', 'publication']],
    ];
    for (const [filter, matches] of expected) {
        state.ui.screening.currentFilter = filter;
        assert.deepEqual(ids(state), matches, filter);
    }
    state.ui.screening.currentFilter = 'conflict';
    state.ui.screening.isKeyOpened = true;
    state.data.enabledReviewers = new Set([userEmail]);
    assert.deepEqual(ids(state), []);
});

test('ソースファイルは全選択と未選択では絞らず、一部選択で絞る', () => {
    const state = fixture([ref('a', { source_file: 'a.ris' }), ref('b', { source_file: 'b.ris' }), ref('none')]);
    state.data.sourceFiles = new Set(['a.ris', 'b.ris']);
    state.data.selectedSourceFiles = new Set(state.data.sourceFiles);
    assert.deepEqual(ids(state), ['a', 'b', 'none']);
    state.data.selectedSourceFiles = new Set(['b.ris']);
    assert.deepEqual(ids(state), ['b']);
    state.data.selectedSourceFiles = new Set();
    assert.deepEqual(ids(state), ['a', 'b', 'none']);
});

test('担当設定済みの空セットは未割り当てに入り、一部選択・全選択・未選択を区別する', () => {
    const state = fixture([ref('a', { screening_set: ' group-1 ' }), ref('b', { screening_set: 'group-2' }), ref('empty', { screening_set: ' ' })]);
    state.data.assignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG, status: 'configured' };
    state.data.assignmentSets = new Set(['group-1', 'group-2', 'unassigned']);
    state.data.selectedAssignmentSets = new Set(['group-1', 'unassigned']);
    assert.deepEqual(ids(state), ['a', 'empty']);
    state.data.selectedAssignmentSets = new Set(['unassigned']);
    assert.deepEqual(ids(state), ['empty']);
    state.data.selectedAssignmentSets = new Set(state.data.assignmentSets);
    assert.deepEqual(ids(state), ['a', 'b', 'empty']);
    state.data.selectedAssignmentSets = new Set();
    assert.deepEqual(ids(state), []);
    assert.equal(resolveReferenceAssignmentSet(ref('empty'), DEFAULT_ASSIGNMENT_CONFIG), '');
    assert.equal(resolveReferenceAssignmentSet(ref('a', { screening_set: ' group-1 ' }), DEFAULT_ASSIGNMENT_CONFIG), 'group-1');
});

test('検索AND/ORとタームをソース・担当セットの選択に重ねる', () => {
    const state = fixture([
        ref('both', { title: 'alpha beta trial', source_file: 'a', screening_set: 'group-1' }),
        ref('single', { title: 'alpha trial', source_file: 'a', screening_set: 'group-1' }),
        ref('term-miss', { title: 'alpha beta', source_file: 'a', screening_set: 'group-1' }),
        ref('source-miss', { title: 'alpha beta trial', source_file: 'b', screening_set: 'group-1' }),
        ref('set-miss', { title: 'alpha beta trial', source_file: 'a', screening_set: 'group-2' }),
    ]);
    state.data.sourceFiles = new Set(['a', 'b']);
    state.data.selectedSourceFiles = new Set(['a']);
    state.data.assignmentSets = new Set(['group-1', 'group-2']);
    state.data.selectedAssignmentSets = new Set(['group-1']);
    state.ui.screening.activeTermFilters = [{ term: 'trial', type: 'include' }];
    state.ui.screening.searchQuery = 'alpha beta';
    state.ui.settings.termFilterUseAnd = true;
    assert.deepEqual(ids(state), ['both']);
    state.ui.settings.termFilterUseAnd = false;
    assert.deepEqual(ids(state), ['both', 'single']);
});

test('Blind中はレビュアー別判定フィルターを適用しない', () => {
    const reviewerId = 'llm:test';
    const state = fixture([
        ref('include', { allDecisions: [decision('include', 'include', reviewerId)] }),
        ref('exclude', { allDecisions: [decision('exclude', 'exclude', reviewerId)] }),
        ref('missing'),
    ]);
    state.data.enabledReviewers = new Set([reviewerId]);
    state.ui.settings.aiDecisionFilter = { [reviewerId]: { include: true, exclude: false, maybe: false } };
    assert.deepEqual(ids(state), ['include', 'exclude', 'missing']);
    state.ui.screening.isKeyOpened = true;
    assert.deepEqual(ids(state), ['include']);
    state.data.enabledReviewers.clear();
    assert.deepEqual(ids(state), ['include', 'exclude', 'missing']);
});

test('全文候補はBlind中も確定した全文セットを使い、自分の担当だけを返す', () => {
    const state = fixture([
        ref('mine', { fulltext_set: 'ft-group-1' }),
        ref('other', { fulltext_set: 'ft-group-2' }),
        ref('new', { related_ref_id: 'registration' }),
    ]);
    state.ui.screening.currentFilter = 'fulltext_candidates';
    state.data.fulltextAssignment = {
        status: 'configured', groupCount: 2, reviewerMap: { 'ft-group-1': [userEmail] },
    };
    assert.deepEqual(ids(state), ['mine', 'new']);
    state.data.isAdmin = true;
    assert.deepEqual(ids(state), ['mine', 'other', 'new']);
});

test('件数selectorは従来どおりソースのみで絞り、担当・検索・ステータスは件数に影響しない', () => {
    const state = fixture([ref('a', { source_file: 'a', myDecision: decision('a', 'include') }), ref('b', { source_file: 'b' })]);
    state.data.sourceFiles = new Set(['a', 'b']);
    state.data.selectedSourceFiles = new Set(['a']);
    state.data.assignmentSets = new Set(['group-1']);
    state.ui.screening.searchQuery = 'missing';
    state.ui.screening.currentFilter = 'pending';
    assert.deepEqual(getFilterCounts(state), { pending: 0, all: 1, include: 1, exclude: 0, maybe: 0, conflict: 0, fulltextCandidates: 1 });
});

test('共通ヘルパーはmyDecisionの重複排除とMLの手動扱いを維持する', () => {
    const vote = { ...decision('a', 'include'), client_version: '0.44.0-ml' };
    const reference = ref('a', { myDecision: vote, allDecisions: [vote] });
    assert.deepEqual(collectRefDecisions(reference), [vote]);
    assert.deepEqual(collectRefDecisions(ref('a', { myDecision: vote })), [vote]);
    assert.equal(getMyManualDecisionStatus(reference, userEmail, false), 'pending');
    assert.equal(getMyManualDecisionStatus(reference, userEmail, true), 'include');
});

test('同じ検索・位置・フィルターをdispatchしても状態と通知回数は変わらない', () => {
    const store = createStore(fixture([]));
    let notifications = 0;
    store.subscribe(() => { notifications++; });
    const before = store.getState();
    store.dispatch({ type: 'screening/setSearch', query: '' });
    store.dispatch({ type: 'screening/setIndex', index: 0 });
    store.dispatch({ type: 'screening/setFilter', filter: 'all' });
    assert.equal(store.getState(), before);
    assert.equal(notifications, 0);
    store.dispatch({ type: 'screening/setIndex', index: 3 });
    const positioned = store.getState();
    store.dispatch({ type: 'screening/setIndex', index: 3 });
    assert.equal(store.getState(), positioned);
    assert.equal(notifications, 1);
    store.dispatch({ type: 'screening/setSearch', query: 'trial' });
    assert.equal(store.getState().ui.screening.currentIndex, 0);
    assert.equal(notifications, 2);
    store.dispatch({ type: 'screening/setIndex', index: 2 });
    store.dispatch({ type: 'screening/setFilter', filter: 'all' });
    assert.equal(store.getState().ui.screening.currentIndex, 0);
    store.dispatch({ type: 'screening/setIndex', index: 2 });
    store.dispatch({ type: 'screening/setSearch', query: 'trial' });
    assert.equal(store.getState().ui.screening.currentIndex, 0);
});

test('移行した値はgetterで直ちに読め、legacy setterが存在しない', () => {
    const store = initializeStore(fixture([]));
    try {
        compat.setReferences([ref('a')]);
        compat.setCurrentFilter('include');
        compat.setSearchQuery('trial');
        compat.addTermFilter('trial', 'include');
        compat.setIsKeyOpened(true);
        compat.setSourceFiles(new Set(['a']));
        compat.setSelectedSourceFiles(new Set(['a']));
        compat.setAssignmentConfig({ ...DEFAULT_ASSIGNMENT_CONFIG, status: 'configured' });
        compat.setAssignmentSets(new Set(['group-1']));
        compat.setSelectedAssignmentSets(new Set(['group-1']));
        compat.setSelectedFulltextSets(new Set(['ft-group-1']));
        compat.setCurrentIndex(3);
        const before = store.getState();
        const migratedData = ['references', 'sourceFiles', 'selectedSourceFiles', 'assignmentConfig', 'assignmentSets', 'selectedAssignmentSets', 'selectedFulltextSets'] as const;
        for (const key of migratedData) {
            assert.equal(legacyState[key], before.data[key]);
        }
        for (const key of Object.keys(before.ui.screening) as (keyof AppState['ui']['screening'])[]) {
            assert.equal(legacyState[key], before.ui.screening[key]);
            assert.equal(Object.getOwnPropertyDescriptor(legacyState, key)?.set, undefined);
            assert.equal(`set${key[0].toUpperCase()}${key.slice(1)}` in legacyState, false);
        }
        assert.equal(legacyState.allReferences, before.data.references);
        legacyState.setAllReferences([ref('all')]);
        assert.equal(legacyState.allReferences[0].ref_id, 'all');
    } finally {
        legacyState.setAllReferences([]);
        initializeStore();
    }
});

test('Issue #154 工程3で移行した9領域はgetter専用で、compatラッパーがStoreを直接更新する', () => {
    const store = initializeStore(fixture([]));
    try {
        const nineAreas = [
            'spreadsheetId', 'userEmail', 'highlightKeywords', 'isAdmin',
            'fulltextPoolRule', 'fulltextAssignment', 'availableReviewers',
            'enabledReviewers', 'currentTab',
        ] as const;
        for (const key of nineAreas) {
            assert.equal(Object.getOwnPropertyDescriptor(legacyState, key)?.set, undefined);
            assert.equal(`set${key[0].toUpperCase()}${key.slice(1)}` in legacyState, false);
        }
        // ハイライトキーワード・レビュアーのadd/removeもlegacy側からは無くなっている
        for (const method of [
            'addIncludeKeyword', 'removeIncludeKeyword', 'addExcludeKeyword', 'removeExcludeKeyword',
            'addEnabledReviewer', 'removeEnabledReviewer',
        ]) {
            assert.equal(method in legacyState, false);
        }

        compat.setSpreadsheetId('sheet-9');
        compat.setUserEmail('nine@example.test');
        compat.setKeywords({ include: [], exclude: [] });
        compat.addIncludeKeyword('rct');
        compat.addIncludeKeyword('rct'); // 重複は追加しない
        compat.addExcludeKeyword('case report');
        compat.setIsAdmin(true);
        compat.setFulltextPoolRule(null);
        compat.setFulltextAssignment({ ...DEFAULT_FULLTEXT_ASSIGNMENT });
        compat.setAvailableReviewers(new Set(['a@example.test', 'b@example.test']));
        compat.setEnabledReviewers(new Set(['a@example.test']));
        compat.addEnabledReviewer('b@example.test');
        compat.changeTab('ml');

        // compatラッパーがStoreへdispatchした値を、state.Xのgetterで直ちに同じ値として読める
        assert.equal(legacyState.spreadsheetId, store.getState().data.spreadsheetId);
        assert.equal(legacyState.userEmail, 'nine@example.test');
        assert.deepEqual(legacyState.highlightKeywords, { include: ['rct'], exclude: ['case report'] });
        assert.equal(legacyState.isAdmin, true);
        assert.equal(legacyState.fulltextPoolRule, null);
        assert.deepEqual(legacyState.fulltextAssignment, DEFAULT_FULLTEXT_ASSIGNMENT);
        assert.deepEqual(legacyState.availableReviewers, new Set(['a@example.test', 'b@example.test']));
        assert.deepEqual(legacyState.enabledReviewers, new Set(['a@example.test', 'b@example.test']));
        assert.equal(legacyState.currentTab, 'ml');

        compat.removeEnabledReviewer('a@example.test');
        assert.deepEqual(legacyState.enabledReviewers, new Set(['b@example.test']));
        compat.removeIncludeKeyword('rct');
        assert.deepEqual(legacyState.highlightKeywords.include, []);
    } finally {
        initializeStore();
    }
});

test('resetForLogout/resetForBackは9領域のうち一部だけ初期化する（loadDataAndShowScreeningでの再設定が前提）', () => {
    const store = initializeStore(fixture([]));
    try {
        compat.setSpreadsheetId('sheet-9');
        compat.setUserEmail('nine@example.test');
        compat.setKeywords({ include: ['rct'], exclude: [] });
        compat.setIsAdmin(true);
        compat.setFulltextPoolRule(null);
        compat.setFulltextAssignment({ ...DEFAULT_FULLTEXT_ASSIGNMENT, status: 'configured' });
        compat.setAvailableReviewers(new Set(['a@example.test']));
        compat.setEnabledReviewers(new Set(['a@example.test']));
        compat.changeTab('ml');

        // reset/back: spreadsheetId・fulltextPoolRule・fulltextAssignment・availableReviewers・
        // enabledReviewers は初期化するが、userEmail・isAdmin・highlightKeywords・currentTab は保持する
        // （store/reducer.ts の 'reset/back' ケースの内容と一致）
        compat.resetForBack();
        assert.equal(store.getState().data.spreadsheetId, '');
        assert.equal(store.getState().data.fulltextPoolRule, null);
        assert.deepEqual(store.getState().data.fulltextAssignment, DEFAULT_FULLTEXT_ASSIGNMENT);
        assert.deepEqual(store.getState().data.availableReviewers, new Set());
        assert.deepEqual(store.getState().data.enabledReviewers, new Set());
        assert.equal(store.getState().data.userEmail, 'nine@example.test');
        assert.equal(store.getState().data.isAdmin, true);
        assert.deepEqual(store.getState().data.highlightKeywords, { include: ['rct'], exclude: [] });
        assert.equal(store.getState().ui.currentTab, 'ml');

        // reset/logout: initialStateへ戻るため9領域すべて初期値に戻る。
        // highlightKeywords・availableReviewers・enabledReviewers はlegacy resetForLogout()は
        // 保持していたが、loadDataAndShowScreening()（features/project.ts）がプロジェクト読み込み時に
        // 必ず syncSetKeywords/syncSetAvailableReviewers/syncSetEnabledReviewers で再設定するため、
        // ログイン直後の画面には値が表示されない期間しかなく実害はない。
        compat.setUserEmail('nine@example.test');
        compat.setKeywords({ include: ['rct'], exclude: [] });
        compat.setAvailableReviewers(new Set(['a@example.test']));
        compat.setEnabledReviewers(new Set(['a@example.test']));
        compat.resetForLogout();
        assert.equal(store.getState().data.spreadsheetId, '');
        assert.equal(store.getState().data.userEmail, '');
        assert.equal(store.getState().data.isAdmin, false);
        assert.deepEqual(store.getState().data.highlightKeywords, { include: [], exclude: [] });
        assert.equal(store.getState().data.fulltextPoolRule, null);
        assert.deepEqual(store.getState().data.fulltextAssignment, DEFAULT_FULLTEXT_ASSIGNMENT);
        assert.deepEqual(store.getState().data.availableReviewers, new Set());
        assert.deepEqual(store.getState().data.enabledReviewers, new Set());
        assert.equal(store.getState().ui.currentTab, 'screening');
    } finally {
        initializeStore();
    }
});

test('新しいセット操作は以前の集合を変更せず、戻る・ログアウトで担当状態を初期化する', () => {
    const store = createStore(fixture([]));
    const before = store.getState();
    const actions: Action[] = [
        { type: 'data/setAssignmentConfig', config: { ...DEFAULT_ASSIGNMENT_CONFIG, status: 'configured' } },
        { type: 'data/addAssignmentSet', setId: 'group-1' },
        { type: 'data/addSelectedAssignmentSet', setId: 'group-1' },
        { type: 'data/addSelectedFulltextSet', setId: 'ft-group-1' },
    ];
    for (const reset of ['reset/back', 'reset/logout'] as const) {
        actions.forEach(action => store.dispatch(action));
        const populated = store.getState();
        store.dispatch({ type: 'data/removeSelectedAssignmentSet', setId: 'group-1' });
        store.dispatch({ type: 'data/removeSelectedFulltextSet', setId: 'ft-group-1' });
        assert.deepEqual(populated.data.selectedAssignmentSets, new Set(['group-1']));
        assert.deepEqual(populated.data.selectedFulltextSets, new Set(['ft-group-1']));
        store.dispatch({ type: reset });
        assert.deepEqual(store.getState().data.assignmentConfig, DEFAULT_ASSIGNMENT_CONFIG);
        for (const key of ['assignmentSets', 'selectedAssignmentSets', 'selectedFulltextSets'] as const) {
            assert.equal(store.getState().data[key].size, 0);
            assert.equal(before.data[key].size, 0);
        }
    }
});
