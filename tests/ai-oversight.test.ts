import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFulltextAiMethodsSentence, countManuscriptStoppingRuleExclusions } from '../src/lib/manuscript-ai';
import { shouldWarnAiOnlyRule } from '../src/lib/fulltext-rule-editor';
import { countAiOnlyConsensus, summarizeFulltextCandidates } from '../src/lib/fulltext-results-summary';
import { collectReviewerKeys, summarizeTeamDecision } from '../src/lib/decision-summary';
import type { Decision, ReferenceWithStatus } from '../src/lib/types';

function decision(reviewer: string, value: Decision['decision'], version = '1-human'): Decision {
    return {
        decision_id: reviewer,
        ref_id: 'ref',
        reviewer_id: reviewer,
        decision: value,
        client_version: version,
        decided_at: '2026-10-01T00:00:00Z',
    };
}

function fulltext(...votes: Decision[]): ReferenceWithStatus {
    return { ref_id: 'ref', title: '文献', status: 'pending', allFulltextDecisions: votes };
}

test('候補ルールの警告は人が不在でLLM票がある場合だけ出る', () => {
    for (const [voters, expected] of [
        [[], false],
        [['human:a'], false],
        [['ml:a'], false],
        [['llm:model'], true],
        [['llm:model', 'ml:a'], true],
        [['llm:model', 'human:a'], false],
    ] as Array<[string[], boolean]>) {
        assert.equal(shouldWarnAiOnlyRule({ version: 1, voters, threshold: 1 }), expected);
    }
});

test('AIだけの全文合議は非pending票から数え、ORの除外結果を数える', () => {
    const refs = [
        fulltext(decision('llm:a', 'exclude')),
        fulltext(decision('llm:a', 'include'), decision('llm:b', 'exclude')),
        fulltext(decision('llm:a', 'maybe')),
        fulltext(decision('llm:a', 'pending')),
        fulltext(),
        fulltext(decision('llm:a', 'exclude'), decision('human', 'pending')),
        fulltext(decision('llm:a', 'exclude'), decision('human', 'exclude')),
    ];
    assert.deepEqual(countAiOnlyConsensus(refs, new Set(['llm:a', 'llm:b', 'human'])), { total: 4, excluded: 2 });
    assert.deepEqual(countAiOnlyConsensus(refs, new Set(['human'])), { total: 0, excluded: 0 });
    assert.deepEqual(countAiOnlyConsensus(refs, new Set(['llm:a', 'llm:b'])), { total: 5, excluded: 3 });
});

test('人の裁定がある全文文献はAIだけの件数に含めず、自分の票へのフォールバックも数える', () => {
    const ref = fulltext(decision('llm:a', 'exclude'), decision('adjudication:human', 'exclude'));
    assert.deepEqual(countAiOnlyConsensus([ref], new Set(['llm:a'])), { total: 0, excluded: 0 });
    assert.deepEqual(countAiOnlyConsensus([{
        ...fulltext(), myFulltextDecision: decision('llm:a', 'exclude'),
    }], new Set(['llm:a'])), { total: 1, excluded: 1 });
});

test('ML停止基準だけの除外は人の判定人数に含めず、チーム状態の規則は変えない', () => {
    const ref: ReferenceWithStatus = {
        ref_id: 'ref', title: '文献', status: 'exclude', screening_set: 'group1',
        allDecisions: [decision('a@example.com', 'exclude', '1-ml-auto')],
    };
    for (const manual of [true, false]) {
        const keys = collectReviewerKeys([ref], new Set(), manual);
        // 担当2人のうち1人だけが一括除外した文献は、従来どおりもう1人の判定待ち
        const twoReviewers = summarizeTeamDecision(ref, keys, manual, {
            status: 'configured', calibrationSize: 0, groupCount: 1,
            reviewerMap: { group1: ['a@example.com', 'b@example.com'] },
        });
        assert.equal(twoReviewers.nJudged, 0);
        assert.equal(twoReviewers.teamStatus, 'incomplete');
        assert.equal(twoReviewers.excludedByStoppingRule, true);
        assert.equal(twoReviewers.byReviewer.size, 1);
        // 担当が1人なら従来どおり除外
        const oneReviewer = summarizeTeamDecision(ref, keys, manual, {
            status: 'configured', calibrationSize: 0, groupCount: 1,
            reviewerMap: { group1: ['a@example.com'] },
        });
        assert.equal(oneReviewer.nJudged, 0);
        assert.equal(oneReviewer.teamStatus, 'exclude');
        assert.equal(oneReviewer.excludedByStoppingRule, true);
    }
});

test('人の判定と確認済みML票は人数に含め、ML自動票と混在しても未読除外とは呼ばない', () => {
    for (const version of ['1-human', '1-ml']) {
        const ref: ReferenceWithStatus = {
            ref_id: 'ref', title: '文献', status: 'exclude',
            allDecisions: [decision('a', 'exclude', '1-ml-auto'), decision('a', 'exclude', version)],
        };
        const keys = collectReviewerKeys([ref], new Set(), true);
        const result = summarizeTeamDecision(ref, keys, true);
        assert.equal(result.nJudged, 1);
        assert.equal(result.teamStatus, 'exclude');
        assert.ok(!result.excludedByStoppingRule);
    }
});

test('ML自動判定でも除外以外を未読除外にはしない', () => {
    const ref: ReferenceWithStatus = {
        ref_id: 'ref', title: '文献', status: 'include',
        allDecisions: [decision('a', 'include', '1-ml-auto')],
    };
    const result = summarizeTeamDecision(ref, ['a::ml'], true);
    assert.equal(result.nJudged, 0);
    assert.ok(!result.excludedByStoppingRule);
});

test('人とML停止基準の票が別担当者で混在してもチーム状態と除外件数を維持する', () => {
    const ref: ReferenceWithStatus = {
        ref_id: 'ref', title: '文献', status: 'exclude',
        allDecisions: [decision('a', 'exclude', '1-ml-auto'), decision('b', 'exclude')],
    };
    const result = summarizeTeamDecision(ref, ['a::ml', 'b'], true);
    assert.equal(result.nJudged, 1);
    assert.equal(result.nExpected, 2);
    assert.equal(result.teamStatus, 'exclude');
    assert.ok(!result.excludedByStoppingRule);
    ref.allDecisions![1].decision = 'include';
    assert.equal(summarizeTeamDecision(ref, ['a::ml', 'b'], true).teamStatus, 'conflict');
});

test('論文用の未読除外件数はプロジェクト全体の実績より担当セットの人数を優先する', () => {
    const refs: ReferenceWithStatus[] = [
        { ref_id: 'single', title: '担当1人', status: 'exclude', screening_set: 'group1',
            allDecisions: [decision('a', 'exclude', '1-ml-auto')] },
        { ref_id: 'pair', title: '担当2人', status: 'exclude', screening_set: 'group2',
            allDecisions: [decision('b', 'exclude', '1-ml-auto')] },
    ];
    for (const manual of [true, false]) {
        const keys = collectReviewerKeys(refs, new Set(), manual);
        assert.equal(countManuscriptStoppingRuleExclusions(refs, keys, manual, null), 0);
        const config = {
            status: 'configured' as const, calibrationSize: 0, groupCount: 2,
            reviewerMap: { group1: ['a'], group2: ['b', 'c'] },
        };
        assert.equal(countManuscriptStoppingRuleExclusions(refs, keys, manual, config), 1);
        refs[1].allDecisions!.push(decision('c', 'exclude', '1-ml-auto'));
        const completeKeys = collectReviewerKeys(refs, new Set(), manual);
        assert.equal(countManuscriptStoppingRuleExclusions(refs, completeKeys, manual, config), 2);
        refs[1].allDecisions!.pop();
    }
});

test('全文の論文用文案は人の判定も裁定も無ければAIのみと記す', () => {
    const summary = summarizeFulltextCandidates([fulltext(decision('llm:model@run', 'exclude'))], new Set(['llm:model@run']), []);
    assert.equal(summary.adjudicated, 0);
    assert.equal(buildFulltextAiMethodsSentence(summary), 'Full texts were assessed by model only, without human screening.');
});

test('全文の論文用文案は人の裁定が採用された件数と残りのAI評価を記す', () => {
    const adjudicated = fulltext(decision('llm:model@run', 'exclude'), decision('adjudication:human', 'include'));
    const judges = new Set(['llm:model@run']);
    for (const n of [1, 2]) {
        const summary = summarizeFulltextCandidates([
            ...Array.from({ length: n }, () => adjudicated), fulltext(decision('llm:model@run', 'exclude')),
        ], judges, []);
        assert.equal(summary.adjudicated, n);
        assert.equal(summary.include, n);
        assert.equal(summary.exclude, 1);
        assert.equal(buildFulltextAiMethodsSentence(summary),
            `Full texts were assessed by model; a reviewer adjudicated ${n} ${n === 1 ? 'report' : 'reports'}, and the remaining decisions were made by the model without human screening.`);
    }
});

test('全文の論文用文案は通常の人判定者がいれば従来の追加AI評価文を使う', () => {
    const summary = summarizeFulltextCandidates([
        fulltext(decision('llm:model@run', 'exclude'), decision('human', 'include'), decision('adjudication:human', 'include')),
    ], new Set(['human', 'llm:model@run']), []);
    assert.equal(buildFulltextAiMethodsSentence(summary), 'Retrieved PDFs were additionally assessed by model as an independent screener.');
    assert.equal(buildFulltextAiMethodsSentence({ judges: ['human'], adjudicated: 1 }), '');
});
