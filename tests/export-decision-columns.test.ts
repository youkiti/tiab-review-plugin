import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectReviewerKeys,
    buildReviewerDecisionMap,
    summarizeTeamDecision,
    formatDecisionNotes,
    voteNoteText,
} from '../src/sidepanel/features/screening/decision-summary';
import type { AssignmentConfig, Decision, ReferenceWithStatus } from '../src/lib/types';

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

function makeReference(refId: string, decisions: Decision[]): ReferenceWithStatus {
    return {
        ref_id: refId,
        title: refId,
        status: 'pending',
        allDecisions: decisions,
    };
}

function makeAssignmentConfig(overrides: Partial<AssignmentConfig>): AssignmentConfig {
    return {
        status: 'none',
        calibrationSize: 0,
        groupCount: 1,
        reviewerMap: {},
        ...overrides,
    };
}

test('2人がinclude で一致 -> include / nJudged=2、byReviewer に両者', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com', 'bob@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.equal(result.teamStatus, 'include');
    assert.equal(result.nJudged, 2);
    assert.equal(result.byReviewer.size, 2);
    assert.ok(result.byReviewer.has('alice@example.com'));
    assert.ok(result.byReviewer.has('bob@example.com'));
});

test('2人で include / exclude に割れる -> conflict', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'exclude' }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com', 'bob@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.equal(result.teamStatus, 'conflict');
    assert.equal(result.nJudged, 2);
});

test('レビュアー2人だが1人しか判定していない -> incomplete', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
    ];
    const ref = makeReference('ref-1', decisions);
    // bob もプロジェクトのレビュアーだが、この文献ではまだ判定していない
    const enabled = new Set(['alice@example.com', 'bob@example.com']);
    // reviewerKeys はプロジェクト全体（他の文献でbobが判定している想定）から得る
    const otherRef = makeReference('ref-2', [
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
    ]);
    const reviewerKeys = collectReviewerKeys([ref, otherRef], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.equal(result.teamStatus, 'incomplete');
    assert.equal(result.nJudged, 1);
});

test('誰も判定していない -> pending', () => {
    const ref = makeReference('ref-1', []);
    const reviewerKeys = ['alice@example.com', 'bob@example.com'];
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.equal(result.teamStatus, 'pending');
    assert.equal(result.nJudged, 0);
});

test('レビュアーが1人だけのプロジェクトで1人が判定 -> include（incompleteにしない）', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.equal(reviewerKeys.length, 1);
    assert.equal(result.teamStatus, 'include');
    assert.equal(result.nJudged, 1);
});

test('AI(llm:)判定が人間と割れる -> conflict、AIのキーが列に含まれる', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({
            reviewer_id: 'llm:gemini-2.5-flash@2026-08-19T00:00:00Z',
            decision: 'exclude',
            client_version: 'llm-processor-v2',
        }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com', 'llm:gemini-2.5-flash@2026-08-19T00:00:00Z']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    assert.ok(reviewerKeys.includes('llm:gemini-2.5-flash@2026-08-19T00:00:00Z'));
    assert.equal(result.teamStatus, 'conflict');
});

test('treatMlAsManual=true で ML判定が手動と同一キーに集約され、false で email::ml として別キーになる', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', client_version: '0.20.3-ml' }),
    ];
    const ref = makeReference('ref-1', decisions);

    const enabledTrue = new Set(['alice@example.com']);
    const keysTrue = collectReviewerKeys([ref], enabledTrue, true);
    assert.deepEqual(keysTrue, ['alice@example.com']);

    const enabledFalse = new Set(['alice@example.com::ml']);
    const keysFalse = collectReviewerKeys([ref], enabledFalse, false);
    assert.deepEqual(keysFalse, ['alice@example.com::ml']);
});

test('同一レビュアーの判定が複数行あるとき decided_at が最新のものが採用される', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'exclude', decided_at: '2026-01-01T00:00:00Z' }),
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', decided_at: '2026-01-02T00:00:00Z' }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com']);
    const map = buildReviewerDecisionMap(ref, enabled, true);

    assert.equal(map.size, 1);
    assert.equal(map.get('alice@example.com')?.decision, 'include');
});

test('decision が pending の判定行は未判定として扱われる', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'pending' }),
    ];
    const ref = makeReference('ref-1', decisions);
    const enabled = new Set(['alice@example.com']);
    const map = buildReviewerDecisionMap(ref, enabled, true);

    assert.equal(map.size, 0);
});

test('enabledReviewers から外したレビュアーは列にも集計にも出ない', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'exclude' }),
    ];
    const ref = makeReference('ref-1', decisions);
    // bob を無効化（残す積が空にならない前提: alice が残っている）
    const enabled = new Set(['alice@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);

    assert.deepEqual(reviewerKeys, ['alice@example.com']);

    const map = buildReviewerDecisionMap(ref, enabled, true);
    assert.equal(map.size, 1);
    assert.ok(!map.has('bob@example.com'));
});

test('collectReviewerKeys: enabledReviewersとの積が空ならフォールバックして全キーを返す', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'exclude' }),
    ];
    const ref = makeReference('ref-1', decisions);
    // 判定者と全く重ならない enabledReviewers（積が空になるケース）
    const enabled = new Set(['nobody@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);

    assert.deepEqual(reviewerKeys, ['alice@example.com', 'bob@example.com']);
});

test('collectReviewerKeys のフォールバックで得た reviewerKeys を渡しても summarizeTeamDecision で判定が消えない', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'exclude' }),
    ];
    const ref = makeReference('ref-1', decisions);
    // 積が空になるので collectReviewerKeys は全キーにフォールバックする
    const enabled = new Set(['nobody@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true);

    // 生の enabledReviewers（nobody のみ）で再フィルタしていたら nJudged は 0 になってしまう
    assert.equal(result.nJudged, 2);
    assert.equal(result.teamStatus, 'conflict');
});

test('collectReviewerKeys の並び順が 人間 -> ML -> AI になる', () => {
    const decisions = [
        makeDecision({ reviewer_id: 'llm:gemini@2026-01-01T00:00:00Z', decision: 'include', client_version: 'llm-processor-v2' }),
        makeDecision({ reviewer_id: 'zack@example.com', decision: 'include', client_version: '0.20.3-ml' }),
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
    ];
    const ref = makeReference('ref-1', decisions);
    // treatMlAsManual=false なので zack は zack@example.com::ml として ML グループになる
    const enabled = new Set([
        'llm:gemini@2026-01-01T00:00:00Z',
        'zack@example.com::ml',
        'alice@example.com',
        'bob@example.com',
    ]);
    const reviewerKeys = collectReviewerKeys([ref], enabled, false);

    assert.deepEqual(reviewerKeys, [
        'alice@example.com',
        'bob@example.com',
        'zack@example.com::ml',
        'llm:gemini@2026-01-01T00:00:00Z',
    ]);
});

test('formatDecisionNotes が reason とメモを結合し、llm: のJSON noteから reason を取り出す', () => {
    const humanDecision = makeDecision({
        reviewer_id: 'alice@example.com',
        decision: 'exclude',
        reason: 'wrong_population',
        note: '対象人口が異なる',
    });
    const llmDecision = makeDecision({
        reviewer_id: 'llm:gemini@2026-01-01T00:00:00Z',
        decision: 'exclude',
        client_version: 'llm-processor-v2',
        note: JSON.stringify({ reason: 'AI評価: 対象外の集団', evidence: ['...'] }),
    });
    const emptyDecision = makeDecision({
        reviewer_id: 'carol@example.com',
        decision: 'include',
    });

    const byReviewer = new Map<string, Decision>([
        ['alice@example.com', humanDecision],
        ['llm:gemini@2026-01-01T00:00:00Z', llmDecision],
        ['carol@example.com', emptyDecision],
    ]);
    const reviewerKeys = ['alice@example.com', 'carol@example.com', 'llm:gemini@2026-01-01T00:00:00Z'];

    const result = formatDecisionNotes(byReviewer, reviewerKeys);

    assert.equal(
        result,
        'alice@example.com: [wrong_population] 対象人口が異なる / llm:gemini@2026-01-01T00:00:00Z: AI評価: 対象外の集団'
    );
});

// ---- 分母（nExpected）まわり: assignmentConfig と AI複数バッチのフォールバック ----

test('AI複数バッチ（別reviewer_id）でも人間2人が一致していれば incomplete にならない', () => {
    // 文献ごとにどちらか一方のAIバッチだけが判定している状況を再現する
    const ref1 = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'llm:m@2026-01-01T00:00:00Z', decision: 'include', client_version: 'llm-processor-v2' }),
    ]);
    const ref2 = makeReference('ref-2', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'llm:m@2026-01-02T00:00:00Z', decision: 'include', client_version: 'llm-processor-v2' }),
    ]);
    const enabled = new Set([
        'alice@example.com', 'bob@example.com',
        'llm:m@2026-01-01T00:00:00Z', 'llm:m@2026-01-02T00:00:00Z',
    ]);
    const reviewerKeys = collectReviewerKeys([ref1, ref2], enabled, true);

    assert.ok(reviewerKeys.includes('llm:m@2026-01-01T00:00:00Z'));
    assert.ok(reviewerKeys.includes('llm:m@2026-01-02T00:00:00Z'));

    const result = summarizeTeamDecision(ref1, reviewerKeys, true);
    assert.equal(result.nExpected, 2);
    assert.equal(result.nJudged, 2);
    assert.equal(result.teamStatus, 'include');
});

test('assignmentConfig指定時でもAIと人間の不一致は従来どおりconflict', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { setA: ['alice@example.com', 'bob@example.com'] },
    });
    const ref = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'llm:m@2026-01-01T00:00:00Z', decision: 'exclude', client_version: 'llm-processor-v2' }),
    ]);
    ref.screening_set = 'setA';
    const enabled = new Set(['alice@example.com', 'bob@example.com', 'llm:m@2026-01-01T00:00:00Z']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true, config);

    assert.equal(result.nExpected, 2);
    assert.equal(result.nJudged, 2);
    assert.equal(result.teamStatus, 'conflict');
});

test('AIだけが判定していて人間が誰も判定していない -> pending、nJudged===0', () => {
    const ref1 = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'llm:m@2026-01-01T00:00:00Z', decision: 'include', client_version: 'llm-processor-v2' }),
    ]);
    // 他の文献で人間2人が判定している想定（reviewerKeys にプロジェクトの人間レビュアーが乗る）
    const otherRef = makeReference('ref-2', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
        makeDecision({ reviewer_id: 'bob@example.com', decision: 'include' }),
    ]);
    const enabled = new Set(['alice@example.com', 'bob@example.com', 'llm:m@2026-01-01T00:00:00Z']);
    const reviewerKeys = collectReviewerKeys([ref1, otherRef], enabled, true);
    const result = summarizeTeamDecision(ref1, reviewerKeys, true);

    assert.equal(result.teamStatus, 'pending');
    assert.equal(result.nJudged, 0);
});

test('人間レビュアーが1人も存在しないプロジェクト（AI判定のみ）-> pending、nJudged===0、nExpected===0（AIの判定値が漏れない）', () => {
    const ref1 = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'llm:m@2026-01-01T00:00:00Z', decision: 'include', client_version: 'llm-processor-v2' }),
    ]);
    // プロジェクト全体でAI判定しか存在しない想定（reviewerKeys に人間のキーが一切乗らない）
    const enabled = new Set(['llm:m@2026-01-01T00:00:00Z']);
    const reviewerKeys = collectReviewerKeys([ref1], enabled, true);
    const result = summarizeTeamDecision(ref1, reviewerKeys, true);

    assert.equal(result.teamStatus, 'pending');
    assert.equal(result.nJudged, 0);
    assert.equal(result.nExpected, 0);
});

test('treatMlAsManual=false でも email と email::ml は同一人物として畳まれ incomplete にならない', () => {
    const ref1 = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', client_version: '0.20.3-human' }),
    ]);
    const ref2 = makeReference('ref-2', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include', client_version: '0.20.3-ml' }),
    ]);
    const enabled = new Set(['alice@example.com', 'alice@example.com::ml']);
    const reviewerKeys = collectReviewerKeys([ref1, ref2], enabled, false);

    // 生キーとしては別キーのまま列に出る
    assert.ok(reviewerKeys.includes('alice@example.com'));
    assert.ok(reviewerKeys.includes('alice@example.com::ml'));

    const result = summarizeTeamDecision(ref2, reviewerKeys, false);
    assert.equal(result.nExpected, 1);
    assert.equal(result.nJudged, 1);
    assert.notEqual(result.teamStatus, 'incomplete');
    assert.equal(result.teamStatus, 'include');
});

test('assignmentConfig指定時: 通常セットは reviewerMap[setId] が分母（未着手の担当者も分母に入る）', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { setA: ['a@x.com', 'b@y.com'] },
    });
    const ref = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'a@x.com', decision: 'include' }),
    ]);
    ref.screening_set = 'setA';
    const enabled = new Set(['a@x.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true, config);

    assert.equal(result.nExpected, 2);
    assert.equal(result.nJudged, 1);
    assert.equal(result.teamStatus, 'incomplete');
});

test('assignmentConfig指定時: calibration セットは reviewerMap 全体の和集合が分母になる', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: {
            'group-1': ['a@x.com', 'b@y.com'],
            'group-2': ['c@z.com'],
        },
    });
    const ref = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'a@x.com', decision: 'include' }),
    ]);
    ref.screening_set = 'calibration';
    const enabled = new Set(['a@x.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true, config);

    assert.equal(result.nExpected, 3);
    assert.equal(result.nJudged, 1);
    assert.equal(result.teamStatus, 'incomplete');
});

test('assignmentConfig.status===\'none\' のときは観測実績ベースにフォールバックする', () => {
    const config = makeAssignmentConfig({ status: 'none' });
    const ref = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'alice@example.com', decision: 'include' }),
    ]);
    const enabled = new Set(['alice@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true, config);

    assert.equal(result.nExpected, 1);
    assert.equal(result.teamStatus, 'include');
});

test('名簿外の人が判定しても分母を満たしたことにならない（nJudgedの交差）', () => {
    const config = makeAssignmentConfig({
        status: 'configured',
        reviewerMap: { setA: ['a@x.com', 'b@y.com'] },
    });
    const ref = makeReference('ref-1', [
        makeDecision({ reviewer_id: 'carol@example.com', decision: 'include' }),
    ]);
    ref.screening_set = 'setA';
    const enabled = new Set(['carol@example.com']);
    const reviewerKeys = collectReviewerKeys([ref], enabled, true);
    const result = summarizeTeamDecision(ref, reviewerKeys, true, config);

    assert.equal(result.nExpected, 2);
    assert.equal(result.nJudged, 0);
    assert.equal(result.teamStatus, 'pending');
});

// ---- voteNoteText / formatDecisionNotes: TiAb の reasons(配列) 形式 ----

test('voteNoteText はTiAb形（reasons配列）のJSON noteから reasons を「; 」連結で取り出す', () => {
    const note = JSON.stringify({
        type: 'llm',
        execution_id: 'exec-1',
        model: 'gemini-2.5-flash',
        include_probability: 0.9,
        reasons: ['population mismatch', 'no control group'],
        evidence: [{ quote: '...' }],
        prompt_version: 'v1',
        usageMetadata: { totalTokenCount: 100 },
    });
    const result = voteNoteText('llm:gemini-2.5-flash@2026-01-01T00:00:00Z', note);
    assert.equal(result, 'population mismatch; no control group');
});

test('voteNoteText はフルテキスト形（reason単数）のJSON noteは従来どおり reason をそのまま返す', () => {
    const note = JSON.stringify({ type: 'llm_fulltext', reason: 'wrong population', evidence: [] });
    const result = voteNoteText('llm:gemini-2.5-flash@2026-01-01T00:00:00Z', note);
    assert.equal(result, 'wrong population');
});

test('formatDecisionNotes はTiAb形（reasons配列）のnoteでも生JSONを出さない', () => {
    const llmDecision = makeDecision({
        reviewer_id: 'llm:gemini@2026-01-01T00:00:00Z',
        decision: 'exclude',
        client_version: 'llm-processor-v2',
        note: JSON.stringify({
            type: 'llm',
            reasons: ['wrong population', 'no outcome data'],
            evidence: [],
            usageMetadata: {},
        }),
    });
    const byReviewer = new Map<string, Decision>([[llmDecision.reviewer_id, llmDecision]]);
    const reviewerKeys = [llmDecision.reviewer_id];

    const result = formatDecisionNotes(byReviewer, reviewerKeys);

    assert.equal(result, 'llm:gemini@2026-01-01T00:00:00Z: wrong population; no outcome data');
    assert.ok(!result.includes('{'));
});
