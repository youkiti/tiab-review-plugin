import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isBatchEligible,
    resolveBatchLimit,
    selectBatchTargets,
} from '../src/lib/llm-batch-target';

/** テスト用の文献（status は AI バッチの対象判定に影響しないことの確認用に保持） */
function ref(id: string, opts: { status?: string; hasAnyLlmDecision?: boolean } = {}) {
    return {
        ref_id: id,
        status: opts.status ?? 'pending',
        hasAnyLlmDecision: opts.hasAnyLlmDecision ?? false,
    };
}

test('人間が判定済みの文献も AI バッチの対象になる', () => {
    assert.equal(isBatchEligible(ref('1', { status: 'include' })), true);
    assert.equal(isBatchEligible(ref('2', { status: 'exclude' })), true);
    assert.equal(isBatchEligible(ref('3', { status: 'maybe' })), true);
    assert.equal(isBatchEligible(ref('4', { status: 'conflict' })), true);
    assert.equal(isBatchEligible(ref('5', { status: 'pending' })), true);
});

test('AI 判定済みの文献は対象から除外される', () => {
    assert.equal(isBatchEligible(ref('1', { hasAnyLlmDecision: true })), false);
    // 人間が未判定でも、AI 判定済みなら再処理しない
    assert.equal(isBatchEligible(ref('2', { status: 'pending', hasAnyLlmDecision: true })), false);
});

test('hasAnyLlmDecision が未定義なら対象に含める', () => {
    assert.equal(isBatchEligible({}), true);
});

test('全50件中2件を人間が判定済みでも対象は50件のまま（issue 再現ケース）', () => {
    const refs = Array.from({ length: 50 }, (_, i) =>
        ref(`ref-${i}`, { status: i < 2 ? 'include' : 'pending' })
    );
    assert.equal(refs.filter(isBatchEligible).length, 50);
    assert.equal(selectBatchTargets(refs, 'all').length, 50);
});

test('resolveBatchLimit は "all" で上限なしを返す', () => {
    assert.equal(resolveBatchLimit('all'), null);
});

test('resolveBatchLimit は数値文字列をそのまま件数にする', () => {
    assert.equal(resolveBatchLimit('10'), 10);
    assert.equal(resolveBatchLimit('500'), 500);
});

test('resolveBatchLimit は解釈できない値をデフォルトの100にフォールバックする', () => {
    assert.equal(resolveBatchLimit('abc'), 100);
    assert.equal(resolveBatchLimit(''), 100);
    // '0' は parseInt 後に falsy となりデフォルト扱い（実行上限セレクトには存在しない値）
    assert.equal(resolveBatchLimit('0'), 100);
});

test('resolveBatchLimit は負値を1に丸める', () => {
    assert.equal(resolveBatchLimit('-5'), 1);
});

test('selectBatchTargets は上限まで切り出し、AI 判定済みは飛ばす', () => {
    const refs = [
        ref('a', { hasAnyLlmDecision: true }),
        ref('b', { status: 'include' }),
        ref('c'),
        ref('d'),
    ];
    const targets = selectBatchTargets(refs, '2');
    assert.deepEqual(targets.map(r => r.ref_id), ['b', 'c']);
});

test('selectBatchTargets は対象が上限より少なくても全件返す', () => {
    const refs = [ref('a'), ref('b')];
    assert.equal(selectBatchTargets(refs, '100').length, 2);
});
