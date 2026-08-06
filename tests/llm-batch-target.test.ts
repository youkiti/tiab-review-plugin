import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isBatchEligible,
    resolveBatchLimit,
    selectBatchTargetsByJudgedRefIds,
    collectJudgedRefIds,
    pickRunByConfigHash,
    pickLegacyRunByConfigHash,
    BATCH_MAX_COUNT_ALL,
} from '../src/lib/llm-batch-target';
import type { JudgedDecisionRow } from '../src/lib/llm-batch-target';
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

/** テスト用の Decisions 1行（collectJudgedRefIds 用） */
function decision(
    refId: string,
    reviewerId: string,
    opts: { screening_phase?: string } = {}
): JudgedDecisionRow {
    return {
        ref_id: refId,
        reviewer_id: reviewerId,
        screening_phase: opts.screening_phase,
    };
}

// ---------------------------------------------------------------------------
// 人間の判定は対象判定に影響しない
// ---------------------------------------------------------------------------

test('人間が判定済みの文献も AI バッチの対象になる', () => {
    for (const status of ['include', 'exclude', 'maybe', 'conflict', 'pending']) {
        assert.equal(isBatchEligible(ref('1', { status }), NO_RUN), true, status);
    }
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

// ---------------------------------------------------------------------------
// Run 単位の判定済み ref_id 抽出（collectJudgedRefIds）
//
// getJudgedRefIdsForBatches（Sheets 読み取り）の中核ロジック。実行時の重複判定防止は
// ここでの Run 分離（別 Run の Batch が判定した ref_id を拾わないこと）に懸かっている。
// ---------------------------------------------------------------------------

const BATCH_A1 = 'llm:gemini@2026-01-01T00:00:00Z';
const BATCH_A2 = 'llm:gemini@2026-01-01T09:00:00Z';
const BATCH_B1 = 'llm:gemini@2026-02-01T00:00:00Z';

test('batchIds に含まれる Batch の判定だけが拾われ、別 Run の Batch が判定した ref_id は拾われない', () => {
    const decisions = [
        decision('ref-1', BATCH_A1),
        decision('ref-2', BATCH_B1),
    ];
    const judged = collectJudgedRefIds(decisions, new Set([BATCH_A1]));
    assert.deepEqual([...judged], ['ref-1']);
});

test('同一 Run の複数 Batch にまたがる判定がまとめて拾われる', () => {
    const decisions = [
        decision('ref-1', BATCH_A1),
        decision('ref-2', BATCH_A2),
        decision('ref-3', BATCH_B1),
    ];
    const judged = collectJudgedRefIds(decisions, new Set([BATCH_A1, BATCH_A2]));
    assert.deepEqual([...judged].sort(), ['ref-1', 'ref-2']);
});

test('screening_phase が fulltext の行は無視され、未設定（undefined）は tiab として拾われる', () => {
    const decisions = [
        decision('ref-1', BATCH_A1, { screening_phase: 'fulltext' }),
        decision('ref-2', BATCH_A1), // screening_phase 未設定
    ];
    const judged = collectJudgedRefIds(decisions, new Set([BATCH_A1]));
    assert.deepEqual([...judged], ['ref-2']);
});

test('reviewer_id / ref_id の前後空白が trim されて正しくマッチする', () => {
    const decisions = [decision(' ref-1 ', ` ${BATCH_A1} `)];
    const judged = collectJudgedRefIds(decisions, new Set([BATCH_A1]));
    assert.deepEqual([...judged], ['ref-1']);
});

test('batchIds が空なら空 Set を返す', () => {
    const decisions = [decision('ref-1', BATCH_A1)];
    assert.equal(collectJudgedRefIds(decisions, new Set()).size, 0);
});

// ---------------------------------------------------------------------------
// 実行時の対象確定（selectBatchTargetsByJudgedRefIds）
//
// この関数は実行直前に Sheets から読み直した「その Run で判定済みの ref_id」を受け取る。
// Batch ID の集合ではなく ref_id の集合であることに注意（isBatchEligible とは入力が違う）。
// ---------------------------------------------------------------------------

test('judgedRefIds が空なら全件が対象になる', () => {
    const refs = Array.from({ length: 50 }, (_, i) => ref(`ref-${i}`));
    assert.equal(selectBatchTargetsByJudgedRefIds(refs, 'all', new Set()).length, 50);
});

test('judgedRefIds に含まれる ref は除外される', () => {
    const refs = [ref('a'), ref('b', { status: 'include' }), ref('c'), ref('d')];
    const targets = selectBatchTargetsByJudgedRefIds(refs, 'all', new Set(['a', 'd']));
    assert.deepEqual(targets.map(r => r.ref_id), ['b', 'c']);
});

test('上限（maxCountRaw）は除外後の件数に対して適用される', () => {
    const refs = [ref('a'), ref('b'), ref('c'), ref('d')];
    // 'a' を除外した残り3件（b, c, d）に上限2件が適用される
    const targets = selectBatchTargetsByJudgedRefIds(refs, '2', new Set(['a']));
    assert.deepEqual(targets.map(r => r.ref_id), ['b', 'c']);
});

test('BATCH_MAX_COUNT_ALL のとき上限なしで全件返る', () => {
    const refs = Array.from({ length: 5 }, (_, i) => ref(`ref-${i}`));
    assert.equal(selectBatchTargetsByJudgedRefIds(refs, BATCH_MAX_COUNT_ALL, new Set()).length, 5);
});

test('対象が上限より少なくても全件返る', () => {
    assert.equal(selectBatchTargetsByJudgedRefIds([ref('a'), ref('b')], '100', new Set()).length, 2);
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
