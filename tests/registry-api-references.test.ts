import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCtgStudy } from '../src/lib/registry-api';

// Issue #118 チャンク2、PR #122 レビュー指摘1: fetchCtgStudy() の referencesModule.references から
// 'BACKGROUND'（試験結果と無関係な背景文献）だけを除外し、'RESULT'/'DERIVED'/種別欠落/未知の値は
// 残すことの回帰テスト。'RESULT' のみのallowlistにしない理由・BACKGROUND denylistの理由は
// src/lib/registry-api.ts のコメント参照。

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
});

function stubCtgStudy(references: Array<{ pmid?: string; type?: string }>): void {
    globalThis.fetch = (async () => new Response(JSON.stringify({
        protocolSection: {
            identificationModule: { officialTitle: 'Test Study' },
            referencesModule: { references },
        },
    }), { status: 200 })) as typeof fetch;
}

test('BACKGROUNDのみ -> pmidsは空', async () => {
    stubCtgStudy([{ pmid: '111', type: 'BACKGROUND' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, []);
});

test('RESULTのみ -> そのまま残る', async () => {
    stubCtgStudy([{ pmid: '222', type: 'RESULT' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['222']);
});

test('DERIVEDのみ -> そのまま残る', async () => {
    stubCtgStudy([{ pmid: '333', type: 'DERIVED' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['333']);
});

test('type欠落 -> 残る（後方互換）', async () => {
    stubCtgStudy([{ pmid: '444' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['444']);
});

test('typeが空文字 -> 残る', async () => {
    stubCtgStudy([{ pmid: '555', type: '' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['555']);
});

test('typeが未知の値（将来APIが増やす新種別を想定）-> 残る', async () => {
    stubCtgStudy([{ pmid: '666', type: 'SOMETHING_NEW' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['666']);
});

test('同一PMIDがBACKGROUNDとDERIVEDの両方に現れる -> 残る（除外してはいけない）', async () => {
    stubCtgStudy([
        { pmid: '777', type: 'BACKGROUND' },
        { pmid: '777', type: 'DERIVED' },
    ]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['777']);
});

test('大文字小文字違い（background）-> 除外される', async () => {
    stubCtgStudy([{ pmid: '888', type: 'background' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, []);
});

test('前後に空白のあるBackground（trimして判定）-> 除外される', async () => {
    stubCtgStudy([{ pmid: '999', type: '  Background  ' }]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, []);
});

test('pmidが空文字・空白のみ -> 落ちる', async () => {
    stubCtgStudy([
        { pmid: '', type: 'RESULT' },
        { pmid: '   ', type: 'DERIVED' },
        { pmid: '123', type: 'RESULT' },
    ]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['123']);
});

test('同一PMIDの重複（RESULT×2）-> 1件になる。元の出現順を保つ', async () => {
    stubCtgStudy([
        { pmid: '100', type: 'RESULT' },
        { pmid: '200', type: 'DERIVED' },
        { pmid: '100', type: 'DERIVED' },
    ]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['100', '200']);
});

test('混在ケース: BACKGROUND除外・RESULT/DERIVED残存・重複排除・順序保持を一度に確認', async () => {
    stubCtgStudy([
        { pmid: '1', type: 'BACKGROUND' },
        { pmid: '2', type: 'RESULT' },
        { pmid: '3', type: 'DERIVED' },
        { pmid: '2', type: 'BACKGROUND' }, // 既にRESULTで採用済みのPMIDが後からBACKGROUNDにも出る
        { pmid: '4' }, // type欠落
    ]);
    const result = await fetchCtgStudy('NCT00000001');
    assert.deepEqual(result?.pmids, ['2', '3', '4']);
});
