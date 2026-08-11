import test from 'node:test';
import assert from 'node:assert/strict';
import { explainEmptyAiEvidence } from '../src/lib/ai-evidence-empty-reason';

const ROUND = 'llm:gemini-3.1-flash-lite@2026-08-01T00:00:00.000Z';

test('実事故ケース: フルテキストAI判定が1件も無い → no_round', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'neutral',
        hasAnyFulltextAiDecision: false,
        hasAdoptedRoundDecision: false,
        activeRound: null,
    });
    assert.equal(reason, 'no_round');
});

test('ラウンドはあるが採用ラウンド未設定 → round_not_adopted', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'neutral',
        hasAnyFulltextAiDecision: true,
        hasAdoptedRoundDecision: false,
        activeRound: null,
    });
    assert.equal(reason, 'round_not_adopted');
});

test('採用ラウンドは設定済みだがその判定が存在しない（削除済み等） → adopted_round_missing', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'neutral',
        hasAnyFulltextAiDecision: true,
        hasAdoptedRoundDecision: false,
        activeRound: ROUND,
    });
    assert.equal(reason, 'adopted_round_missing');
});

test('採用ラウンドの判定はあるが、この文献に根拠が無い → no_evidence', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'neutral',
        hasAnyFulltextAiDecision: true,
        hasAdoptedRoundDecision: true,
        activeRound: ROUND,
    });
    assert.equal(reason, 'no_evidence');
});

test('開示時（full）でも判定ロジックは同じ（no_round）', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'full',
        hasAnyFulltextAiDecision: false,
        hasAdoptedRoundDecision: false,
        activeRound: null,
    });
    assert.equal(reason, 'no_round');
});

// ブラインディング: 表示レベル none では状態を漏らさないため、
// どの状態でも必ず 'blinded'（＝no_evidence と同一文言）に倒す
test('表示レベル none: AI判定が無くても blinded', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'none',
        hasAnyFulltextAiDecision: false,
        hasAdoptedRoundDecision: false,
        activeRound: null,
    });
    assert.equal(reason, 'blinded');
});

test('表示レベル none: 採用ラウンドと判定が揃っていても blinded', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'none',
        hasAnyFulltextAiDecision: true,
        hasAdoptedRoundDecision: true,
        activeRound: ROUND,
    });
    assert.equal(reason, 'blinded');
});

test('表示レベル none: 未採用でも blinded（採用状態を漏らさない）', () => {
    const reason = explainEmptyAiEvidence({
        evidenceLevel: 'none',
        hasAnyFulltextAiDecision: true,
        hasAdoptedRoundDecision: false,
        activeRound: null,
    });
    assert.equal(reason, 'blinded');
});
