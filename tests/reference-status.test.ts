import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReferencesWithStatus, mergeReferencesWithAllDecisions } from '../src/lib/reference-status';
import { buildAllFulltextDecisionsMap } from '../src/lib/decision-aggregate';
import type { Decision, Reference } from '../src/lib/types';

function decision(overrides: Partial<Decision> = {}): Decision {
    return {
        decision_id: 'd-1', ref_id: 'ref-1', reviewer_id: 'self', decision: 'include',
        decided_at: '2026-09-06T00:00:00Z', ...overrides,
    };
}

function rows(decisions: Decision[]) {
    return decisions.map((decision, i) => ({ decision, rowIndex: i + 2 }));
}

test('Blind合成は自分とLLMの票だけを返し、pendingを未判定に保つ', () => {
    for (const ownStatus of ['include', 'pending'] as const) {
        const [result] = mergeReferencesWithStatus([{ ref_id: 'ref-1', title: '文献' }], rows([
            decision({ decision: ownStatus }),
            decision({ reviewer_id: 'other', decision: 'exclude' }),
            decision({ reviewer_id: 'llm:batch-1' }),
            decision({ reviewer_id: 'other', screening_phase: 'fulltext' }),
        ]), 'self');
        assert.equal(result.status, ownStatus);
        assert.equal(result.myDecision?.reviewer_id, 'self');
        assert.deepEqual(result.allDecisions?.map(d => d.reviewer_id), ['llm:batch-1']);
        assert.equal(result.allFulltextDecisions, undefined);
    }
});

test('開封後は不採用LLM票を集計から外し、判定済みバッチ一覧には残す', () => {
    const [result] = mergeReferencesWithAllDecisions([{ ref_id: 'ref-1', title: '文献' }], rows([
        decision(), decision({ reviewer_id: 'other', decision: 'exclude' }),
        decision({ reviewer_id: 'llm:active' }), decision({ reviewer_id: 'llm:inactive' }),
    ]), 'self', new Set(['llm:active']), null);
    assert.deepEqual(result.allDecisions?.map(d => d.reviewer_id), ['self', 'other', 'llm:active']);
    assert.deepEqual(result.llmBatchIds, ['llm:active', 'llm:inactive']);
    assert.equal(result.hasConflict, true);
    assert.equal(result.status, 'conflict');
});

for (const opened of [false, true]) {
    test(`${opened ? '開封後' : 'Blind'}の正規化は入力の配列・要素を書き換えない`, () => {
        const refs: Reference[] = [{ ref_id: ' ref-1 ', title: '文献' }, { ref_id: ' ref-2 ', title: '文献2' }];
        const data = rows([
            decision({ ref_id: ' ref-1 ', reviewer_id: ' self ' }),
            decision({ ref_id: ' ref-2 ', reviewer_id: '' }),
            decision({ ref_id: ' ref-1 ', reviewer_id: ' llm:active ' }),
            decision({ ref_id: ' ref-1 ', reviewer_id: ' self ', screening_phase: 'fulltext' }),
        ]);
        const before = structuredClone({ refs, data });
        const result = opened
            ? mergeReferencesWithAllDecisions(refs, data, ' self ', new Set(['llm:active']), null)
            : mergeReferencesWithStatus(refs, data, ' self ');
        assert.deepEqual({ refs, data }, before);
        assert.deepEqual(result.map(r => r.ref_id), ['ref-1', 'ref-2']);
        assert.equal(result[0].myDecision?.reviewer_id, 'self');
        assert.equal(result[0].myDecision?.ref_id, 'ref-1');
        assert.equal(result[1].myDecision?.reviewer_id, 'self');
        assert.equal(result[1].myDecision?.ref_id, 'ref-2');
        assert.ok(result[0].allDecisions?.some(d => d.reviewer_id === 'llm:active' && d.ref_id === 'ref-1'));
        if (!opened) assert.equal(result[0].myFulltextDecision?.reviewer_id, ' self ');
        if (opened) assert.equal(result[0].allFulltextDecisions?.[0].reviewer_id, 'self');
    });

    test(`${opened ? '開封後' : 'Blind'}の合成は論理削除済み文献を除外する`, () => {
        const refs = [{ ref_id: 'ref-1', title: '残す' }, { ref_id: 'ref-2', title: '重複', duplicate_of: 'ref-1' }];
        const result = opened
            ? mergeReferencesWithAllDecisions(refs, [], 'self', new Set(), null)
            : mergeReferencesWithStatus(refs, [], 'self');
        assert.deepEqual(result.map(r => r.ref_id), ['ref-1']);
    });
}

test('全文判定の正規化は入力を変えず、採用ラウンドだけを返す', () => {
    const data = rows([
        decision({ ref_id: ' ref-1 ', reviewer_id: ' other ', screening_phase: 'fulltext' }),
        decision({ ref_id: ' ref-1 ', reviewer_id: ' llm:active ', screening_phase: 'fulltext' }),
        decision({ ref_id: ' ref-1 ', reviewer_id: ' llm:inactive ', screening_phase: 'fulltext' }),
        decision(),
    ]);
    const before = structuredClone(data);
    const result = buildAllFulltextDecisionsMap(data, 'llm:active');
    assert.deepEqual(data, before);
    assert.deepEqual(result.get('ref-1')?.map(d => [d.ref_id, d.reviewer_id]), [
        ['ref-1', 'other'], ['ref-1', 'llm:active'],
    ]);
    assert.deepEqual(buildAllFulltextDecisionsMap(data, null).get('ref-1')?.map(d => d.reviewer_id), ['other']);
});
