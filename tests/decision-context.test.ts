import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionContext } from '../src/lib/decision-context';

// buildDecisionContext() は Decisions.context_json 列に保存するJSON文字列を組み立てる純関数。
// v・各フィールドの有無・undefinedフィールドの省略を検証する。

test('buildDecisionContext: 全フィールド指定時はそのままJSONに反映される', () => {
    const json = buildDecisionContext({
        keyOpened: true,
        aiHighlights: true,
        aiEvidenceLevel: 'full',
        aiVotesAtDecision: 2,
    });
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, {
        v: 1,
        key_opened: true,
        ai_highlights: true,
        ai_evidence_level: 'full',
        ai_votes_at_decision: 2,
    });
});

test('buildDecisionContext: keyOpened のみ指定時、v と key_opened だけを含む', () => {
    const json = buildDecisionContext({ keyOpened: false });
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, { v: 1, key_opened: false });
});

test('buildDecisionContext: undefined のフィールドは出力JSONに含まれない（キー自体が無い）', () => {
    const json = buildDecisionContext({ keyOpened: true, aiHighlights: undefined, aiEvidenceLevel: undefined, aiVotesAtDecision: undefined });
    const parsed = JSON.parse(json);
    assert.equal('ai_highlights' in parsed, false);
    assert.equal('ai_evidence_level' in parsed, false);
    assert.equal('ai_votes_at_decision' in parsed, false);
    assert.deepEqual(Object.keys(parsed).sort(), ['key_opened', 'v']);
});

test('buildDecisionContext: TiAb想定（ai_highlights・ai_votes_at_decisionのみ、ai_evidence_levelは省略）', () => {
    const json = buildDecisionContext({ keyOpened: false, aiHighlights: false, aiVotesAtDecision: 0 });
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, { v: 1, key_opened: false, ai_highlights: false, ai_votes_at_decision: 0 });
});

test('buildDecisionContext: フルテキスト想定（ai_evidence_levelのみ、ai_highlightsは省略）', () => {
    const json = buildDecisionContext({ keyOpened: true, aiEvidenceLevel: 'neutral', aiVotesAtDecision: 1 });
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, { v: 1, key_opened: true, ai_evidence_level: 'neutral', ai_votes_at_decision: 1 });
    assert.equal('ai_highlights' in parsed, false);
});

test('buildDecisionContext: 常に v:1 の文字列（数値）を返す', () => {
    const parsed = JSON.parse(buildDecisionContext({ keyOpened: true }));
    assert.equal(parsed.v, 1);
});
