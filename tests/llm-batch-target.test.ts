import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isBatchEligible,
    resolveBatchLimit,
    selectBatchTargets,
    pickRunByConfigHash,
    pickLegacyRunByConfigHash,
} from '../src/lib/llm-batch-target';
import type { LlmRun } from '../src/lib/types';

/** テスト用の文献（status は AI バッチの対象判定に影響しないことの確認用に保持） */
function ref(id: string, opts: { status?: string; llmBatchIds?: string[] } = {}) {
    return {
        ref_id: id,
        status: opts.status ?? 'pending',
        llmBatchIds: opts.llmBatchIds ?? [],
    };
}

/** Run A / Run B の Batch ID */
const RUN_A = new Set(['llm:gemini@2026-01-01T00:00:00Z']);
const RUN_B = new Set(['llm:gemini@2026-02-01T00:00:00Z']);
const NO_RUN = new Set<string>();

// ---------------------------------------------------------------------------
// 人間の判定は対象判定に影響しない
// ---------------------------------------------------------------------------

test('人間が判定済みの文献も AI バッチの対象になる', () => {
    for (const status of ['include', 'exclude', 'maybe', 'conflict', 'pending']) {
        assert.equal(isBatchEligible(ref('1', { status }), NO_RUN), true, status);
    }
});

test('全50件中2件を人間が判定済みでも対象は50件のまま', () => {
    const refs = Array.from({ length: 50 }, (_, i) =>
        ref(`ref-${i}`, { status: i < 2 ? 'include' : 'pending' })
    );
    assert.equal(selectBatchTargets(refs, 'all', NO_RUN).length, 50);
});

// ---------------------------------------------------------------------------
// 対象判定は Run 単位
// ---------------------------------------------------------------------------

test('同じ Run で判定済みの文献は除外される（中断からの続き）', () => {
    const judged = ref('1', { llmBatchIds: [...RUN_A] });
    assert.equal(isBatchEligible(judged, RUN_A), false);
});

test('別の Run で判定済みでも対象になる（別モデル・別プロンプトでの再実行）', () => {
    const judgedByA = ref('1', { llmBatchIds: [...RUN_A] });
    assert.equal(isBatchEligible(judgedByA, RUN_B), true);
});

test('Run 1 が全50件を判定済みでも、別 Run では全50件が対象になる', () => {
    const refs = Array.from({ length: 50 }, (_, i) =>
        ref(`ref-${i}`, { llmBatchIds: [...RUN_A] })
    );
    // 同じ Run では 0 件（＝全部処理済み）
    assert.equal(selectBatchTargets(refs, 'all', RUN_A).length, 0);
    // 別 Run では 50 件すべてが対象
    assert.equal(selectBatchTargets(refs, 'all', RUN_B).length, 50);
    // 新規 Run（判定済み集合が空）でも 50 件
    assert.equal(selectBatchTargets(refs, 'all', NO_RUN).length, 50);
});

test('中断した Run を再開すると残りだけが対象になる', () => {
    const refs = Array.from({ length: 50 }, (_, i) =>
        ref(`ref-${i}`, { llmBatchIds: i < 30 ? [...RUN_A] : [] })
    );
    assert.equal(selectBatchTargets(refs, 'all', RUN_A).length, 20);
});

test('複数バッチに分かれた Run でも、その Run の全バッチが除外対象になる', () => {
    const batch1 = 'llm:gemini@2026-01-01T00:00:00Z';
    const batch2 = 'llm:gemini@2026-01-01T09:00:00Z';
    const run = new Set([batch1, batch2]);
    assert.equal(isBatchEligible(ref('1', { llmBatchIds: [batch1] }), run), false);
    assert.equal(isBatchEligible(ref('2', { llmBatchIds: [batch2] }), run), false);
    assert.equal(isBatchEligible(ref('3', { llmBatchIds: [] }), run), true);
});

test('llmBatchIds が未定義でも対象に含める', () => {
    assert.equal(isBatchEligible({}, RUN_A), true);
});

// ---------------------------------------------------------------------------
// 実行上限
// ---------------------------------------------------------------------------

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

test('selectBatchTargets は上限まで切り出し、同一 Run で判定済みは飛ばす', () => {
    const refs = [
        ref('a', { llmBatchIds: [...RUN_A] }),
        ref('b', { status: 'include' }),
        ref('c'),
        ref('d'),
    ];
    const targets = selectBatchTargets(refs, '2', RUN_A);
    assert.deepEqual(targets.map(r => r.ref_id), ['b', 'c']);
});

test('selectBatchTargets は対象が上限より少なくても全件返す', () => {
    assert.equal(selectBatchTargets([ref('a'), ref('b')], '100', NO_RUN).length, 2);
});

// ---------------------------------------------------------------------------
// config_hash からの Run 選択
// ---------------------------------------------------------------------------

function run(id: string, opts: Partial<LlmRun> = {}): LlmRun {
    return {
        run_id: id,
        config_hash: opts.config_hash ?? 'v1:hashX',
        created_at: opts.created_at ?? '2026-01-01T00:00:00Z',
        model: 'gemini-2.5-flash',
        criteria_snapshot: null,
        screening_prompt: 'p',
        include_threshold: 0.3,
        status: opts.status ?? 'pending',
        is_active: opts.is_active ?? false,
    };
}

test('pickRunByConfigHash は該当なしで null を返す', () => {
    assert.equal(pickRunByConfigHash([run('a')], 'v1:other'), null);
});

test('pickRunByConfigHash は同一 config_hash のうち最新の Run を返す（やり直し後の再開先）', () => {
    const older = run('old', { created_at: '2026-01-01T00:00:00Z', status: 'confirmed', is_active: true });
    const newer = run('new', { created_at: '2026-03-01T00:00:00Z' });
    assert.equal(pickRunByConfigHash([older, newer], 'v1:hashX')?.run_id, 'new');
    // 配列の順序に依存しない
    assert.equal(pickRunByConfigHash([newer, older], 'v1:hashX')?.run_id, 'new');
});

test('pickRunByConfigHash は created_at 同着なら active confirmed を優先する', () => {
    const pending = run('pending', { created_at: '2026-01-01T00:00:00Z' });
    const confirmed = run('confirmed', { created_at: '2026-01-01T00:00:00Z', status: 'confirmed' });
    const activeConfirmed = run('active', {
        created_at: '2026-01-01T00:00:00Z',
        status: 'confirmed',
        is_active: true,
    });
    assert.equal(pickRunByConfigHash([pending, confirmed, activeConfirmed], 'v1:hashX')?.run_id, 'active');
    assert.equal(pickRunByConfigHash([pending, confirmed], 'v1:hashX')?.run_id, 'confirmed');
});

test('pickLegacyRunByConfigHash は最も古い Run を返す（legacy バッチはやり直し前の実行）', () => {
    const older = run('old', { created_at: '2026-01-01T00:00:00Z' });
    const newer = run('new', { created_at: '2026-03-01T00:00:00Z' });
    assert.equal(pickLegacyRunByConfigHash([newer, older], 'v1:hashX')?.run_id, 'old');
    assert.equal(pickLegacyRunByConfigHash([], 'v1:hashX'), null);
});
