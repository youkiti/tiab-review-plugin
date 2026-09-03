import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateGroundTruth, candidateMatchesTruth, evaluatePair, summarize, decide,
    classifyRegistry, normalizeDoi, detectStrategyOutage,
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
        // Crossref の clinical-trial-number は出版社寄託で、CTGov referencesModule とも
        // PubMed [si] とも Europe PMC の抄録テキストとも別系統なので通す。
        { trial_id: 'ISRCTN12345678', pmid: '444', provenance: 'crossref_ct_number' },
    ];
    assert.equal(validateGroundTruth(pairs).usable.length, 4);
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

// --- detectStrategyOutage: 測定途中でAPIが落ちた場合の検出 ---
// preflight は開始時点しか見ていないため、途中から eutils が 429 を返し始めると
// 以降のペアは静かに全部「取りこぼし」に積まれ、取りこぼし率が水増しされる。

// NCTは8桁固定。素の埋め込みだと i>=10 で9桁になり classifyRegistry が 'other' を返してしまう
const pairAt = (i: number): GroundTruthPair =>
    ({ trial_id: `NCT${String(i).padStart(8, '0')}`, pmid: String(i), provenance: 'sr_included_table' });

test('detectStrategyOutage: 末尾で候補を返さなくなった戦略を検出する', () => {
    // 先頭3件は pubmed_id が候補を返しているが、そこから12件は一度も返していない
    const results = [
        ...[1, 2, 3].map(i => evaluatePair(pairAt(i), [draft({ pmid: String(i), strategy: 'pubmed_id' })])),
        ...Array.from({ length: 12 }, (_, k) =>
            evaluatePair(pairAt(k + 4), [draft({ pmid: 'x', strategy: 'europepmc' })])),
    ];
    const outages = detectStrategyOutage(results);
    assert.equal(outages.length, 1);
    assert.equal(outages[0].strategy, 'pubmed_id');
    assert.equal(outages[0].lastHitIndex, 2, '最後に候補を返したのは3件目（0始まりで2）');
    assert.equal(outages[0].trailing, 12);
});

test('detectStrategyOutage: 最後まで返している戦略は検出しない', () => {
    const results = Array.from({ length: 20 }, (_, k) =>
        evaluatePair(pairAt(k + 1), [draft({ pmid: String(k + 1), strategy: 'pubmed_id' })]));
    assert.deepEqual(detectStrategyOutage(results), []);
});

test('detectStrategyOutage: 効かない層が末尾に並んでいても誤検出しない', () => {
    // 実測で踏んだ誤検出。戦略1はNCTにしか効かないので、正解セットを層順に並べると
    // 非NCT層が丸ごと「末尾の空白」に見えてしまう。効いた層だけに絞って数える。
    const results = [
        ...Array.from({ length: 5 }, (_, k) =>
            evaluatePair(pairAt(k + 1), [draft({ pmid: String(k + 1), strategy: 'ctgov_reference' })])),
        ...Array.from({ length: 20 }, (_, k) => evaluatePair(
            { trial_id: `ISRCTN1000000${k}`, pmid: 'x', provenance: 'sr_included_table' },
            [draft({ pmid: 'x', strategy: 'pubmed_id' })])),
    ];
    const outages = detectStrategyOutage(results);
    assert.deepEqual(outages.filter(o => o.strategy === 'ctgov_reference'), [],
        'ctgov層では最後まで候補を返しているので警告しない');
});

test('detectStrategyOutage: 元々まばらな戦略は内部の空白より短い末尾では検出しない', () => {
    // 実測で踏んだ誤検出。戦略3は正常時でも途中に大きな空白が空くので、
    // 固定閾値だと末尾の空白を落ちたと誤認する。
    const hitAt = new Set([0, 20, 40]);   // 途中に19件の空白がある
    const results = Array.from({ length: 55 }, (_, k) => evaluatePair(
        pairAt(k + 1),
        hitAt.has(k) ? [draft({ pmid: 'z', strategy: 'europepmc' })] : []
    ));
    // 末尾の空白は14件で minRun(10) は超えるが、内部の最大空白19件より短い
    assert.deepEqual(detectStrategyOutage(results), []);
});

test('detectStrategyOutage: 内部の空白より長い末尾なら検出する', () => {
    const hitAt = new Set([0, 5, 10]);    // 内部の最大空白は4件
    const results = Array.from({ length: 40 }, (_, k) => evaluatePair(
        pairAt(k + 1),
        hitAt.has(k) ? [draft({ pmid: 'z', strategy: 'europepmc' })] : []
    ));
    const outages = detectStrategyOutage(results);
    assert.equal(outages.length, 1);
    assert.equal(outages[0].trailing, 29);
    assert.equal(outages[0].maxInternalGap, 4);
});

test('detectStrategyOutage: 空白が閾値未満なら検出しない（0件は正常でも起きる）', () => {
    const results = [
        evaluatePair(pairAt(1), [draft({ pmid: '1', strategy: 'pubmed_id' })]),
        ...Array.from({ length: 9 }, (_, k) =>
            evaluatePair(pairAt(k + 2), [draft({ pmid: 'x', strategy: 'europepmc' })])),
    ];
    assert.deepEqual(detectStrategyOutage(results), [], '末尾9件は既定の閾値10未満');
});

test('detectStrategyOutage: 一度も候補が無い戦略は対象外（そもそも集計に現れない）', () => {
    const results = Array.from({ length: 15 }, (_, k) => evaluatePair(pairAt(k + 1), []));
    assert.deepEqual(detectStrategyOutage(results), []);
});
