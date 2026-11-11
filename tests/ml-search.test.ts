import test from 'node:test';
import assert from 'node:assert/strict';
import { getMlFilteredRanking, resolveMlRanking } from '../src/sidepanel/features/ml/search';
import type { ReferenceWithStatus } from '../src/lib/types';

function ref(refId: string, title: string, abstract = ''): ReferenceWithStatus {
    return { ref_id: refId, title, abstract, status: 'pending' };
}

const references = [
    ref('r1', 'Aspirin for stroke prevention', 'randomized trial'),
    ref('r2', 'Aspirin in cardiology', 'cohort study'),
    ref('r3', 'Statin therapy', 'randomized trial of statins'),
    ref('r4', 'Aspirin and statin', 'randomized trial'),
];
const ranking = ['r3', 'r1', 'r4', 'r2'];

test('検索語なしならランキングをそのまま返す', () => {
    assert.equal(getMlFilteredRanking(ranking, references, [], 'and'), ranking);
});

test('AND は全語を含む文献だけを、ランキングの順で返す', () => {
    assert.deepEqual(getMlFilteredRanking(ranking, references, ['aspirin', 'randomized'], 'and'), ['r1', 'r4']);
});

test('OR はどれかの語を含む文献を、ランキングの順で返す', () => {
    assert.deepEqual(getMlFilteredRanking(ranking, references, ['cohort', 'statin'], 'or'), ['r3', 'r4', 'r2']);
});

test('references に無い ref_id は落とす', () => {
    assert.deepEqual(getMlFilteredRanking(['missing', 'r1'], references, ['aspirin'], 'or'), ['r1']);
});

test('同じ正規表現を続けて使っても lastIndex のせいで取りこぼさない', () => {
    // createSmartRegex は g 付きのため、lastIndex を戻さないと2件目以降が偽陰性になる
    const many = Array.from({ length: 5 }, (_, i) => ref(`m${i}`, 'aspirin trial'));
    const ids = many.map(r => r.ref_id);
    assert.deepEqual(getMlFilteredRanking(ids, many, ['aspirin'], 'and'), ids);
    assert.deepEqual(getMlFilteredRanking(ids, many, ['aspirin'], 'or'), ids);
});

test('resolveMlRanking は空のランキングなら文献順の ID を返す', () => {
    assert.deepEqual(resolveMlRanking(references, []), ['r1', 'r2', 'r3', 'r4']);
    assert.equal(resolveMlRanking(references, ranking), ranking);
});
