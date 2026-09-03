import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionIncomingReferences } from '../src/lib/duplicate-import-filter';
import type { Reference } from '../src/lib/types';

// Issue #145 チャンク1: 取り込み時の重複検出の回帰テスト。partitionIncomingReferences() が対象。
// 特に「バッチ内重複を見ていない」不具合（同一ファイル内でDOIが完全一致する2件が両方
// 取り込まれてしまう）の回帰テストを最重要ケースとして固定する。

function ref(overrides: Partial<Reference> = {}): Reference {
    return {
        ref_id: 'ref-new',
        title: 'A Sample Trial',
        ...overrides,
    };
}

test('partitionIncomingReferences: バッチ内でDOIが完全一致する2件は1件目だけtoImportに入る（同一ファイル内の重複が両方通っていた不具合の回帰テスト）', () => {
    const incoming = [
        ref({ ref_id: 'ref-1', title: 'Trial A', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'ref-2', title: 'Trial A (duplicate)', doi: '10.1002/art.41108' }),
    ];

    const result = partitionIncomingReferences([], incoming);

    assert.equal(result.toImport.length, 1);
    assert.equal(result.toImport[0].ref_id, 'ref-1');
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].ref.ref_id, 'ref-2');
    assert.equal(result.autoSkipped[0].matchType, 'doi');
    assert.equal(result.autoSkipped[0].existingRefId, 'ref-1');
});

test('partitionIncomingReferences: 既存シート行とPMIDが一致するincomingはautoSkippedに入る', () => {
    const existing = [{ ref_id: 'existing-1', title: 'Existing Trial', pmid: '12345678', doi: undefined }];
    const incoming = [ref({ ref_id: 'ref-1', title: 'New Title', pmid: '12345678' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 0);
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].matchType, 'pmid');
    assert.equal(result.autoSkipped[0].matchKey, '12345678');
    assert.equal(result.autoSkipped[0].existingRefId, 'existing-1');
});

test('partitionIncomingReferences: タイトルだけ一致するincomingはtoImportに入り、reviewPairsが1件出る', () => {
    const existing = [{ ref_id: 'existing-1', title: 'A Sample Trial', pmid: undefined, doi: undefined }];
    const incoming = [ref({ ref_id: 'ref-1', title: 'A Sample Trial' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 1);
    assert.equal(result.toImport[0].ref_id, 'ref-1');
    assert.equal(result.autoSkipped.length, 0);
    assert.equal(result.reviewPairs.length, 1);
    assert.deepEqual(result.reviewPairs[0], {
        refIdA: 'existing-1',
        refIdB: 'ref-1',
        matchType: 'title',
        matchKey: 'a sample trial',
    });
});

test('partitionIncomingReferences: 壊れたDOI（e98323）を両方が持つ2件はDOIでは一致と判定されない', () => {
    const incoming = [
        ref({ ref_id: 'ref-1', title: 'Trial A', doi: 'e98323' }),
        ref({ ref_id: 'ref-2', title: 'Trial B', doi: 'e98323' }),
    ];

    const result = partitionIncomingReferences([], incoming);

    assert.equal(result.toImport.length, 2);
    assert.equal(result.autoSkipped.length, 0);
});

test('partitionIncomingReferences: 片方にだけDOIがあり、もう片方が同じタイトルを持つ場合はtoImportに入りつつreviewPairsが出る', () => {
    const incoming = [
        ref({ ref_id: 'ref-1', title: 'Same Title', doi: '10.1002/art.41108' }),
        ref({ ref_id: 'ref-2', title: 'Same Title' }),
    ];

    const result = partitionIncomingReferences([], incoming);

    assert.equal(result.toImport.length, 2);
    assert.equal(result.autoSkipped.length, 0);
    assert.equal(result.reviewPairs.length, 1);
    assert.equal(result.reviewPairs[0].refIdA, 'ref-1');
    assert.equal(result.reviewPairs[0].refIdB, 'ref-2');
    assert.equal(result.reviewPairs[0].matchType, 'title');
});

test('partitionIncomingReferences: キーを何も持たない行（タイトル空・DOI/PMID無し）は落ちずにtoImportへ入る', () => {
    const incoming = [
        ref({ ref_id: 'ref-1', title: '' }),
        ref({ ref_id: 'ref-2', title: '' }),
    ];

    const result = partitionIncomingReferences([], incoming);

    assert.equal(result.toImport.length, 2);
    assert.equal(result.autoSkipped.length, 0);
    assert.equal(result.reviewPairs.length, 0);
});

test('partitionIncomingReferences: 既存が空でも正常に動く（pmid/doi/titleいずれも既存側に無い場合）', () => {
    const result = partitionIncomingReferences([], [ref({ ref_id: 'ref-1' })]);

    assert.equal(result.toImport.length, 1);
    assert.equal(result.autoSkipped.length, 0);
    assert.equal(result.reviewPairs.length, 0);
});

// ---------------------------------------------------------------------------
// 試験ID（NCT等）の扱い
// 試験登録レコードは Reference.pmid フィールドに試験IDを格納している
// （ctg-parser.ts / ictrp-parser.ts 参照）。試験IDは「研究」の識別子であって「レコード」の
// 識別子ではないため、source（レジストリ）まで一致したときだけ自動スキップしてよい。
// ---------------------------------------------------------------------------

test('partitionIncomingReferences: 同一NCT番号かつ同一source（ClinicalTrials.gov同士）はautoSkippedに入る', () => {
    const existing = [
        { ref_id: 'existing-1', title: 'CTG Registration', pmid: 'NCT04145011', doi: undefined, source: 'ClinicalTrials.gov' },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'CTG Registration (再取り込み)', pmid: 'NCT04145011', source: 'ClinicalTrials.gov' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 0);
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].matchType, 'trialId');
    assert.equal(result.autoSkipped[0].matchKey, 'NCT04145011');
    assert.equal(result.autoSkipped[0].existingRefId, 'existing-1');
});

// この修正の核となるテスト: 同じ試験の登録レコードでも、レジストリ（source）が違えば
// 別レコードとして残す（利用者向け手順書に明記済みの挙動）。取り込みは通し、
// 「要確認」として reviewPairs に記録するだけにとどめる。
test('partitionIncomingReferences: 同一NCT番号でもsourceが異なる（ClinicalTrials.gov と CTRI）場合はtoImportに入りreviewPairsが1件出る', () => {
    const existing = [
        { ref_id: 'existing-1', title: 'CTG Registration', pmid: 'NCT04145011', doi: undefined, source: 'ClinicalTrials.gov' },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'ICTRP Registration', pmid: 'NCT04145011', source: 'CTRI' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 1);
    assert.equal(result.toImport[0].ref_id, 'ref-1');
    assert.equal(result.autoSkipped.length, 0);
    assert.equal(result.reviewPairs.length, 1);
    assert.deepEqual(result.reviewPairs[0], {
        refIdA: 'existing-1',
        refIdB: 'ref-1',
        matchType: 'trialId',
        matchKey: 'NCT04145011',
    });
});

test('partitionIncomingReferences: 数字のみの実PMIDはsourceが異なっても従来どおりautoSkippedに入る', () => {
    const existing = [
        { ref_id: 'existing-1', title: 'PubMed Article', pmid: '12345678', doi: undefined, source: 'PubMed' },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'Different Title', pmid: '12345678', source: 'Embase' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 0);
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].matchType, 'pmid');
});

test('partitionIncomingReferences: 同一NCT番号かつ双方sourceが空はautoSkippedに入る（空同士は一致とみなす）', () => {
    const existing = [
        { ref_id: 'existing-1', title: 'CTG Registration', pmid: 'NCT04145011', doi: undefined, source: undefined },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'CTG Registration (再取り込み)', pmid: 'NCT04145011', source: undefined })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 0);
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].matchType, 'trialId');
});

// この修正の核となるテスト: 既存シートに同一試験IDでsourceが異なる行が2つ（別レジストリの
// 別レコードとして正しく残っている状態）あるとき、そのうち一方と同じsourceを持つincomingは、
// 試験IDだけのインデックスで先に見つかる側（別source）ではなく、sourceも一致する真の重複側へ
// 自動スキップされなければならない。
test('partitionIncomingReferences: 既存に同一試験IDで異なるsourceの行が2つある場合、autoSkippedのexistingRefIdはsourceが一致する側になる', () => {
    const existing = [
        { ref_id: 'existing-ctgov', title: 'CTG Registration', pmid: 'NCT04145011', doi: undefined, source: 'ClinicalTrials.gov' },
        { ref_id: 'existing-ctri', title: 'ICTRP Registration', pmid: 'NCT04145011', doi: undefined, source: 'CTRI' },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'ICTRP Registration (別ファイルから再取り込み)', pmid: 'NCT04145011', source: 'CTRI' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 0);
    assert.equal(result.autoSkipped.length, 1);
    assert.equal(result.autoSkipped[0].matchType, 'trialId');
    assert.equal(result.autoSkipped[0].existingRefId, 'existing-ctri');
    assert.equal(result.reviewPairs.length, 0);
});

test('partitionIncomingReferences: trialIdとtitleが両方一致する組はreviewPairsが1件だけになる（同じ組を二重に積まない）', () => {
    const existing = [
        { ref_id: 'existing-1', title: 'Same Trial Title', pmid: 'NCT04145011', doi: undefined, source: 'ClinicalTrials.gov' },
    ];
    const incoming = [ref({ ref_id: 'ref-1', title: 'Same Trial Title', pmid: 'NCT04145011', source: 'CTRI' })];

    const result = partitionIncomingReferences(existing, incoming);

    assert.equal(result.toImport.length, 1);
    assert.equal(result.reviewPairs.length, 1);
    assert.equal(result.reviewPairs[0].matchType, 'trialId');
});
