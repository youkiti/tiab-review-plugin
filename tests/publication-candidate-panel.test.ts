import test from 'node:test';
import assert from 'node:assert/strict';
import {
    selectSuggestedPublicationCandidates,
    countSuggestedPublicationCandidatesByRef,
    isPublicationCandidateAlreadyImported,
    publicationCandidateStrategyLabelKey,
} from '../src/lib/publication-candidate-panel';
import type { PublicationCandidate, PublicationCandidateStrategy } from '../src/lib/types';

// Issue #118「レジストリ連携フェーズ1」チャンク3b: 候補パネル（サイドパネルUI）が使う
// 純ロジックの回帰テスト。UI/DOMは検証しない（このファイルの対象はUI非依存の部分のみ）。

function candidate(overrides: Partial<PublicationCandidate> = {}): PublicationCandidate {
    return {
        candidate_id: 'cand-1',
        ref_id: 'reg-1',
        trial_id: 'NCT12345678',
        strategy: 'pubmed_id',
        status: 'suggested',
        suggested_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// selectSuggestedPublicationCandidates
// ---------------------------------------------------------------------------

test('selectSuggestedPublicationCandidates: 発見戦略の強い順(ctgov_reference→pubmed_id→europepmc)に並ぶ', () => {
    const candidates = [
        candidate({ candidate_id: 'c1', strategy: 'europepmc' }),
        candidate({ candidate_id: 'c2', strategy: 'ctgov_reference' }),
        candidate({ candidate_id: 'c3', strategy: 'pubmed_id' }),
    ];
    const result = selectSuggestedPublicationCandidates(candidates, 'reg-1');
    assert.deepEqual(result.map(c => c.candidate_id), ['c2', 'c3', 'c1']);
});

test('selectSuggestedPublicationCandidates: 未知のstrategyはNaNにならず末尾へ寄る（PR #124 レビュー指摘4）', () => {
    // strategy列はユーザー編集可能なシートから無検証キャストで読まれるため、
    // STRATEGY_ORDERに無い値が来ても並び替えが実装依存(NaN由来)にならないことを確認する。
    const candidates = [
        candidate({ candidate_id: 'c1', strategy: 'unknown_strategy' as unknown as PublicationCandidateStrategy }),
        candidate({ candidate_id: 'c2', strategy: 'europepmc' }),
        candidate({ candidate_id: 'c3', strategy: 'ctgov_reference' }),
    ];
    const result = selectSuggestedPublicationCandidates(candidates, 'reg-1');
    assert.deepEqual(result.map(c => c.candidate_id), ['c3', 'c2', 'c1']);
});

test('selectSuggestedPublicationCandidates: 別のref_idの候補は含めない', () => {
    const candidates = [
        candidate({ candidate_id: 'c1', ref_id: 'reg-1' }),
        candidate({ candidate_id: 'c2', ref_id: 'reg-2' }),
    ];
    const result = selectSuggestedPublicationCandidates(candidates, 'reg-1');
    assert.deepEqual(result.map(c => c.candidate_id), ['c1']);
});

test('selectSuggestedPublicationCandidates: status !== "suggested" の候補は除外する（imported/dismissed）', () => {
    const candidates = [
        candidate({ candidate_id: 'c1', status: 'suggested' }),
        candidate({ candidate_id: 'c2', status: 'imported' }),
        candidate({ candidate_id: 'c3', status: 'dismissed' }),
    ];
    const result = selectSuggestedPublicationCandidates(candidates, 'reg-1');
    assert.deepEqual(result.map(c => c.candidate_id), ['c1']);
});

// ---------------------------------------------------------------------------
// countSuggestedPublicationCandidatesByRef
// ---------------------------------------------------------------------------

test('countSuggestedPublicationCandidatesByRef: registration行ごとに未決着候補数を集計する', () => {
    const candidates = [
        candidate({ candidate_id: 'c1', ref_id: 'reg-1', status: 'suggested' }),
        candidate({ candidate_id: 'c2', ref_id: 'reg-1', status: 'suggested' }),
        candidate({ candidate_id: 'c3', ref_id: 'reg-1', status: 'imported' }),
        candidate({ candidate_id: 'c4', ref_id: 'reg-2', status: 'suggested' }),
    ];
    const counts = countSuggestedPublicationCandidatesByRef(candidates);
    assert.equal(counts.get('reg-1'), 2);
    assert.equal(counts.get('reg-2'), 1);
    assert.equal(counts.has('reg-3'), false);
});

test('countSuggestedPublicationCandidatesByRef: 候補が0件なら空のMapを返す', () => {
    const counts = countSuggestedPublicationCandidatesByRef([]);
    assert.equal(counts.size, 0);
});

// ---------------------------------------------------------------------------
// isPublicationCandidateAlreadyImported
// ---------------------------------------------------------------------------

test('isPublicationCandidateAlreadyImported: 同一PMIDの行が既にあればtrue', () => {
    const result = isPublicationCandidateAlreadyImported(
        { pmid: '12345678' },
        [{ pmid: '12345678' }]
    );
    assert.equal(result, true);
});

test('isPublicationCandidateAlreadyImported: 同一DOIの行が既にあればtrue（大文字小文字を無視）', () => {
    const result = isPublicationCandidateAlreadyImported(
        { doi: '10.1000/Example' },
        [{ doi: '10.1000/EXAMPLE' }]
    );
    assert.equal(result, true);
});

test('isPublicationCandidateAlreadyImported: 一致する行が無ければfalse', () => {
    const result = isPublicationCandidateAlreadyImported(
        { pmid: '12345678', doi: '10.1000/example' },
        [{ pmid: '99999999', doi: '10.1000/other' }]
    );
    assert.equal(result, false);
});

test('isPublicationCandidateAlreadyImported: PMID/DOIどちらも無い候補はfalse（除外はしない）', () => {
    const result = isPublicationCandidateAlreadyImported(
        {},
        [{ pmid: '12345678' }]
    );
    assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// publicationCandidateStrategyLabelKey
// ---------------------------------------------------------------------------

test('publicationCandidateStrategyLabelKey: 3戦略すべてに一意のi18nキーを割り当てる', () => {
    const keys = [
        publicationCandidateStrategyLabelKey('ctgov_reference'),
        publicationCandidateStrategyLabelKey('pubmed_id'),
        publicationCandidateStrategyLabelKey('europepmc'),
    ];
    assert.deepEqual(keys, [
        'pubCandidate_strategyCtgovReference',
        'pubCandidate_strategyPubmedId',
        'pubCandidate_strategyEuropepmc',
    ]);
    assert.equal(new Set(keys).size, 3, 'キーは重複しない');
});

test('publicationCandidateStrategyLabelKey: 想定外の値はpubCandidate_strategyUnknownを返す（PR #124 レビュー指摘4）', () => {
    const key = publicationCandidateStrategyLabelKey('unknown_strategy' as unknown as PublicationCandidateStrategy);
    assert.equal(key, 'pubCandidate_strategyUnknown');
});
