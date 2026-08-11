import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_FULLTEXT_AI_SCOPE,
    collectAiJudgedRefIds,
    countFulltextAiTargets,
    hasCachedFulltext,
    parseFulltextAiScope,
    selectFulltextAiTargets,
    type FulltextAiDecisionRow,
    type FulltextAiTargetRef,
} from '../src/lib/fulltext-ai-target';

function makeRef(overrides: Partial<FulltextAiTargetRef> & { ref_id: string }): FulltextAiTargetRef {
    return {
        fulltext_status: 'cached',
        fulltext_url: 'https://drive.google.com/file/d/abc/view',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 対象範囲（scope）
// ---------------------------------------------------------------------------

test('既定の対象範囲はプロジェクト全体（人間の担当割り振りでは絞らない）', () => {
    assert.equal(DEFAULT_FULLTEXT_AI_SCOPE, 'project');
});

test('parseFulltextAiScope: assigned だけが担当分、それ以外は既定へ倒す', () => {
    assert.equal(parseFulltextAiScope('assigned'), 'assigned');
    assert.equal(parseFulltextAiScope('project'), 'project');
    assert.equal(parseFulltextAiScope(''), 'project');
    assert.equal(parseFulltextAiScope(null), 'project');
    assert.equal(parseFulltextAiScope(undefined), 'project');
    assert.equal(parseFulltextAiScope('unknown'), 'project');
});

// ---------------------------------------------------------------------------
// 全文確保済み判定
// ---------------------------------------------------------------------------

test('hasCachedFulltext: cached かつ Drive URL ありのときだけ true', () => {
    assert.equal(hasCachedFulltext(makeRef({ ref_id: 'r1' })), true);
    assert.equal(hasCachedFulltext(makeRef({ ref_id: 'r2', fulltext_status: 'retrieved' })), false);
    assert.equal(hasCachedFulltext(makeRef({ ref_id: 'r3', fulltext_status: 'not_retrieved' })), false);
    assert.equal(hasCachedFulltext(makeRef({ ref_id: 'r4', fulltext_url: '' })), false);
    assert.equal(hasCachedFulltext(makeRef({ ref_id: 'r5', fulltext_url: '   ' })), false);
    assert.equal(hasCachedFulltext({ ref_id: 'r6' }), false);
});

// ---------------------------------------------------------------------------
// 判定済み ref_id の抽出（Blind 状態に依存しない）
// ---------------------------------------------------------------------------

const DECISIONS: FulltextAiDecisionRow[] = [
    // 採用ラウンドの判定
    { reviewer_id: 'llm:gemini@2026-08-01T00:00:00Z', ref_id: 'r1', screening_phase: 'fulltext' },
    { reviewer_id: 'llm:gemini@2026-08-01T00:00:00Z', ref_id: 'r2', screening_phase: 'fulltext' },
    // 別ラウンド（未採用）の判定
    { reviewer_id: 'llm:gemini@2026-07-01T00:00:00Z', ref_id: 'r3', screening_phase: 'fulltext' },
    // 人間のフルテキスト判定
    { reviewer_id: 'alice@example.com', ref_id: 'r4', screening_phase: 'fulltext' },
    // 同じラウンドIDだが TiAb フェーズ（別枠なので拾わない）
    { reviewer_id: 'llm:gemini@2026-08-01T00:00:00Z', ref_id: 'r5', screening_phase: 'tiab' },
    // screening_phase 省略は tiab 扱い
    { reviewer_id: 'llm:gemini@2026-08-01T00:00:00Z', ref_id: 'r6' },
];

test('collectAiJudgedRefIds: 採用ラウンドが判定した fulltext の ref_id だけを集める', () => {
    const judged = collectAiJudgedRefIds(DECISIONS, new Set(['llm:gemini@2026-08-01T00:00:00Z']));
    assert.deepEqual([...judged].sort(), ['r1', 'r2']);
});

test('collectAiJudgedRefIds: 採用ラウンドが無ければ空（＝全件が対象になり別ラウンドを作れる）', () => {
    const judged = collectAiJudgedRefIds(DECISIONS, new Set<string>());
    assert.equal(judged.size, 0);
});

test('collectAiJudgedRefIds: reviewer_id / ref_id の前後空白を無視する（シート直編集対策）', () => {
    const judged = collectAiJudgedRefIds(
        [{ reviewer_id: ' llm:gemini@t1 ', ref_id: ' r1 ', screening_phase: 'fulltext' }],
        new Set(['llm:gemini@t1'])
    );
    assert.deepEqual([...judged], ['r1']);
});

test('collectAiJudgedRefIds: ref_id が空の行は無視する', () => {
    const judged = collectAiJudgedRefIds(
        [{ reviewer_id: 'llm:gemini@t1', ref_id: '   ', screening_phase: 'fulltext' }],
        new Set(['llm:gemini@t1'])
    );
    assert.equal(judged.size, 0);
});

// ---------------------------------------------------------------------------
// 対象の切り出しと件数
// ---------------------------------------------------------------------------

const CANDIDATES: FulltextAiTargetRef[] = [
    makeRef({ ref_id: 'r1' }),                                  // cached・採用ラウンド判定済み
    makeRef({ ref_id: 'r2' }),                                  // cached・採用ラウンド判定済み
    makeRef({ ref_id: 'r3' }),                                  // cached・未判定（別ラウンドのみ）
    makeRef({ ref_id: 'r7', fulltext_status: 'not_retrieved' }),// PDF未確保
    makeRef({ ref_id: 'r8', fulltext_url: '' }),                // URL欠落
];

test('selectFulltextAiTargets: cached かつ採用ラウンド未判定の文献だけを返す', () => {
    const judged = collectAiJudgedRefIds(DECISIONS, new Set(['llm:gemini@2026-08-01T00:00:00Z']));
    const targets = selectFulltextAiTargets(CANDIDATES, judged);
    assert.deepEqual(targets.map(r => r.ref_id), ['r3']);
});

test('selectFulltextAiTargets: 採用ラウンドが無ければ cached 全件が対象', () => {
    const targets = selectFulltextAiTargets(CANDIDATES, new Set<string>());
    assert.deepEqual(targets.map(r => r.ref_id), ['r1', 'r2', 'r3']);
});

test('countFulltextAiTargets: 対象・全文確保済み・判定済み除外の内訳を返す', () => {
    const judged = collectAiJudgedRefIds(DECISIONS, new Set(['llm:gemini@2026-08-01T00:00:00Z']));
    assert.deepEqual(countFulltextAiTargets(CANDIDATES, judged), {
        target: 1,
        cached: 3,
        alreadyJudged: 2,
    });
});

test('countFulltextAiTargets: 候補が空なら全て0', () => {
    assert.deepEqual(countFulltextAiTargets([], new Set(['llm:gemini@t1'])), {
        target: 0,
        cached: 0,
        alreadyJudged: 0,
    });
});

test('プロジェクト全体と担当分で対象件数が変わる（担当外PDFもAIは判定する）', () => {
    const projectCandidates = CANDIDATES;
    // 担当割り振りで自分に割り当てられているのは r1 だけ、という状況
    const assignedCandidates = CANDIDATES.filter(r => r.ref_id === 'r1');

    const noRound = new Set<string>();
    assert.equal(countFulltextAiTargets(projectCandidates, noRound).target, 3);
    assert.equal(countFulltextAiTargets(assignedCandidates, noRound).target, 1);
});
