import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ADJUDICATION_PREFIX,
    isAdjudicationKey,
    adjudicationReviewerId,
    adjudicationEmail,
    computeFulltextConsensus,
} from '../src/lib/fulltext-consensus';
import type { FulltextVote } from '../src/lib/fulltext-consensus';

test('isAdjudicationKey: adjudication: プレフィックスのキーだけ true', () => {
    assert.equal(isAdjudicationKey('adjudication:owner@example.com'), true);
    assert.equal(isAdjudicationKey('owner@example.com'), false);
    assert.equal(isAdjudicationKey('llm:gemini@2026-01-01'), false);
});

test('adjudicationReviewerId / adjudicationEmail: 相互に変換できる', () => {
    const key = adjudicationReviewerId('owner@example.com');
    assert.equal(key, `${ADJUDICATION_PREFIX}owner@example.com`);
    assert.equal(adjudicationEmail(key), 'owner@example.com');
    // 裁定票でないキーはそのまま返す（呼び出し側の誤用に対する安全弁）
    assert.equal(adjudicationEmail('owner@example.com'), 'owner@example.com');
});

test('computeFulltextConsensus: 全員 exclude・理由同一なら reasonConflict:false', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'population' },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'exclude');
    assert.equal(result.primaryReason, 'population');
    assert.equal(result.conflict, false);
    assert.equal(result.reasonConflict, false);
    assert.equal(result.unresolved, false);
    assert.equal(result.adjudicated, false);
});

test('computeFulltextConsensus: 全員 exclude・理由が違うなら reasonConflict:true / unresolved:true', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'outcome' },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'exclude');
    // 代表理由は番号最小（population）を採る
    assert.equal(result.primaryReason, 'population');
    assert.equal(result.conflict, false);
    assert.equal(result.reasonConflict, true);
    assert.equal(result.unresolved, true);
});

test('computeFulltextConsensus: include と exclude が混在すれば conflict:true（reasonConflictは立たない）', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'include' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'outcome' },
    ];
    const result = computeFulltextConsensus(votes);
    // OR合議: 誰か1人でも include なら include
    assert.equal(result.decision, 'include');
    assert.equal(result.conflict, true);
    assert.equal(result.reasonConflict, false);
    assert.equal(result.unresolved, true);
});

test('computeFulltextConsensus: maybe が混じっても include が最優先', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'maybe' },
        { judge: 'b@example.com', decision: 'include' },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'include');
    assert.equal(result.conflict, true);
});

test('computeFulltextConsensus: pending は無視され、全員pendingならdecisionもpending', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'pending' },
        { judge: 'b@example.com', decision: 'pending' },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'pending');
    assert.equal(result.conflict, false);
    assert.equal(result.reasonConflict, false);
    assert.equal(result.unresolved, false);
});

test('computeFulltextConsensus: 裁定票があれば裁定の判定・理由が最終になり unresolved:false', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'outcome' },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'include',
            decidedAt: '2026-01-01T00:00:00.000Z',
        },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'include');
    assert.equal(result.primaryReason, '');
    assert.equal(result.adjudicated, true);
    assert.equal(result.adjudicatedBy, 'owner@example.com');
    assert.equal(result.adjudicatedAt, '2026-01-01T00:00:00.000Z');
    // 元の不一致自体は残る（裁定票の有無に関わらない生の値）が、解消済みなので unresolved は false
    assert.equal(result.reasonConflict, true);
    assert.equal(result.unresolved, false);
});

test('computeFulltextConsensus: 裁定でexcludeを選べばその理由が最終理由になる', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'include' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'outcome' },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'exclude',
            reason: 'duplicate',
            decidedAt: '2026-01-01T00:00:00.000Z',
        },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'exclude');
    assert.equal(result.primaryReason, 'duplicate');
    assert.equal(result.adjudicated, true);
    assert.equal(result.unresolved, false);
});

test('computeFulltextConsensus: 裁定票が複数あれば decidedAt が最新のものが勝つ（裁定のやり直し）', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population' },
        { judge: 'b@example.com', decision: 'exclude', reason: 'outcome' },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'exclude',
            reason: 'population',
            decidedAt: '2026-01-01T00:00:00.000Z',
        },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'include',
            decidedAt: '2026-02-01T00:00:00.000Z',
        },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.decision, 'include');
    assert.equal(result.adjudicatedAt, '2026-02-01T00:00:00.000Z');
});

test('computeFulltextConsensus: 裁定票が判定者集合（conflict計算）に混入しないこと', () => {
    // 通常票は全員 exclude・理由同一（本来は不一致なし）。
    // 裁定票の decision（include）が「もう1人の判定者の票」として conflict の判定に混じらないことを確認する。
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population' },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'include',
            decidedAt: '2026-01-01T00:00:00.000Z',
        },
    ];
    const result = computeFulltextConsensus(votes);
    // 通常票だけを見れば conflict は無い（exclude 1票のみ）
    assert.equal(result.conflict, false);
    assert.equal(result.reasonConflict, false);
    // 最終判定は裁定票を反映して include になる
    assert.equal(result.decision, 'include');
    assert.equal(result.adjudicated, true);
});

test('computeFulltextConsensus: excludeReasons は通常票のみ（裁定票を含まない）', () => {
    const votes: FulltextVote[] = [
        { judge: 'a@example.com', decision: 'exclude', reason: 'population', note: 'メモA' },
        {
            judge: adjudicationReviewerId('owner@example.com'),
            decision: 'exclude',
            reason: 'duplicate',
            decidedAt: '2026-01-01T00:00:00.000Z',
        },
    ];
    const result = computeFulltextConsensus(votes);
    assert.equal(result.excludeReasons.length, 1);
    assert.equal(result.excludeReasons[0].judge, 'a@example.com');
    assert.equal(result.excludeReasons[0].reason, 'population');
    assert.equal(result.excludeReasons[0].note, 'メモA');
});

test('computeFulltextConsensus: 票が無ければ pending・不一致なし・未裁定', () => {
    const result = computeFulltextConsensus([]);
    assert.equal(result.decision, 'pending');
    assert.equal(result.conflict, false);
    assert.equal(result.reasonConflict, false);
    assert.equal(result.unresolved, false);
    assert.equal(result.adjudicated, false);
    assert.equal(result.adjudicatedBy, null);
    assert.equal(result.adjudicatedAt, null);
});

test('computeFulltextConsensus: カスタム除外理由でも代表理由はそのリストの並びで決まる', () => {
    // PCC 構成（Population → Concept → Context）。既定の PICO 7区分には無い理由が含まれる。
    const items = [
        { key: 'population', label: 'Population 不適合', labelEn: '' },
        { key: 'concept', label: 'Concept 不適合', labelEn: '' },
        { key: 'context', label: 'Context 不適合', labelEn: '' },
    ];
    const votes: FulltextVote[] = [
        { judge: 'b@example.com', decision: 'exclude', reason: 'context' },
        { judge: 'a@example.com', decision: 'exclude', reason: 'concept' },
    ];
    const result = computeFulltextConsensus(votes, items);
    assert.equal(result.decision, 'exclude');
    assert.equal(result.primaryReason, 'concept');
    assert.equal(result.reasonConflict, true);
});
