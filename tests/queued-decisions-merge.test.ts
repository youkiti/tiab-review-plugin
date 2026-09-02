import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueuedDecisions } from '../src/lib/queued-decisions-merge';
import type { Decision, ReferenceWithStatus } from '../src/lib/types';

// mergeQueuedDecisions のユニットテスト。
// 2026-09 Web版ログイン切れによるキュー滞留・重複追記の事故対応の一環で追加。
// allDecisions のマージは keyOpened===true のときだけ行う
// （getReferencesWithStatus は Blind 中でも allDecisions に LLM 判定だけの配列を入れて返すため、
// keyOpened===false のときに無条件で自分の human 判定を差し込むと Blind 中の
// AI Evidenceハイライトに人間の判定が混入してしまう）。

function makeRef(overrides: Partial<ReferenceWithStatus> = {}): ReferenceWithStatus {
    return {
        ref_id: 'ref-1',
        title: 'title',
        status: 'pending',
        ...overrides,
    };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
    return {
        decision_id: 'd-1',
        ref_id: 'ref-1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-09-02T00:00:00Z',
        ...overrides,
    };
}

test('myDecision が無い ref はキューの判定で埋まる', () => {
    const ref = makeRef();
    const queued = [makeDecision()];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.notEqual(result, ref, '更新対象は新しいオブジェクトを返す');
    assert.equal(result.myDecision?.decision_id, 'd-1');
    assert.equal(result.status, 'include');
    // 入力を破壊しない
    assert.equal(ref.myDecision, undefined);
});

test('キューの decided_at が myDecision より古い場合は差し替えない', () => {
    const ref = makeRef({
        myDecision: makeDecision({ decision_id: 'server-1', decided_at: '2026-09-02T12:00:00Z', decision: 'exclude' }),
        status: 'exclude',
    });
    const queued = [makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z', decision: 'include' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result, ref, '対象外のrefは同一参照のまま');
    assert.equal(result.myDecision?.decision_id, 'server-1');
});

test('同じ decided_at（新しくない）は差し替えない', () => {
    const ref = makeRef({
        myDecision: makeDecision({ decision_id: 'server-1', decided_at: '2026-09-02T00:00:00Z' }),
    });
    const queued = [makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result.myDecision?.decision_id, 'server-1');
});

test('キューの decided_at が myDecision より新しい場合は差し替える', () => {
    const ref = makeRef({
        myDecision: makeDecision({ decision_id: 'server-1', decided_at: '2026-09-01T00:00:00Z', decision: 'exclude' }),
        status: 'exclude',
    });
    const queued = [makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z', decision: 'include' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result.myDecision?.decision_id, 'queued-1');
    assert.equal(result.status, 'include');
});

test('decision=pending（メモのみ保存）のキュー項目は status を pending のまま保つ', () => {
    const ref = makeRef();
    const queued = [makeDecision({ decision: 'pending', note: 'memo only' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result.myDecision?.note, 'memo only');
    assert.equal(result.status, 'pending');
});

test('hasConflict===true の ref は status を維持し myDecision だけ更新する', () => {
    const ref = makeRef({
        hasConflict: true,
        status: 'conflict',
        myDecision: makeDecision({ decision_id: 'server-1', decided_at: '2026-09-01T00:00:00Z' }),
    });
    const queued = [makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z', decision: 'exclude' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result.status, 'conflict');
    assert.equal(result.myDecision?.decision_id, 'queued-1');
});

test('keyOpened===true かつ allDecisions が配列のとき、同じ reviewer_id の要素を差し替える', () => {
    const existing = makeDecision({ decision_id: 'server-1', decided_at: '2026-09-01T00:00:00Z', decision: 'exclude' });
    const other = makeDecision({ decision_id: 'server-2', reviewer_id: 'bob@example.com', decided_at: '2026-09-01T00:00:00Z' });
    const ref = makeRef({
        allDecisions: [existing, other],
        myDecision: existing,
    });
    const queuedDecision = makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z', decision: 'include' });
    const [result] = mergeQueuedDecisions([ref], [queuedDecision], true);

    assert.equal(result.allDecisions?.length, 2);
    assert.deepEqual(
        result.allDecisions?.find((d) => d.reviewer_id === 'alice@example.com'),
        queuedDecision
    );
    assert.deepEqual(result.allDecisions?.find((d) => d.reviewer_id === 'bob@example.com'), other);
    // 元の配列は破壊しない
    assert.equal(ref.allDecisions?.[0], existing);
});

test('keyOpened===true かつ allDecisions が配列で、自分の reviewer_id の要素が無い場合は push する', () => {
    const other = makeDecision({ decision_id: 'server-2', reviewer_id: 'bob@example.com', decided_at: '2026-09-01T00:00:00Z' });
    const ref = makeRef({ allDecisions: [other] });
    const queuedDecision = makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z' });
    const [result] = mergeQueuedDecisions([ref], [queuedDecision], true);

    assert.equal(result.allDecisions?.length, 2);
    assert.deepEqual(result.allDecisions?.[1], queuedDecision);
});

test('keyOpened===false（Blind中）のときは allDecisions に LLM 判定が入っていても書き換えない', () => {
    const llmDecision = makeDecision({
        decision_id: 'llm-1',
        reviewer_id: 'llm:gemini@2026-01-01T00-00-00Z',
        decided_at: '2026-09-01T00:00:00Z',
    });
    const ref = makeRef({ allDecisions: [llmDecision] });
    const queuedDecision = makeDecision({ decision_id: 'queued-1', decided_at: '2026-09-02T00:00:00Z', decision: 'exclude' });
    const [result] = mergeQueuedDecisions([ref], [queuedDecision], false);

    // myDecision / status は keyOpened に関係なく更新される
    assert.equal(result.myDecision?.decision_id, 'queued-1');
    assert.equal(result.status, 'exclude');
    // allDecisions（Blind中はLLM票のみの一覧）には手を触れない
    assert.equal(result.allDecisions, ref.allDecisions);
    assert.deepEqual(result.allDecisions, [llmDecision]);
});

test('allDecisions が配列でない ref は allDecisions キーを付与しない', () => {
    const ref = makeRef();
    assert.equal('allDecisions' in ref, false);
    const [result] = mergeQueuedDecisions([ref], [makeDecision()], true);

    assert.equal('allDecisions' in result, false);
});

test('screening_phase=fulltext のキュー項目は無視される', () => {
    const ref = makeRef();
    const queued = [makeDecision({ screening_phase: 'fulltext' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result, ref);
    assert.equal(result.myDecision, undefined);
});

test('同じ ref_id のキュー項目が複数あれば decided_at が最新の1件だけを使う', () => {
    const ref = makeRef();
    const older = makeDecision({ decision_id: 'q-old', decided_at: '2026-09-01T00:00:00Z', decision: 'exclude' });
    const newer = makeDecision({ decision_id: 'q-new', decided_at: '2026-09-02T00:00:00Z', decision: 'include' });
    const [result] = mergeQueuedDecisions([ref], [older, newer], true);

    assert.equal(result.myDecision?.decision_id, 'q-new');
    assert.equal(result.status, 'include');
});

test('対象外の ref（該当するキュー項目が無い）はそのまま返る', () => {
    const ref = makeRef({ ref_id: 'ref-2' });
    const queued = [makeDecision({ ref_id: 'ref-1' })];
    const [result] = mergeQueuedDecisions([ref], queued, true);

    assert.equal(result, ref);
});

test('queued が空配列なら入力をそのまま返す', () => {
    const refs = [makeRef()];
    const result = mergeQueuedDecisions(refs, [], true);

    assert.equal(result, refs);
});
