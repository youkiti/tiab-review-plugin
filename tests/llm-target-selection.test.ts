import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseLlmTargetMode,
    parseTargetRefIds,
    serializeTargetRefIds,
    resolveSelectedRefs,
    countTargetSelection,
    collectRefIdsBySet,
    collectSetIdsForRefs,
    exceedsTargetRefIdLimit,
    selectVisibleRefIds,
    buildTargetConfigUpdates,
    DEFAULT_LLM_TARGET_MODE,
    LLM_TARGET_REF_ID_LIMIT,
} from '../src/lib/llm-target-selection';
import { selectBatchTargetsByJudgedRefIds, BATCH_MAX_COUNT_ALL } from '../src/lib/llm-batch-target';

/** テスト用の文献（担当セットIDを付与できる） */
function ref(id: string, setId = '') {
    return { ref_id: id, screening_set: setId };
}

// ---------------------------------------------------------------------------
// parseLlmTargetMode
// ---------------------------------------------------------------------------

test('parseLlmTargetMode は "selection" のときだけ selection を返す', () => {
    assert.equal(parseLlmTargetMode('selection'), 'selection');
});

test('parseLlmTargetMode は不正値・空・未設定を既定値 all にフォールバックする', () => {
    assert.equal(parseLlmTargetMode('all'), 'all');
    assert.equal(parseLlmTargetMode(''), 'all');
    assert.equal(parseLlmTargetMode(null), 'all');
    assert.equal(parseLlmTargetMode(undefined), 'all');
    assert.equal(parseLlmTargetMode('bogus'), 'all');
    assert.equal(parseLlmTargetMode('all'), DEFAULT_LLM_TARGET_MODE);
});

// ---------------------------------------------------------------------------
// parseTargetRefIds
// ---------------------------------------------------------------------------

test('parseTargetRefIds はカンマ・改行混在を区切りとして扱う', () => {
    assert.deepEqual(parseTargetRefIds('a,b\nc,d'), ['a', 'b', 'c', 'd']);
});

test('parseTargetRefIds は前後空白を trim する', () => {
    assert.deepEqual(parseTargetRefIds(' a , b \n c '), ['a', 'b', 'c']);
});

test('parseTargetRefIds は空要素を除去する', () => {
    assert.deepEqual(parseTargetRefIds('a,,b,\n,c'), ['a', 'b', 'c']);
});

test('parseTargetRefIds は重複を除去しつつ出現順を維持する', () => {
    assert.deepEqual(parseTargetRefIds('b,a,b,c,a'), ['b', 'a', 'c']);
});

test('parseTargetRefIds は null/undefined/空文字で空配列を返す', () => {
    assert.deepEqual(parseTargetRefIds(null), []);
    assert.deepEqual(parseTargetRefIds(undefined), []);
    assert.deepEqual(parseTargetRefIds(''), []);
});

// ---------------------------------------------------------------------------
// serializeTargetRefIds
// ---------------------------------------------------------------------------

test('serializeTargetRefIds は trim・空除去・重複除去のうえカンマ区切り（空白なし）にする', () => {
    assert.equal(serializeTargetRefIds([' a ', 'b', '', 'a', ' c']), 'a,b,c');
});

test('serializeTargetRefIds と parseTargetRefIds はラウンドトリップする', () => {
    const original = ' b , a \n b, c ';
    const parsed = parseTargetRefIds(original);
    const serialized = serializeTargetRefIds(parsed);
    assert.equal(serialized, 'b,a,c');
    // 正規化済みの文字列を再度パースしても同じ結果になる
    assert.deepEqual(parseTargetRefIds(serialized), parsed);
});

// ---------------------------------------------------------------------------
// resolveSelectedRefs
// ---------------------------------------------------------------------------

test('resolveSelectedRefs は refs の並び順を維持したまま選択済みのものだけ返す', () => {
    const refs = [ref('a'), ref('b'), ref('c'), ref('d')];
    const selected = new Set(['d', 'b']);
    assert.deepEqual(resolveSelectedRefs(refs, selected).map(r => r.ref_id), ['b', 'd']);
});

test('resolveSelectedRefs は選択に含まれるが refs に無い ID を落とす', () => {
    const refs = [ref('a'), ref('b')];
    const selected = new Set(['a', 'missing']);
    assert.deepEqual(resolveSelectedRefs(refs, selected).map(r => r.ref_id), ['a']);
});

// ---------------------------------------------------------------------------
// countTargetSelection
// ---------------------------------------------------------------------------

test('countTargetSelection は available / alreadyJudged / planned を正しく数える', () => {
    const refs = [ref('a'), ref('b'), ref('c')];
    // 'missing' は refs に無い ID を選択に含めるケース
    const selected = new Set(['a', 'b', 'missing']);
    const judgedIds = new Set(['a']);
    const breakdown = countTargetSelection(refs, selected, r => judgedIds.has(r.ref_id));

    assert.equal(breakdown.selected, 3);       // 選択されている ref_id の総数（missing 含む）
    assert.equal(breakdown.available, 2);       // refs に実在するのは a, b の2件
    assert.equal(breakdown.alreadyJudged, 1);   // うち a のみ判定済み
    assert.equal(breakdown.planned, 1);         // 残り b の1件
});

test('countTargetSelection は選択が空なら全項目0を返す', () => {
    const refs = [ref('a'), ref('b')];
    const breakdown = countTargetSelection(refs, new Set(), () => true);
    assert.deepEqual(breakdown, { selected: 0, available: 0, alreadyJudged: 0, planned: 0 });
});

// ---------------------------------------------------------------------------
// collectRefIdsBySet / collectSetIdsForRefs
// ---------------------------------------------------------------------------

test('collectRefIdsBySet は指定セットに属する ref_id を refs の並び順で返す', () => {
    const refs = [
        ref('a', 'group-1'),
        ref('b', 'group-2'),
        ref('c', 'group-1'),
        ref('d', 'group-3'),
    ];
    const setIds = new Set(['group-1', 'group-3']);
    assert.deepEqual(
        collectRefIdsBySet(refs, setIds, r => r.screening_set),
        ['a', 'c', 'd']
    );
});

test('collectRefIdsBySet はどのセットにも属さない ref を含めない', () => {
    const refs = [ref('a', 'group-1'), ref('b', 'group-2')];
    assert.deepEqual(collectRefIdsBySet(refs, new Set(['group-9']), r => r.screening_set), []);
});

test('collectSetIdsForRefs は重複なく数値混じりの自然順（group-2 < group-10）でソートする', () => {
    const refs = [
        ref('a', 'group-10'),
        ref('b', 'group-2'),
        ref('c', 'group-1'),
        ref('d', 'group-2'), // 重複
    ];
    assert.deepEqual(
        collectSetIdsForRefs(refs, r => r.screening_set),
        ['group-1', 'group-2', 'group-10']
    );
});

test('collectSetIdsForRefs は空文字のセットIDを除外する', () => {
    const refs = [ref('a', ''), ref('b', 'group-1'), ref('c', '')];
    assert.deepEqual(collectSetIdsForRefs(refs, r => r.screening_set), ['group-1']);
});

// ---------------------------------------------------------------------------
// exceedsTargetRefIdLimit
// ---------------------------------------------------------------------------

test('exceedsTargetRefIdLimit はちょうど上限の件数では超過にならない', () => {
    assert.equal(exceedsTargetRefIdLimit(LLM_TARGET_REF_ID_LIMIT), false);
});

test('exceedsTargetRefIdLimit は上限を1件でも超えると true を返す', () => {
    assert.equal(exceedsTargetRefIdLimit(LLM_TARGET_REF_ID_LIMIT + 1), true);
});

test('exceedsTargetRefIdLimit は上限未満で false を返す', () => {
    assert.equal(exceedsTargetRefIdLimit(0), false);
    assert.equal(exceedsTargetRefIdLimit(1), false);
});

// ---------------------------------------------------------------------------
// 選択モードでは実行上限を無視する（resolveSelectedRefs × selectBatchTargetsByJudgedRefIds の合成）
//
// この機能の中心的な仕様: 選択モードでは実行上限セレクト（10/50/100/500/すべて）を無視して
// 選んだ分を全部投げる。「100件選んだのに上限50で切られた」という事故を防ぐための仕様なので、
// resolveSelectedRefs（対象選択の絞り込み）と selectBatchTargetsByJudgedRefIds（実行時の
// 対象確定。src/lib/llm-batch-target.ts）を実際の呼び出し順で合成して固定する。
// ---------------------------------------------------------------------------

test('選択モードでは実行上限を無視し、150件中120件選択した場合は120件すべてを対象にする', () => {
    const refs = Array.from({ length: 150 }, (_, i) => ref(`ref-${i}`));
    const selected = new Set(refs.slice(0, 120).map(r => r.ref_id));

    // 選択モードでは batch.ts 側が実行上限セレクトの値を無視して BATCH_MAX_COUNT_ALL を渡す
    // （src/sidepanel/features/llm/batch.ts の handleStartBatch 参照）。ここではその呼び出しを再現する
    const targets = selectBatchTargetsByJudgedRefIds(
        resolveSelectedRefs(refs, selected),
        BATCH_MAX_COUNT_ALL,
        new Set()
    );

    assert.equal(targets.length, 120);
    assert.deepEqual(
        new Set(targets.map(r => r.ref_id)),
        selected
    );
});

test('選択モードでもこの Run で判定済みの ref_id は実行上限とは別に除外される', () => {
    const refs = Array.from({ length: 150 }, (_, i) => ref(`ref-${i}`));
    const selectedIds = refs.slice(0, 120).map(r => r.ref_id);
    const selected = new Set(selectedIds);
    const judgedRefIds = new Set(selectedIds.slice(0, 30)); // 選択済み120件のうち30件がこのRunで判定済み

    const targets = selectBatchTargetsByJudgedRefIds(
        resolveSelectedRefs(refs, selected),
        BATCH_MAX_COUNT_ALL,
        judgedRefIds
    );

    assert.equal(targets.length, 90);
    assert.ok(targets.every(r => !judgedRefIds.has(r.ref_id)));
});

test('対比: 全件モード相当（母集合を絞らず実行上限 100 を渡す）では100件に切られる', () => {
    const refs = Array.from({ length: 150 }, (_, i) => ref(`ref-${i}`));

    // 選択モードと違い、resolveSelectedRefs を経由せず母集合をそのまま渡す（＝全件モード相当）
    const targets = selectBatchTargetsByJudgedRefIds(refs, '100', new Set());

    assert.equal(targets.length, 100);
});

// ---------------------------------------------------------------------------
// selectVisibleRefIds
// ---------------------------------------------------------------------------

test('selectVisibleRefIds は絞り込み結果のうち先頭 visibleLimit 件の ref_id だけを返す', () => {
    const refs = [ref('a'), ref('b'), ref('c'), ref('d')];
    assert.deepEqual(selectVisibleRefIds(refs, 2), ['a', 'b']);
});

test('selectVisibleRefIds は絞り込み結果が visibleLimit 以下なら全件を返す', () => {
    const refs = [ref('a'), ref('b')];
    assert.deepEqual(selectVisibleRefIds(refs, 200), ['a', 'b']);
});

test('selectVisibleRefIds は空配列に対して空配列を返す', () => {
    assert.deepEqual(selectVisibleRefIds([], 200), []);
});

// ---------------------------------------------------------------------------
// buildTargetConfigUpdates
// ---------------------------------------------------------------------------

test('buildTargetConfigUpdates は selection への変更時、ref_ids を先・mode を後の順で返す', () => {
    const updates = buildTargetConfigUpdates('selection', 'a,b,c');
    assert.deepEqual(updates, [
        { llm_target_ref_ids: 'a,b,c' },
        { llm_target_mode: 'selection' },
    ]);
});

test('buildTargetConfigUpdates は all への変更時、mode を先・ref_ids を後の順で返す', () => {
    const updates = buildTargetConfigUpdates('all', '');
    assert.deepEqual(updates, [
        { llm_target_mode: 'all' },
        { llm_target_ref_ids: '' },
    ]);
});

test('buildTargetConfigUpdates が返す各要素は必ず1キーだけを持つ（1回のHTTPリクエスト＝1キーに対応させるため）', () => {
    for (const update of buildTargetConfigUpdates('selection', 'x')) {
        assert.equal(Object.keys(update).length, 1);
    }
    for (const update of buildTargetConfigUpdates('all', '')) {
        assert.equal(Object.keys(update).length, 1);
    }
});
