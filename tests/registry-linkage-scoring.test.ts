import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateGroundTruth, candidateMatchesTruth, evaluatePair, summarize, decide,
    classifyRegistry, normalizeDoi,
    type GroundTruthPair,
} from '../experiments/registry-linkage/scoring';
import type { PublicationCandidateDraft } from '../src/lib/publication-suggest';

// Issue #119 の着手条件（#118 の取りこぼし率測定）で使う純関数のテスト。
// この測定の妥当性は「正解セットが測定対象の戦略と循環していないこと」に懸かっており、
// その検証を validateGroundTruth() に落としてあるので、ここが壊れると測定結果ごと嘘になる。

const draft = (
    over: Partial<PublicationCandidateDraft> = {}
): PublicationCandidateDraft => ({
    refId: 'r1', trialId: 'NCT00000001', strategy: 'pubmed_id', ...over,
});

test('validateGroundTruth: [si] 由来は戦略2と循環するので除外する', () => {
    const pairs: GroundTruthPair[] = [
        { trial_id: 'NCT00000001', pmid: '111', provenance: 'pubmed_si' },
    ];
    const { usable, rejected } = validateGroundTruth(pairs);
    assert.equal(usable.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /pubmed_id/);
});

test('validateGroundTruth: CTGov referencesModule 由来は戦略1と循環するので除外する', () => {
    // Issue #119 の当初案では独立な正解セットの候補として挙げていたが、戦略1が読むのが
    // まさにこのフィールドなので [si] と同じ誤りになる。
    const pairs: GroundTruthPair[] = [
        { trial_id: 'NCT00000001', pmid: '111', provenance: 'ctgov_references' },
    ];
    const { usable, rejected } = validateGroundTruth(pairs);
    assert.equal(usable.length, 0);
    assert.match(rejected[0].reason, /ctgov_reference/);
});

test('validateGroundTruth: 独立な由来は通す', () => {
    const pairs: GroundTruthPair[] = [
        { trial_id: 'jRCT2031200153', doi: '10.1000/x', provenance: 'registry_declared' },
        { trial_id: 'NCT00000002', pmid: '222', provenance: 'sr_included_table' },
        { trial_id: 'UMIN000012345', pmid: '333', provenance: 'manual_curation' },
    ];
    assert.equal(validateGroundTruth(pairs).usable.length, 3);
});

test('validateGroundTruth: pmid も doi も無いペアは照合できないので除外する', () => {
    const { usable, rejected } = validateGroundTruth([
        { trial_id: 'NCT00000001', provenance: 'sr_included_table' },
        { trial_id: 'NCT00000002', pmid: '  ', doi: '  ', provenance: 'sr_included_table' },
    ]);
    assert.equal(usable.length, 0);
    assert.equal(rejected.length, 2);
});

test('validateGroundTruth: 試験IDの重複は除外する（大文字小文字を無視）', () => {
    const { usable, rejected } = validateGroundTruth([
        { trial_id: 'NCT00000001', pmid: '111', provenance: 'sr_included_table' },
        { trial_id: 'nct00000001', pmid: '222', provenance: 'sr_included_table' },
    ]);
    assert.equal(usable.length, 1);
    assert.match(rejected[0].reason, /重複/);
});

test('classifyRegistry: 層別のためレジストリ種別を判定する', () => {
    assert.equal(classifyRegistry('NCT01470703'), 'ctgov');
    assert.equal(classifyRegistry('jRCT2031200153'), 'jrct');
    assert.equal(classifyRegistry('UMIN000012345'), 'umin');
    assert.equal(classifyRegistry('C000000123'), 'umin', 'UMIN-CTRのC形式の受付番号');
    assert.equal(classifyRegistry('ISRCTN11088150'), 'isrctn');
    assert.equal(classifyRegistry('EUCTR2015-000000-00'), 'other');
});

test('normalizeDoi: 大文字小文字とdoi.org接頭辞を吸収する', () => {
    assert.equal(normalizeDoi('10.1000/ABC'), '10.1000/abc');
    assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc');
    assert.equal(normalizeDoi('http://dx.doi.org/10.1000/abc'), '10.1000/abc');
    assert.equal(normalizeDoi('  '), undefined);
});

test('candidateMatchesTruth: PMID か DOI のどちらかが一致すれば当たり', () => {
    const pair: GroundTruthPair = {
        trial_id: 'NCT00000001', pmid: '111', doi: '10.1000/x', provenance: 'sr_included_table',
    };
    assert.equal(candidateMatchesTruth({ pmid: '111' }, pair), true);
    assert.equal(candidateMatchesTruth({ doi: '10.1000/X' }, pair), true, 'DOIは大文字小文字を無視');
    assert.equal(candidateMatchesTruth({ pmid: '999', doi: '10.1000/y' }, pair), false);
    assert.equal(candidateMatchesTruth({}, pair), false);
});

test('evaluatePair: 当てた戦略と順位、戦略別の候補件数を記録する', () => {
    const pair: GroundTruthPair = {
        trial_id: 'NCT00000001', pmid: '333', provenance: 'sr_included_table',
    };
    const result = evaluatePair(pair, [
        draft({ pmid: '111', strategy: 'ctgov_reference' }),
        draft({ pmid: '222', strategy: 'pubmed_id' }),
        draft({ pmid: '333', strategy: 'europepmc' }),
    ]);
    assert.equal(result.found, true);
    assert.equal(result.found_by, 'europepmc');
    assert.equal(result.rank, 3);
    assert.equal(result.candidate_count, 3);
    assert.deepEqual(result.count_by_strategy, { ctgov_reference: 1, pubmed_id: 1, europepmc: 1 });
    assert.equal(result.stratum, 'ctgov');
});

test('evaluatePair: 候補0件は取りこぼしとして記録する', () => {
    const result = evaluatePair(
        { trial_id: 'jRCT2031200153', pmid: '333', provenance: 'registry_declared' },
        []
    );
    assert.equal(result.found, false);
    assert.equal(result.found_by, null);
    assert.equal(result.rank, null);
    assert.equal(result.candidate_count, 0);
});

test('summarize: 層別に取りこぼし率を出す（全体の平均に埋もれさせない）', () => {
    // 戦略1はNCTにしか効かないため、非NCT層の取りこぼしが大きくなるのが想定される偏り。
    // 全体を1つの数字にまとめるとこれが見えなくなる。
    const results = [
        evaluatePair({ trial_id: 'NCT00000001', pmid: '1', provenance: 'sr_included_table' },
            [draft({ pmid: '1', strategy: 'ctgov_reference' })]),
        evaluatePair({ trial_id: 'NCT00000002', pmid: '2', provenance: 'sr_included_table' },
            [draft({ pmid: '2', strategy: 'ctgov_reference' })]),
        evaluatePair({ trial_id: 'jRCT2031200153', pmid: '3', provenance: 'registry_declared' }, []),
        evaluatePair({ trial_id: 'jRCT2031200154', pmid: '4', provenance: 'registry_declared' }, []),
    ];
    const summary = summarize(results);

    assert.equal(summary.overall.n, 4);
    assert.equal(summary.overall.miss_rate, 0.5);
    assert.equal(summary.by_stratum.ctgov?.miss_rate, 0);
    assert.equal(summary.by_stratum.jrct?.miss_rate, 1);
    assert.deepEqual(summary.by_stratum.ctgov?.found_by, { ctgov_reference: 2 });
});

test('summarize: 0件の層で miss_rate が NaN にならない', () => {
    // NaN は JSON へ null として書き出され、集計側で静かに壊れるため 0 で返す
    const summary = summarize([]);
    assert.equal(summary.overall.miss_rate, 0);
    assert.equal(summary.overall.mean_candidate_count, 0);
});

test('decide: Issue #119 本文の閾値をそのまま判定する', () => {
    assert.equal(decide(0.05), 'not_worth_it');
    assert.equal(decide(0.099), 'not_worth_it');
    assert.equal(decide(0.10), 'low_priority', '10%ちょうどは実装する側（低優先）');
    assert.equal(decide(0.25), 'low_priority', '25%ちょうどは低優先のまま');
    assert.equal(decide(0.2501), 'build_it');
});
