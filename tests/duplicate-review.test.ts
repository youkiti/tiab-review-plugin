import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveSurvivor,
    DUPLICATE_REVIEW_COMPARE_FIELDS,
    diffReferenceFields,
    scanReferencesForDuplicatePairs,
    isAutoApplicableCandidate,
    isPairAlreadySettled,
    chooseKeptRefId,
} from '../src/lib/duplicate-review';
import type { Reference, DuplicateCandidate, DuplicateCandidateStatus } from '../src/lib/types';

// Issue #147（重複候補のレビューUI、Issue #145 チャンク3）: UIから独立して単体テストできる
// 計算ロジックの回帰テスト。src/lib/duplicate-review.ts が対象。DOM・state・Sheets API は
// この turn では扱わない。

function ref(overrides: Partial<Reference> = {}): Reference {
    return {
        ref_id: 'ref-new',
        title: 'A Sample Trial',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// resolveSurvivor
// ---------------------------------------------------------------------------

function refsMap(
    entries: Array<Pick<Reference, 'ref_id' | 'duplicate_of'>>
): Map<string, Pick<Reference, 'ref_id' | 'duplicate_of'>> {
    return new Map(entries.map((e) => [e.ref_id, e]));
}

test('resolveSurvivor: 論理削除されていない行（0 hop）はそのまま返る', () => {
    const map = refsMap([{ ref_id: 'a', duplicate_of: undefined }]);
    assert.deepEqual(resolveSurvivor('a', map), { refId: 'a', hops: 0, broken: false });
});

test('resolveSurvivor: 1 hop（A→B、Bは生きている）', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: 'b' },
        { ref_id: 'b', duplicate_of: undefined },
    ]);
    assert.deepEqual(resolveSurvivor('a', map), { refId: 'b', hops: 1, broken: false });
});

test('resolveSurvivor: 2 hop以上の連鎖（A→B→C、Cは生きている）', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: 'b' },
        { ref_id: 'b', duplicate_of: 'c' },
        { ref_id: 'c', duplicate_of: undefined },
    ]);
    assert.deepEqual(resolveSurvivor('a', map), { refId: 'c', hops: 2, broken: false });
});

test('resolveSurvivor: 循環（A→B→A）は停止してbroken:trueになる。refIdは循環を検出した時点の行（B）', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: 'b' },
        { ref_id: 'b', duplicate_of: 'a' },
    ]);
    assert.deepEqual(resolveSurvivor('a', map), { refId: 'b', hops: 1, broken: true });
});

test('resolveSurvivor: duplicate_ofの指す先がrefsByIdに存在しない場合はbroken:true（refIdはその時点の行）', () => {
    const map = refsMap([{ ref_id: 'a', duplicate_of: 'missing' }]);
    assert.deepEqual(resolveSurvivor('a', map), { refId: 'a', hops: 0, broken: true });
});

test('resolveSurvivor: 入力のrefId自体がrefsByIdに無い場合は{ refId, hops: 0, broken: true }', () => {
    const map = refsMap([]);
    assert.deepEqual(resolveSurvivor('missing', map), { refId: 'missing', hops: 0, broken: true });
});

test('resolveSurvivor: 深さ上限（100 hop）を超える連鎖はbroken:trueで止まる', () => {
    // 0..150 の151件のチェーンを作る。r0→r1→...→r150（r150のみ生きている）。
    // 150 hop 必要なので、上限100を超えて broken になる。
    const entries: Array<Pick<Reference, 'ref_id' | 'duplicate_of'>> = [];
    for (let i = 0; i < 150; i++) {
        entries.push({ ref_id: `r${i}`, duplicate_of: `r${i + 1}` });
    }
    entries.push({ ref_id: 'r150', duplicate_of: undefined });
    const map = refsMap(entries);

    const result = resolveSurvivor('r0', map);
    assert.equal(result.broken, true);
    assert.equal(result.hops, 100);
});

test('resolveSurvivor: ちょうど100 hopの連鎖は上限内で解決できる（境界値）', () => {
    const entries: Array<Pick<Reference, 'ref_id' | 'duplicate_of'>> = [];
    for (let i = 0; i < 100; i++) {
        entries.push({ ref_id: `r${i}`, duplicate_of: `r${i + 1}` });
    }
    entries.push({ ref_id: 'r100', duplicate_of: undefined });
    const map = refsMap(entries);

    assert.deepEqual(resolveSurvivor('r0', map), { refId: 'r100', hops: 100, broken: false });
});

// ---------------------------------------------------------------------------
// diffReferenceFields
// ---------------------------------------------------------------------------

test('DUPLICATE_REVIEW_COMPARE_FIELDS: 指定された10フィールドがこの順序で並んでいる', () => {
    assert.deepEqual(DUPLICATE_REVIEW_COMPARE_FIELDS, [
        'title', 'journal', 'volume', 'issue', 'pages', 'doi', 'pmid', 'year', 'source', 'source_file',
    ]);
});

test('diffReferenceFields: 10フィールドがこの順序で全件返る（差異の有無に関わらず）', () => {
    const a = ref({ ref_id: 'a', title: 'Same Title' });
    const b = ref({ ref_id: 'b', title: 'Same Title' });
    const result = diffReferenceFields(a, b);
    assert.equal(result.length, 10);
    assert.deepEqual(result.map((r) => r.field), [
        'title', 'journal', 'volume', 'issue', 'pages', 'doi', 'pmid', 'year', 'source', 'source_file',
    ]);
});

test('diffReferenceFields: 差異のあるフィールドだけdiffers:trueになる', () => {
    const a = ref({ ref_id: 'a', title: 'Title', journal: 'Journal A', doi: '10.1/x' });
    const b = ref({ ref_id: 'b', title: 'Title', journal: 'Journal B', doi: '10.1/x' });
    const result = diffReferenceFields(a, b);

    const byField = new Map(result.map((r) => [r.field, r]));
    assert.equal(byField.get('title')?.differs, false);
    assert.equal(byField.get('journal')?.differs, true);
    assert.equal(byField.get('doi')?.differs, false);
});

test('diffReferenceFields: undefinedと空文字と空白のみが同値として扱われる', () => {
    const a = ref({ ref_id: 'a', title: 'T', journal: undefined });
    const b = ref({ ref_id: 'b', title: 'T', journal: '' });
    const c = ref({ ref_id: 'c', title: 'T', journal: '   ' });

    assert.equal(diffReferenceFields(a, b).find((r) => r.field === 'journal')?.differs, false);
    assert.equal(diffReferenceFields(a, c).find((r) => r.field === 'journal')?.differs, false);
    assert.equal(diffReferenceFields(b, c).find((r) => r.field === 'journal')?.differs, false);
});

test('diffReferenceFields: yearの数値が文字列化される', () => {
    const a = ref({ ref_id: 'a', title: 'T', year: 2024 });
    const b = ref({ ref_id: 'b', title: 'T', year: 2024 });
    const result = diffReferenceFields(a, b);
    const yearRow = result.find((r) => r.field === 'year');
    assert.equal(yearRow?.valueA, '2024');
    assert.equal(yearRow?.valueB, '2024');
    assert.equal(yearRow?.differs, false);
});

test('diffReferenceFields: 大文字小文字の違いは差異として扱われる（titleも例外にしない）', () => {
    const a = ref({ ref_id: 'a', title: 'A Sample Trial' });
    const b = ref({ ref_id: 'b', title: 'a sample trial' });
    const result = diffReferenceFields(a, b);
    assert.equal(result.find((r) => r.field === 'title')?.differs, true);
});

// ---------------------------------------------------------------------------
// scanReferencesForDuplicatePairs
// ---------------------------------------------------------------------------

test('scanReferencesForDuplicatePairs: 同一PMIDの2件を検出する', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Trial A', pmid: '12345678' }),
        ref({ ref_id: 'r2', title: 'Trial B', pmid: '12345678' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { refIdA: 'r1', refIdB: 'r2', matchType: 'pmid', matchKey: '12345678' });
});

test('scanReferencesForDuplicatePairs: 同一DOIの2件を検出する', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Trial A', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'r2', title: 'Trial B', doi: '10.1002/art.41108' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { refIdA: 'r1', refIdB: 'r2', matchType: 'doi', matchKey: '10.1002/art.41108' });
});

test('scanReferencesForDuplicatePairs: 正規化タイトル一致の2件を検出する', () => {
    const refs = [
        ref({ ref_id: 'r1', title: '[RCT] A Sample, Trial!' }),
        ref({ ref_id: 'r2', title: 'a sample trial' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 1);
    assert.equal(result[0].matchType, 'title');
    assert.equal(result[0].refIdA, 'r1');
    assert.equal(result[0].refIdB, 'r2');
});

test('scanReferencesForDuplicatePairs: 同一試験IDはsource一致・不一致の両方が返る', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'CTG Registration', pmid: 'NCT04145011', source: 'ClinicalTrials.gov' }),
        ref({ ref_id: 'r2', title: 'CTG Registration (再取り込み)', pmid: 'NCT04145011', source: 'ClinicalTrials.gov' }),
        ref({ ref_id: 'r3', title: 'ICTRP Registration', pmid: 'NCT04145011', source: 'CTRI' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    // trialIdバケットは [r1, r2, r3]。先頭r1との2ペア(r1,r2)(r1,r3)だけが返る。
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { refIdA: 'r1', refIdB: 'r2', matchType: 'trialId', matchKey: 'NCT04145011' });
    assert.deepEqual(result[1], { refIdA: 'r1', refIdB: 'r3', matchType: 'trialId', matchKey: 'NCT04145011' });
});

test('scanReferencesForDuplicatePairs: 同じ組がpmidとtitleの両方で一致したときpmidで1回だけ返る', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Same Trial Title', pmid: '12345678' }),
        ref({ ref_id: 'r2', title: 'Same Trial Title', pmid: '12345678' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 1);
    assert.equal(result[0].matchType, 'pmid');
});

test('scanReferencesForDuplicatePairs: バケットに3件あるとき先頭との2ペアだけ返る（C(3,2)=3ペアにならない）', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Trial A', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'r2', title: 'Trial B', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'r3', title: 'Trial C', doi: '10.1002/art.41108' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => [r.refIdA, r.refIdB]), [['r1', 'r2'], ['r1', 'r3']]);
});

test('scanReferencesForDuplicatePairs: 論理削除済みの行も検出対象に含まれる', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Trial A', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'r2', title: 'Trial B', doi: '10.1002/art.41108', duplicate_of: 'r1' }),
    ];
    const result = scanReferencesForDuplicatePairs(refs);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { refIdA: 'r1', refIdB: 'r2', matchType: 'doi', matchKey: '10.1002/art.41108' });
});

test('scanReferencesForDuplicatePairs: 空配列は空配列を返す', () => {
    assert.deepEqual(scanReferencesForDuplicatePairs([]), []);
});

test('scanReferencesForDuplicatePairs: 重複ゼロなら空配列を返す', () => {
    const refs = [
        ref({ ref_id: 'r1', title: 'Trial A' }),
        ref({ ref_id: 'r2', title: 'Trial B' }),
    ];
    assert.deepEqual(scanReferencesForDuplicatePairs(refs), []);
});

// ---------------------------------------------------------------------------
// isAutoApplicableCandidate
// ---------------------------------------------------------------------------

test('isAutoApplicableCandidate: pmidは常にtrue', () => {
    assert.equal(isAutoApplicableCandidate('pmid', { source: 'PubMed' }, { source: 'Embase' }), true);
});

test('isAutoApplicableCandidate: doiは常にtrue', () => {
    assert.equal(isAutoApplicableCandidate('doi', { source: 'A' }, { source: 'B' }), true);
});

test('isAutoApplicableCandidate: trialIdはsource一致でtrue', () => {
    assert.equal(
        isAutoApplicableCandidate('trialId', { source: 'ClinicalTrials.gov' }, { source: 'ClinicalTrials.gov' }),
        true
    );
});

test('isAutoApplicableCandidate: trialIdはsource不一致でfalse', () => {
    assert.equal(
        isAutoApplicableCandidate('trialId', { source: 'ClinicalTrials.gov' }, { source: 'CTRI' }),
        false
    );
});

test('isAutoApplicableCandidate: trialIdは大文字小文字と前後空白の違いを一致扱いする', () => {
    assert.equal(
        isAutoApplicableCandidate('trialId', { source: '  ClinicalTrials.gov  ' }, { source: 'clinicaltrials.gov' }),
        true
    );
});

test('isAutoApplicableCandidate: trialIdは双方sourceが空なら一致扱いでtrue', () => {
    assert.equal(isAutoApplicableCandidate('trialId', { source: undefined }, { source: undefined }), true);
});

test('isAutoApplicableCandidate: titleは常にfalse', () => {
    assert.equal(isAutoApplicableCandidate('title', { source: 'A' }, { source: 'A' }), false);
});

test('isAutoApplicableCandidate: refAまたはrefBがundefinedならfalse', () => {
    assert.equal(isAutoApplicableCandidate('pmid', undefined, { source: 'A' }), false);
    assert.equal(isAutoApplicableCandidate('pmid', { source: 'A' }, undefined), false);
});

// ---------------------------------------------------------------------------
// isPairAlreadySettled
// ---------------------------------------------------------------------------

function candidate(
    refIdA: string,
    refIdB: string,
    status: DuplicateCandidateStatus
): Pick<DuplicateCandidate, 'ref_id_a' | 'ref_id_b' | 'status'> {
    return { ref_id_a: refIdA, ref_id_b: refIdB, status };
}

test('isPairAlreadySettled: statusがmergedならtrue', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: undefined },
        { ref_id: 'b', duplicate_of: undefined },
    ]);
    assert.equal(isPairAlreadySettled(candidate('a', 'b', 'merged'), map), true);
});

test('isPairAlreadySettled: statusがdismissedならtrue', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: undefined },
        { ref_id: 'b', duplicate_of: undefined },
    ]);
    assert.equal(isPairAlreadySettled(candidate('a', 'b', 'dismissed'), map), true);
});

test('isPairAlreadySettled: 両側が同じsurvivorに辿り着くならtrue（片方がもう片方へ統合済み）', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: undefined },
        { ref_id: 'b', duplicate_of: 'a' },
    ]);
    assert.equal(isPairAlreadySettled(candidate('a', 'b', 'suggested'), map), true);
});

test('isPairAlreadySettled: どちらかの行が存在しないならtrue', () => {
    const map = refsMap([{ ref_id: 'a', duplicate_of: undefined }]);
    assert.equal(isPairAlreadySettled(candidate('a', 'missing', 'suggested'), map), true);
    assert.equal(isPairAlreadySettled(candidate('missing', 'a', 'suggested'), map), true);
});

test('isPairAlreadySettled: どちらでもない生きた組はfalse', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: undefined },
        { ref_id: 'b', duplicate_of: undefined },
    ]);
    assert.equal(isPairAlreadySettled(candidate('a', 'b', 'suggested'), map), false);
});

test('isPairAlreadySettled: resolveSurvivorが壊れている（循環）場合はsettledとみなさない（false）', () => {
    const map = refsMap([
        { ref_id: 'a', duplicate_of: undefined },
        { ref_id: 'b', duplicate_of: 'c' },
        { ref_id: 'c', duplicate_of: 'b' },
    ]);
    assert.equal(isPairAlreadySettled(candidate('a', 'b', 'suggested'), map), false);
});

// ---------------------------------------------------------------------------
// chooseKeptRefId
// ---------------------------------------------------------------------------

test('chooseKeptRefId: Aのほうが判定数が多ければAを残す', () => {
    assert.deepEqual(chooseKeptRefId('a', 'b', 3, 1), { keptRefId: 'a', removedRefId: 'b' });
});

test('chooseKeptRefId: Bのほうが判定数が多ければBを残す', () => {
    assert.deepEqual(chooseKeptRefId('a', 'b', 1, 3), { keptRefId: 'b', removedRefId: 'a' });
});

test('chooseKeptRefId: 同数ならAを残す', () => {
    assert.deepEqual(chooseKeptRefId('a', 'b', 2, 2), { keptRefId: 'a', removedRefId: 'b' });
});

test('chooseKeptRefId: 両方0件でもAを残す', () => {
    assert.deepEqual(chooseKeptRefId('a', 'b', 0, 0), { keptRefId: 'a', removedRefId: 'b' });
});
