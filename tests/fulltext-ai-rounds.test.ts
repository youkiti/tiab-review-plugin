import test from 'node:test';
import assert from 'node:assert/strict';
import {
    deriveRounds,
    mergeRoundsWithExecutions,
    type AiRound,
} from '../src/lib/fulltext-ai-rounds';
import type { Decision, LlmExecution } from '../src/lib/types';

// ---------------------------------------------------------------------------
// テスト用ヘルパー
// ---------------------------------------------------------------------------

function makeDecision(overrides: Partial<Decision> = {}): Decision {
    return {
        decision_id: crypto.randomUUID(),
        ref_id: 'ref-1',
        reviewer_id: 'llm:gemini-2.5-flash@2026-08-01T00:00:00.000Z',
        decision: 'include',
        decided_at: '2026-08-01T00:00:00.000Z',
        screening_phase: 'fulltext',
        ...overrides,
    };
}

function makeExecution(overrides: Partial<LlmExecution> = {}): LlmExecution {
    return {
        execution_id: 'llm:gemini-2.5-flash@2026-08-01T00:00:00.000Z',
        execution_type: 'fulltext_batch_screening',
        timestamp: '2026-08-01T00:00:00.000Z',
        model: 'gemini-2.5-flash',
        criteria_snapshot: null,
        screening_prompt: '',
        include_threshold: 0,
        target_count: 10,
        include_count: 0,
        exclude_count: 0,
        status: 'confirmed',
        is_active: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// deriveRounds
// ---------------------------------------------------------------------------

test('deriveRounds: fulltext フェーズの llm: 判定のみ集約する', () => {
    const decisions: Decision[] = [
        makeDecision({ decision: 'include' }),
        makeDecision({ decision: 'exclude' }),
        makeDecision({ screening_phase: 'tiab', reviewer_id: 'llm:gemini-2.5-flash@2026-08-01T00:00:00.000Z' }),
        makeDecision({ reviewer_id: 'someone@example.com' }),
    ];
    const rounds = deriveRounds(decisions);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].total, 2);
    assert.equal(rounds[0].include, 1);
    assert.equal(rounds[0].exclude, 1);
});

// ---------------------------------------------------------------------------
// mergeRoundsWithExecutions
// ---------------------------------------------------------------------------

test('mergeRoundsWithExecutions: executions側にしか無いラウンド（0件成功）が一覧へ追加される', () => {
    const rounds: AiRound[] = []; // Decisions に1行も無い＝全件失敗
    const executions: LlmExecution[] = [
        makeExecution({
            execution_id: 'llm:gemini-2.5-flash@2026-08-01T00:00:00.000Z',
            target_count: 5,
            failed_count: 5,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].total, 0);
    assert.equal(merged[0].hasExecution, true);
    assert.equal(merged[0].failedCount, 5);
    assert.equal(merged[0].targetCount, 5);
});

test('mergeRoundsWithExecutions: Decisions側にしか無いラウンド（実行履歴の書き込み失敗）も従来どおり出る', () => {
    const rounds = deriveRounds([makeDecision(), makeDecision({ decision: 'exclude' })]);
    const merged = mergeRoundsWithExecutions(rounds, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].total, 2);
    assert.equal(merged[0].hasExecution, false);
    assert.equal(merged[0].failedCount, 0);
    assert.deepEqual(merged[0].failureBreakdown, {});
    assert.equal(merged[0].targetCount, null);
    assert.equal(merged[0].executedBy, null);
    assert.equal(merged[0].executionStatus, null);
});

test('mergeRoundsWithExecutions: TiAb の batch_screening 行は混ざらない', () => {
    const rounds = deriveRounds([makeDecision()]);
    const executions: LlmExecution[] = [
        makeExecution({ execution_type: 'batch_screening', execution_id: 'llm:other-model@2026-08-02T00:00:00.000Z' }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    // batch_screening の行は executions側にしか無いラウンドとして追加されない
    assert.equal(merged.length, 1);
    assert.equal(merged[0].reviewerId, 'llm:gemini-2.5-flash@2026-08-01T00:00:00.000Z');
});

test('mergeRoundsWithExecutions: 失敗件数・内訳が正しく結合される', () => {
    const rounds = deriveRounds([makeDecision(), makeDecision({ decision: 'exclude' })]);
    const executions: LlmExecution[] = [
        makeExecution({
            failed_count: 3,
            failure_breakdown: JSON.stringify({ drive_denied: 2, llm: 1 }),
            executed_by: 'reviewer@example.com',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].failedCount, 3);
    assert.deepEqual(merged[0].failureBreakdown, { drive_denied: 2, llm: 1 });
    assert.equal(merged[0].executedBy, 'reviewer@example.com');
    assert.equal(merged[0].executionStatus, 'confirmed');
});

test('mergeRoundsWithExecutions: 成功記録があるのに Decisions に無い実行履歴は一覧に出ない（削除済みラウンド）', () => {
    // deleteFulltextAiRound は Decisions の行しか消さないため、LLM_Executions 側には
    // 「かつて成功していた」実行履歴が残り続ける。これを一覧に出すと、削除したはずの
    // ラウンドが total===0（採用・削除とも無効）のゾンビ行として復活してしまう
    const rounds: AiRound[] = []; // ユーザーが削除したので Decisions に1行も無い
    const executions: LlmExecution[] = [
        makeExecution({
            include_count: 3,
            exclude_count: 2,
            maybe_count: 1,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 0);
});

test('mergeRoundsWithExecutions: 成功記録が0の実行履歴は一覧に出る（全件失敗）', () => {
    const rounds: AiRound[] = [];
    const executions: LlmExecution[] = [
        makeExecution({
            include_count: 0,
            exclude_count: 0,
            maybe_count: 0,
            failed_count: 5,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].total, 0);
    assert.equal(merged[0].failedCount, 5);
});

test('mergeRoundsWithExecutions: 同一 execution_id の実行履歴が複数あっても重複行を出さない', () => {
    // 第1チャンクのフォールバック（開始行の保存がHTTPレベルでは失敗したが実際には書き込まれて
    // いた場合、終了時に新規行を追加作成する）で同一 execution_id の行が2行になりうるケース
    const rounds: AiRound[] = [];
    const executions: LlmExecution[] = [
        makeExecution({ status: 'pending', failed_count: undefined }), // 開始行（先に書かれた）
        makeExecution({ status: 'confirmed', failed_count: 5 }),        // 終了時のフォールバック行（後に書かれた）
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    // 後勝ち（配列で後に出てくる行を採用）: 確定済みの値を反映していること
    assert.equal(merged[0].executionStatus, 'confirmed');
    assert.equal(merged[0].failedCount, 5);
});

// ---------------------------------------------------------------------------
// processedCount / isIncomplete（PR #102 レビュー指摘: 中断実行の判別）
// ---------------------------------------------------------------------------

test('mergeRoundsWithExecutions: 完了実行（processed === target）は isIncomplete === false', () => {
    const rounds = deriveRounds([
        makeDecision({ decision: 'include' }),
        makeDecision({ decision: 'exclude' }),
    ]);
    const executions: LlmExecution[] = [
        makeExecution({
            target_count: 2,
            include_count: 1,
            exclude_count: 1,
            maybe_count: 0,
            failed_count: 0,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].processedCount, 2);
    assert.equal(merged[0].isIncomplete, false);
});

test('mergeRoundsWithExecutions: 中断実行（processed < target）は isIncomplete === true', () => {
    const rounds = deriveRounds([makeDecision({ decision: 'include' })]);
    const executions: LlmExecution[] = [
        makeExecution({
            target_count: 10,
            include_count: 1,
            exclude_count: 0,
            maybe_count: 0,
            failed_count: 1,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].processedCount, 2);
    assert.equal(merged[0].isIncomplete, true);
});

test('mergeRoundsWithExecutions: 実行履歴が無いラウンドは isIncomplete === false、processedCount は 0', () => {
    const rounds = deriveRounds([makeDecision(), makeDecision({ decision: 'exclude' })]);
    const merged = mergeRoundsWithExecutions(rounds, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].hasExecution, false);
    assert.equal(merged[0].processedCount, 0);
    assert.equal(merged[0].isIncomplete, false);
});

test('mergeRoundsWithExecutions: 全件失敗の実行（成功0・失敗N）は processedCount が失敗件数と一致する', () => {
    const rounds: AiRound[] = [];
    const executions: LlmExecution[] = [
        makeExecution({
            target_count: 5,
            include_count: 0,
            exclude_count: 0,
            maybe_count: 0,
            failed_count: 5,
            status: 'confirmed',
        }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].processedCount, 5);
    assert.equal(merged[0].isIncomplete, false); // 5/5 なので完了扱い
});

test('mergeRoundsWithExecutions: ソート順（timestamp 降順）が維持される', () => {
    const rounds: AiRound[] = [
        { reviewerId: 'llm:model-a@2026-08-01T00:00:00.000Z', model: 'model-a', timestamp: '2026-08-01T00:00:00.000Z', include: 1, exclude: 0, maybe: 0, total: 1 },
    ];
    const executions: LlmExecution[] = [
        makeExecution({ execution_id: 'llm:model-b@2026-08-03T00:00:00.000Z', model: 'model-b', timestamp: '2026-08-03T00:00:00.000Z' }),
        makeExecution({ execution_id: 'llm:model-c@2026-08-02T00:00:00.000Z', model: 'model-c', timestamp: '2026-08-02T00:00:00.000Z' }),
    ];
    const merged = mergeRoundsWithExecutions(rounds, executions);
    assert.deepEqual(merged.map(r => r.model), ['model-b', 'model-c', 'model-a']);
});
