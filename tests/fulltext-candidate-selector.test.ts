import test from 'node:test';
import assert from 'node:assert/strict';
import { getFilteredReferences, getFilterCounts } from '../src/sidepanel/store/selectors';
import type { AppState } from '../src/sidepanel/store/types';
import type { Decision, ReferenceWithStatus } from '../src/lib/types';
import type { FulltextPoolRule } from '../src/lib/fulltext-pool';
import type { FulltextAssignmentConfig } from '../src/lib/fulltext-assignment';

let seq = 0;
function makeDecision(overrides: Partial<Decision>): Decision {
    seq++;
    return {
        decision_id: `decision-${seq}`,
        ref_id: 'ref-1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
        client_version: '0.20.3-human',
        screening_phase: 'tiab',
        ...overrides,
    };
}

function makeReference(refId: string, decisions: Decision[], myDecision?: Decision): ReferenceWithStatus {
    return {
        ref_id: refId,
        title: refId,
        status: 'pending',
        allDecisions: decisions,
        myDecision,
    };
}

function makeState(params: {
    references: ReferenceWithStatus[];
    userEmail?: string;
    isAdmin?: boolean;
    fulltextPoolRule?: FulltextPoolRule | null;
    fulltextAssignment?: FulltextAssignmentConfig;
}): AppState {
    return {
        data: {
            references: params.references,
            spreadsheetId: 'sheet-1',
            userEmail: params.userEmail ?? 'alice@example.com',
            highlightKeywords: { include: [], exclude: [] },
            llmConfig: {} as AppState['data']['llmConfig'],
            mlState: {} as AppState['data']['mlState'],
            recentSheets: [],
            isAdmin: params.isAdmin ?? false,
            fulltextPoolRule: params.fulltextPoolRule ?? null,
            fulltextAssignment: params.fulltextAssignment
                ?? { status: 'none', groupCount: 2, reviewerMap: {} },
            sourceFiles: new Set(),
            selectedSourceFiles: new Set(),
            availableReviewers: new Set(),
            enabledReviewers: new Set(),
            activeLlmExecutionIds: new Set(),
            currentBatchDecisions: [],
            failedRefIds: [],
        },
        ui: {
            view: 'screening',
            currentTab: 'screening',
            screening: {
                currentIndex: 0,
                currentFilter: 'fulltext_candidates',
                searchQuery: '',
                isKeyOpened: true,
                activeTermFilters: [],
            },
            ml: {
                currentIndex: 0,
                searchQuery: '',
            },
            llm: {
                batchRunning: false,
                currentExecutionId: '',
            },
            flags: {
                loading: false,
                exportMenuOpen: false,
                shareInputOpen: false,
                settingsOpen: false,
            },
            settings: {
                autoNavigateAfterDecision: false,
                showRecordCountBelow: false,
                termFilterUseAnd: false,
                treatMlAsManual: false,
                showAiHighlights: false,
                aiDecisionFilter: {},
                abstractSubsectionBreakEnabled: false,
                abstractSubsectionHeadings: [],
            },
            toast: null,
        },
    };
}

test('フルテキスト候補未設定時: 非管理ユーザーは自分のTiAb Includeだけを候補にする', () => {
    const myInclude = makeDecision({ ref_id: 'ref-own', reviewer_id: 'alice@example.com' });
    const otherInclude = makeDecision({ ref_id: 'ref-other', reviewer_id: 'bob@example.com' });
    const myFulltextInclude = makeDecision({ ref_id: 'ref-fulltext', reviewer_id: 'alice@example.com', screening_phase: 'fulltext' });

    const state = makeState({
        references: [
            makeReference('ref-own', [myInclude], myInclude),
            makeReference('ref-other', [otherInclude]),
            makeReference('ref-fulltext', [myFulltextInclude], myFulltextInclude),
        ],
        isAdmin: false,
    });

    assert.deepEqual(getFilteredReferences(state).map(r => r.ref_id), ['ref-own']);
    assert.equal(getFilterCounts(state).fulltextCandidates, 1);
});

test('フルテキスト候補未設定時: 管理者は全レビュアーのTiAb Includeを候補にする', () => {
    const myInclude = makeDecision({ ref_id: 'ref-own', reviewer_id: 'alice@example.com' });
    const otherInclude = makeDecision({ ref_id: 'ref-other', reviewer_id: 'bob@example.com' });
    const otherExclude = makeDecision({ ref_id: 'ref-exclude', reviewer_id: 'bob@example.com', decision: 'exclude' });
    const fulltextInclude = makeDecision({ ref_id: 'ref-fulltext', reviewer_id: 'bob@example.com', screening_phase: 'fulltext' });

    const state = makeState({
        references: [
            makeReference('ref-own', [myInclude], myInclude),
            makeReference('ref-other', [otherInclude]),
            makeReference('ref-exclude', [otherExclude]),
            makeReference('ref-fulltext', [fulltextInclude]),
        ],
        isAdmin: true,
    });

    assert.deepEqual(getFilteredReferences(state).map(r => r.ref_id), ['ref-own', 'ref-other']);
    assert.equal(getFilterCounts(state).fulltextCandidates, 2);
});

test('フルテキスト候補ルール設定時: 管理者分岐よりルールを優先する', () => {
    const myInclude = makeDecision({ ref_id: 'ref-own', reviewer_id: 'alice@example.com' });
    const otherInclude = makeDecision({ ref_id: 'ref-other', reviewer_id: 'bob@example.com' });
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:bob@example.com'],
        threshold: 1,
    };

    const state = makeState({
        references: [
            makeReference('ref-own', [myInclude], myInclude),
            makeReference('ref-other', [otherInclude]),
        ],
        isAdmin: false,
        fulltextPoolRule: rule,
    });

    assert.deepEqual(getFilteredReferences(state).map(r => r.ref_id), ['ref-other']);
    assert.equal(getFilterCounts(state).fulltextCandidates, 1);
});

test('フルテキスト担当割り振り設定時: 非管理ユーザーは自分の担当グループ + 未割り当てのみ候補にする', () => {
    const rule: FulltextPoolRule = {
        version: 1,
        voters: ['human:alice@example.com'],
        threshold: 1,
    };
    const assignment: FulltextAssignmentConfig = {
        status: 'configured',
        groupCount: 2,
        reviewerMap: {
            'ft-group-1': ['alice@example.com'],
            'ft-group-2': ['bob@example.com'],
        },
    };
    const inc = (refId: string) => makeDecision({ ref_id: refId, reviewer_id: 'alice@example.com' });

    const mine = makeReference('ref-mine', [inc('ref-mine')]);
    mine.fulltext_set = 'ft-group-1';
    const others = makeReference('ref-others', [inc('ref-others')]);
    others.fulltext_set = 'ft-group-2';
    const unassigned = makeReference('ref-unassigned', [inc('ref-unassigned')]);

    const state = makeState({
        references: [mine, others, unassigned],
        isAdmin: false,
        fulltextPoolRule: rule,
        fulltextAssignment: assignment,
    });

    assert.deepEqual(getFilteredReferences(state).map(r => r.ref_id), ['ref-mine', 'ref-unassigned']);
    assert.equal(getFilterCounts(state).fulltextCandidates, 2);

    // 管理者は割り振りに関係なく全候補を見る
    const adminState = makeState({
        references: [mine, others, unassigned],
        isAdmin: true,
        fulltextPoolRule: rule,
        fulltextAssignment: assignment,
    });
    assert.equal(getFilteredReferences(adminState).length, 3);
});
