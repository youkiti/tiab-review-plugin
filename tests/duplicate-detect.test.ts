import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoi, buildMatchKeys, normalizePairKey, isLogicallyDeleted, filterNewDuplicatePairs } from '../src/lib/duplicate-detect';
import type { DuplicateMatch } from '../src/lib/duplicate-detect';
import type { DuplicateCandidate, DuplicateCandidateStatus } from '../src/lib/types';

// Issue #145 チャンク1: 取り込み時の重複検出の回帰テスト。純関数層（duplicate-detect.ts）が対象。
// 判定（partitionIncomingReferences）は tests/duplicate-import-filter.test.ts で検証する。

// ---------------------------------------------------------------------------
// normalizeDoi
// ---------------------------------------------------------------------------

test('normalizeDoi: 生DOIとhttps://doi.org/接頭辞付きDOI（大文字混じり）は同じ値になる', () => {
    assert.equal(normalizeDoi('10.1002/art.41108'), '10.1002/art.41108');
    assert.equal(normalizeDoi('https://doi.org/10.1002/ART.41108'), '10.1002/art.41108');
});

test('normalizeDoi: DOI欄に論文番号が入っている実データのケースはundefinedになる', () => {
    assert.equal(normalizeDoi('e98323'), undefined);
});

test('normalizeDoi: undefined・空文字・空白のみはundefinedになる', () => {
    assert.equal(normalizeDoi(undefined), undefined);
    assert.equal(normalizeDoi(''), undefined);
    assert.equal(normalizeDoi('   '), undefined);
});

test('normalizeDoi: 有効なDOIはそのまま（小文字化して）通る', () => {
    assert.equal(normalizeDoi('10.1136/rapm-2022-104054'), '10.1136/rapm-2022-104054');
});

test('normalizeDoi: http://dx.doi.org/ や doi: の接頭辞も剥がされる', () => {
    assert.equal(normalizeDoi('http://dx.doi.org/10.1136/rapm-2022-104054'), '10.1136/rapm-2022-104054');
    assert.equal(normalizeDoi('doi:10.1136/rapm-2022-104054'), '10.1136/rapm-2022-104054');
});

test('normalizeDoi: http://doi.org/ とhttps://dx.doi.org/ の接頭辞も剥がされる（PR #146 レビュー指摘）', () => {
    assert.equal(normalizeDoi('http://doi.org/10.1136/rapm-2022-104054'), '10.1136/rapm-2022-104054');
    assert.equal(normalizeDoi('https://dx.doi.org/10.1136/rapm-2022-104054'), '10.1136/rapm-2022-104054');
});

// ---------------------------------------------------------------------------
// buildMatchKeys
// ---------------------------------------------------------------------------

test('buildMatchKeys: タイトルだけの行はtitleキーのみ設定される', () => {
    const keys = buildMatchKeys({ title: 'A Sample Trial', pmid: undefined, doi: undefined });
    assert.equal(keys.pmid, undefined);
    assert.equal(keys.doi, undefined);
    assert.equal(keys.title, 'a sample trial');
});

test('buildMatchKeys: DOIだけの行はdoiキーのみ設定される（タイトルは正規化後も空文字ならundefined）', () => {
    const keys = buildMatchKeys({ title: '', pmid: undefined, doi: '10.1002/art.41108' });
    assert.equal(keys.pmid, undefined);
    assert.equal(keys.doi, '10.1002/art.41108');
    assert.equal(keys.title, undefined);
});

test('buildMatchKeys: pmid・doi・titleすべて揃っている行は3本とも設定される', () => {
    const keys = buildMatchKeys({ title: 'A Sample Trial', pmid: '12345678', doi: '10.1002/art.41108' });
    assert.equal(keys.pmid, '12345678');
    assert.equal(keys.doi, '10.1002/art.41108');
    assert.equal(keys.title, 'a sample trial');
});

test('buildMatchKeys: 記号と大文字小文字だけが違うタイトルは同じキーになる（normalizeTitle()の既存挙動）', () => {
    const a = buildMatchKeys({ title: '[RCT] A Sample, Trial!', pmid: undefined, doi: undefined });
    const b = buildMatchKeys({ title: 'a sample trial', pmid: undefined, doi: undefined });
    assert.equal(a.title, b.title);
});

test('buildMatchKeys: pmidフィールドが数字のみなら実PMIDとしてpmidキーに入る', () => {
    const keys = buildMatchKeys({ title: '', pmid: '12345678', doi: undefined });
    assert.equal(keys.pmid, '12345678');
    assert.equal(keys.trialId, undefined);
});

test('buildMatchKeys: pmidフィールドがNCT番号ならtrialIdキーに入る（CTG由来のレコード）', () => {
    const keys = buildMatchKeys({ title: '', pmid: 'NCT04145011', doi: undefined });
    assert.equal(keys.pmid, undefined);
    assert.equal(keys.trialId, 'NCT04145011');
});

test('buildMatchKeys: pmidフィールドがCTRI番号ならtrialIdキーに入る（ICTRP経由のレコード）', () => {
    const keys = buildMatchKeys({ title: '', pmid: 'CTRI/2024/01/012345', doi: undefined });
    assert.equal(keys.pmid, undefined);
    assert.equal(keys.trialId, 'CTRI/2024/01/012345');
});

// ---------------------------------------------------------------------------
// normalizePairKey
// ---------------------------------------------------------------------------

test('normalizePairKey: 順序違いでも同じ組キーになる', () => {
    assert.equal(normalizePairKey('ref-a', 'ref-b'), normalizePairKey('ref-b', 'ref-a'));
});

test('normalizePairKey: 辞書順にソートして::で結合する', () => {
    assert.equal(normalizePairKey('ref-b', 'ref-a'), 'ref-a::ref-b');
});

// ---------------------------------------------------------------------------
// isLogicallyDeleted（Issue #145 チャンク2）
// ---------------------------------------------------------------------------

test('isLogicallyDeleted: duplicate_of が空文字・空白のみ・undefinedならfalse', () => {
    assert.equal(isLogicallyDeleted({ duplicate_of: '' }), false);
    assert.equal(isLogicallyDeleted({ duplicate_of: '   ' }), false);
    assert.equal(isLogicallyDeleted({ duplicate_of: undefined }), false);
    assert.equal(isLogicallyDeleted({}), false);
});

test('isLogicallyDeleted: duplicate_ofに値があればtrue', () => {
    assert.equal(isLogicallyDeleted({ duplicate_of: 'ref-keep' }), true);
    assert.equal(isLogicallyDeleted({ duplicate_of: '  ref-keep  ' }), true);
});

// ---------------------------------------------------------------------------
// filterNewDuplicatePairs（Issue #145 チャンク2）
// ---------------------------------------------------------------------------

function match(refIdA: string, refIdB: string, overrides: Partial<DuplicateMatch> = {}): DuplicateMatch {
    return { refIdA, refIdB, matchType: 'title', matchKey: 'a sample trial', ...overrides };
}

// getDuplicateCandidates()（src/lib/sheets/duplicate-candidates.ts）がシートから読んで返す実際の形
// （status を含む完全な DuplicateCandidate）を再現するファクトリ。existing の絞り込み型
// （Pick<DuplicateCandidate, 'ref_id_a' | 'ref_id_b'>）はTypeScriptの構造的部分型のもとでは
// 「余分なプロパティを持つオブジェクトも代入できる」だけで、「status を無視することを保証する」
// ものではない。実行時に本当に status を無視できているかは、status 込みの完全なオブジェクトを
// 渡して確かめないと検出できない（AGENTS.md の Pick 型すり抜け事例と同じ罠）。
function candidate(refIdA: string, refIdB: string, status: DuplicateCandidateStatus): DuplicateCandidate {
    return {
        candidate_id: `cand-${refIdA}-${refIdB}`,
        ref_id_a: refIdA,
        ref_id_b: refIdB,
        match_type: 'title',
        match_key: 'a sample trial',
        status,
        suggested_at: '2026-09-01T00:00:00.000Z',
        decided_by: status === 'suggested' ? undefined : 'reviewer@example.com',
        decided_at: status === 'suggested' ? undefined : '2026-09-02T00:00:00.000Z',
        kept_ref_id: status === 'merged' ? refIdA : undefined,
    };
}

test('filterNewDuplicatePairs: 既出のペアは落ちる', () => {
    const existing = [{ ref_id_a: 'ref-a', ref_id_b: 'ref-b' }];
    const incoming = [match('ref-a', 'ref-b'), match('ref-c', 'ref-d')];
    const result = filterNewDuplicatePairs(existing, incoming);
    assert.deepEqual(result, [match('ref-c', 'ref-d')]);
});

test('filterNewDuplicatePairs: existingがA,Bの向き・incomingがB,Aの向きでも落ちる', () => {
    const existing = [{ ref_id_a: 'ref-a', ref_id_b: 'ref-b' }];
    const incoming = [match('ref-b', 'ref-a')];
    const result = filterNewDuplicatePairs(existing, incoming);
    assert.deepEqual(result, []);
});

test('filterNewDuplicatePairs: incoming内に同じ組が2回あると1回だけ返る', () => {
    const result = filterNewDuplicatePairs([], [match('ref-a', 'ref-b'), match('ref-b', 'ref-a')]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], match('ref-a', 'ref-b'));
});

test('filterNewDuplicatePairs: statusに関係なく既出なら落ちる（dismissedの組も再提示しない）', () => {
    // getDuplicateCandidates() が返す実際の形（status を含む完全な DuplicateCandidate）を渡し、
    // suggested/dismissed/merged のどの状態でも既出ペアとして扱われる（＝再提示されない）ことを
    // 実行時に確認する。3状態すべてで挙動が同じ、というのがこの関数の仕様であるため。
    const existing = [
        candidate('ref-a', 'ref-b', 'suggested'),
        candidate('ref-c', 'ref-d', 'dismissed'),
        candidate('ref-e', 'ref-f', 'merged'),
    ];
    const incoming = [match('ref-a', 'ref-b'), match('ref-c', 'ref-d'), match('ref-e', 'ref-f')];
    assert.deepEqual(filterNewDuplicatePairs(existing, incoming), []);
});

test('filterNewDuplicatePairs: 未知の組は通る', () => {
    const existing = [{ ref_id_a: 'ref-a', ref_id_b: 'ref-b' }];
    const incoming = [match('ref-x', 'ref-y')];
    assert.deepEqual(filterNewDuplicatePairs(existing, incoming), incoming);
});
