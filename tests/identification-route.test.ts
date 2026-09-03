import test from 'node:test';
import assert from 'node:assert/strict';
import {
    identificationRouteOf,
    splitByIdentificationRoute,
    buildOtherMethodsPrismaLines,
} from '../src/lib/identification-route';
import type { Reference } from '../src/lib/types';

// ---------------------------------------------------------------------------
// identificationRouteOf
// ---------------------------------------------------------------------------

test('identificationRouteOf: related_ref_id が非空なら registry_linkage', () => {
    assert.equal(identificationRouteOf({ related_ref_id: 'reg-1' }), 'registry_linkage');
});

test('identificationRouteOf: related_ref_id が空文字なら database', () => {
    assert.equal(identificationRouteOf({ related_ref_id: '' }), 'database');
});

test('identificationRouteOf: related_ref_id が undefined なら database', () => {
    assert.equal(identificationRouteOf({ related_ref_id: undefined }), 'database');
});

test('identificationRouteOf: related_ref_id が省略（キー自体が無い）なら database', () => {
    assert.equal(identificationRouteOf({}), 'database');
});

test('identificationRouteOf: related_ref_id が空白のみなら database（trim して空扱い）', () => {
    assert.equal(identificationRouteOf({ related_ref_id: '   ' }), 'database');
});

// ---------------------------------------------------------------------------
// splitByIdentificationRoute
// ---------------------------------------------------------------------------

test('splitByIdentificationRoute: database / registryLinkage の合計が入力件数と一致する（腕別集計の生命線）', () => {
    const refs: Array<Pick<Reference, 'related_ref_id'>> = [
        { related_ref_id: '' },
        { related_ref_id: 'reg-1' },
        { related_ref_id: undefined },
        { related_ref_id: 'reg-2' },
        { related_ref_id: '   ' },
    ];

    const { database, registryLinkage } = splitByIdentificationRoute(refs);

    assert.equal(database.length + registryLinkage.length, refs.length);
    assert.equal(database.length, 3);
    assert.equal(registryLinkage.length, 2);
});

test('splitByIdentificationRoute: 全件 database（Registry linkage行が0件のプロジェクトを再現）', () => {
    const refs: Array<Pick<Reference, 'related_ref_id'>> = [
        { related_ref_id: '' },
        { related_ref_id: '' },
        { related_ref_id: undefined },
    ];

    const { database, registryLinkage } = splitByIdentificationRoute(refs);

    assert.equal(database.length, refs.length);
    assert.equal(registryLinkage.length, 0);
});

test('splitByIdentificationRoute: registry行が0件のとき database は入力と同一の配列内容・同一順序を返す（manuscript.ts の各集計の無回帰性が全てこの性質に乗っている）', () => {
    const refs = [
        { id: 'a', related_ref_id: '' },
        { id: 'b', related_ref_id: undefined },
        { id: 'c', related_ref_id: '   ' },
    ];

    const { database, registryLinkage } = splitByIdentificationRoute(refs);

    assert.deepEqual(database, refs);
    assert.deepEqual(database.map(r => r.id), ['a', 'b', 'c']);
    assert.equal(registryLinkage.length, 0);
});

test('splitByIdentificationRoute: 空配列を渡すと両方とも空配列', () => {
    const { database, registryLinkage } = splitByIdentificationRoute([]);
    assert.deepEqual(database, []);
    assert.deepEqual(registryLinkage, []);
});

test('splitByIdentificationRoute: 元の順序を維持したまま振り分ける', () => {
    const refs = [
        { id: 'a', related_ref_id: 'reg-1' },
        { id: 'b', related_ref_id: '' },
        { id: 'c', related_ref_id: 'reg-2' },
        { id: 'd', related_ref_id: '' },
    ];

    const { database, registryLinkage } = splitByIdentificationRoute(refs);

    assert.deepEqual(database.map(r => r.id), ['b', 'd']);
    assert.deepEqual(registryLinkage.map(r => r.id), ['a', 'c']);
});

// ---------------------------------------------------------------------------
// buildOtherMethodsPrismaLines
// ---------------------------------------------------------------------------

test('buildOtherMethodsPrismaLines: summary が null なら空配列（リグレッションなしの担保）', () => {
    const lines = buildOtherMethodsPrismaLines(null, (r) => r);
    assert.deepEqual(lines, []);
});

test('buildOtherMethodsPrismaLines: sought === 0 なら空配列（リグレッションなしの担保）', () => {
    const lines = buildOtherMethodsPrismaLines(
        { sought: 0, obtained: 0, notRetrieved: 0, include: 0, exclude: 0, reasons: [] },
        (r) => r
    );
    assert.deepEqual(lines, []);
});

test('buildOtherMethodsPrismaLines: sought が1件以上なら同定・取得・評価・組み入れの行が出る', () => {
    const lines = buildOtherMethodsPrismaLines(
        { sought: 5, obtained: 4, notRetrieved: 1, include: 2, exclude: 2, reasons: [] },
        (r) => r
    );

    assert.ok(lines.length > 0);
    assert.ok(lines.some(l => l.includes('Records identified via registry linkage (n = 5)')));
    assert.ok(lines.some(l => l.includes('Reports sought for retrieval (n = 5)')));
    assert.ok(lines.some(l => l.includes('Reports not retrieved (n = 1)')));
    assert.ok(lines.some(l => l.includes('Reports assessed for eligibility (n = 4)')));
    assert.ok(lines.some(l => l.includes('Reports excluded (n = 2)')));
    assert.ok(lines.some(l => l.includes('Studies included in review (n = 2)')));
});

test('buildOtherMethodsPrismaLines: 除外理由が理由別の行として出る', () => {
    const lines = buildOtherMethodsPrismaLines(
        {
            sought: 3,
            obtained: 3,
            notRetrieved: 0,
            include: 1,
            exclude: 2,
            reasons: [
                { reason: 'population', count: 1 },
                { reason: 'study_design', count: 1 },
            ],
        },
        (r) => r
    );

    assert.ok(lines.some(l => l.includes('population (n = 1)')));
    assert.ok(lines.some(l => l.includes('study_design (n = 1)')));
});

test('buildOtherMethodsPrismaLines: reasonLabel が理由の変換に実際に使われる', () => {
    const calledWith: string[] = [];
    const lines = buildOtherMethodsPrismaLines(
        {
            sought: 1,
            obtained: 1,
            notRetrieved: 0,
            include: 0,
            exclude: 1,
            reasons: [{ reason: 'population', count: 1 }],
        },
        (reason) => {
            calledWith.push(reason);
            return `[EN] ${reason}`;
        }
    );

    assert.deepEqual(calledWith, ['population']);
    assert.ok(lines.some(l => l.includes('[EN] population (n = 1)')));
});

test('buildOtherMethodsPrismaLines: 除外理由が無ければコロン無しの「Reports excluded」行になる', () => {
    const lines = buildOtherMethodsPrismaLines(
        { sought: 2, obtained: 2, notRetrieved: 0, include: 2, exclude: 0, reasons: [] },
        (r) => r
    );
    assert.ok(lines.some(l => l === '  Reports excluded (n = 0)'));
});
