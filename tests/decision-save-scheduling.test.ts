import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDecision, invalidateDecisionRowCache } from '../src/lib/sheets-api';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import type { Decision } from '../src/lib/types';

// Issue #154（#150 工程3）: saveDecision() のスケジューリングをキー単位の直列化に変える。
//
// 従来はモジュールスコープの Promise チェーン1本で全ての判定保存を直列化していたため、
// 異なる文献（別キー）への保存同士まで待ち合ってしまっていた。追記専用経路
// （human判定 / ML手動確認判定）は getDecisions() を一切呼ばないため、他キーを巻き添えに
// するキャッシュ丸ごと差し替え（primeDecisionRowCache）が起きない。キャッシュへの書き込み
// （rememberDecisionContent）は自キーへの上書きに加えキャッシュ未構築時/別スプレッドシート時は
// オブジェクトごと作り直すこともあるが、JSはシングルスレッドでその中身は同期実行されるため
// 別キーの追記が同時に走ってもエントリが失われる経路は無く安全（詳細は decisions.ts の
// scheduleKeyedSave 直上のコメント参照）。よってキー単位の直列化で「同一キーの並行保存が
// 重複行を作る」バグを防ぎつつ、別キー同士は並行させてよい。一方 upsert経路（ML自動判定・
// LLM判定）は cold時に getDecisions() → primeDecisionRowCache() でキャッシュを丸ごと
// 差し替えるため、全キーをまたぐグローバル直列のままにする（decisions.ts の
// scheduleGlobalSave 参照）。
//
// fetch モックの方式は tests/decision-row-cache.test.ts を踏襲しつつ、ここでは
// 「リクエストが実際に発火したタイミング」そのものを検証したいため、fetch の解決を
// テスト側が任意のタイミングで手動制御できる「ゲート付きモック」を使う。

const mockPlatform: PlatformAdapter = {
    getAuthToken: async () => 'test-token',
    forceReauth: async () => 'test-token',
    clearAuth: async () => {},
    storageGet: async () => ({}),
    storageSet: async () => {},
    storageRemove: async () => {},
    storageClear: async () => {},
    onMessage: () => {},
    emitMessage: () => {},
    getMessage: (key: string) => key,
    openExternal: () => {},
    getVersionString: () => 'test',
    capabilities: { llm: true, ml: true, fulltext: true, importExport: true, createProject: true },
};
setPlatform(mockPlatform);

const spreadsheetId = 'sheet-1';

const DECISIONS_HEADER = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
    'context_json',
];

function makeDecision(overrides: Partial<Decision>): Decision {
    return {
        decision_id: 'd1',
        ref_id: 'ref1',
        reviewer_id: 'alice@example.com',
        decision: 'include',
        decided_at: '2026-01-01T00:00:00Z',
        client_version: '0.33.2-human',
        screening_phase: 'tiab',
        ...overrides,
    };
}

interface GatedCall {
    method: string;
    url: string;
    resolve: (response: Response) => void;
    reject: (reason: unknown) => void;
}

const originalFetch = globalThis.fetch;

/**
 * fetch をゲート付きモックへ差し替える。各リクエストは即座には解決/拒否されず、
 * calls 配列に積まれるだけになる。テスト側が resolveAppend/resolveGet/reject 等で
 * 明示的に解決するまで、そのリクエストを起点とした後続の await は先へ進まない。
 */
function installGatedFetch(): { calls: GatedCall[] } {
    const calls: GatedCall[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = (init?.method || 'GET').toUpperCase();
        return new Promise<Response>((resolve, reject) => {
            calls.push({ method, url, resolve, reject });
        });
    }) as typeof fetch;
    return { calls };
}

/** appendRows 成功レスポンスを作る */
function appendOkResponse(firstRowIndex: number): Response {
    return new Response(JSON.stringify({
        updates: { updatedRange: `Decisions!A${firstRowIndex}:L${firstRowIndex}` },
    }), { status: 200 });
}

/** updateRange 成功レスポンスを作る */
function updateOkResponse(): Response {
    return new Response(JSON.stringify({}), { status: 200 });
}

/** Decisions!A:L 全件読み取りの成功レスポンスを作る（データ行なし） */
function getEmptyDecisionsResponse(): Response {
    return new Response(JSON.stringify({ values: [DECISIONS_HEADER] }), { status: 200 });
}

// response.json() の内部実装（undici の ReadableStream読み取り）はマイクロタスクだけでなく
// マクロタスクも挟むため、単純な Promise.resolve() の連打だけでは全ての継続が進み切らないことがある。
// setTimeout(0) でマクロタスクキューも回しつつ、十分な回数だけイベントループを回す。
async function flushMicrotasks(times = 30): Promise<void> {
    for (let i = 0; i < times; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateDecisionRowCache();
});

test('同一キーへの並行保存は直列化される（後続のリクエストは先行が解決するまで飛ばない）', async () => {
    const { calls } = installGatedFetch();

    const d1 = makeDecision({ decision_id: 'd1', note: 'first' });
    const d2 = makeDecision({ decision_id: 'd2', note: 'second', decided_at: '2026-01-01T00:00:01Z' });

    const p1 = saveDecision(spreadsheetId, d1);
    const p2 = saveDecision(spreadsheetId, d2);

    await flushMicrotasks();
    assert.equal(calls.length, 1, '同一キーの2件目は1件目が解決するまでリクエストを発行しない');
    assert.equal(calls[0].method, 'POST');

    calls[0].resolve(appendOkResponse(2));
    await p1;

    await flushMicrotasks();
    assert.equal(calls.length, 2, '1件目が解決したら2件目のリクエストが発行される');
    calls[1].resolve(appendOkResponse(3));
    await p2;
});

test('異なるキーへの追記専用保存は並行して走る', async () => {
    const { calls } = installGatedFetch();

    const d1 = makeDecision({ decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com' });
    const d2 = makeDecision({ decision_id: 'd2', ref_id: 'ref2', reviewer_id: 'bob@example.com' });

    const p1 = saveDecision(spreadsheetId, d1);
    const p2 = saveDecision(spreadsheetId, d2);

    await flushMicrotasks();
    // 実装を旧来のグローバル1本チェーンへ戻すと、ここで calls.length は 1 のままになり失敗する。
    assert.equal(calls.length, 2, '別キー同士は互いを待たずに両方のリクエストが飛んでいること');

    calls[0].resolve(appendOkResponse(2));
    calls[1].resolve(appendOkResponse(3));
    await Promise.all([p1, p2]);
});

test('upsert経路（LLM判定）は先行する全ての保存の完了を待ち、後続の追記専用保存はupsertの完了を待つ', async () => {
    const { calls } = installGatedFetch();

    // 1) 追記専用の保存（ref1, human）を走らせたまま止める
    const humanFirst = makeDecision({ decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com' });
    const pHumanFirst = saveDecision(spreadsheetId, humanFirst);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'human判定のappendが1件飛んでいること');

    // 2) LLM判定（ref2, upsert経路）を呼ぶ。ref1のappendが解決するまでリクエストは飛ばない。
    const llmDecision = makeDecision({
        decision_id: 'd2', ref_id: 'ref2', reviewer_id: 'llm:gpt', client_version: '0.33.2-llm',
    });
    const pLlm = saveDecision(spreadsheetId, llmDecision);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'LLM側は先行するhuman保存が解決するまでリクエストを発行しない');

    // 3) その後にスケジュールした追記専用保存（ref3, human）。LLM側の完了を待つはず。
    const humanAfterLlm = makeDecision({ decision_id: 'd3', ref_id: 'ref3', reviewer_id: 'carol@example.com' });
    const pHumanAfter = saveDecision(spreadsheetId, humanAfterLlm);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'LLM後にスケジュールしたappendはLLMの完了を待つのでまだ飛ばない');

    // 4) ref1のappendを解決 → LLM側のcold読み取り（GET）が発火するはず
    calls[0].resolve(appendOkResponse(2));
    await pHumanFirst;
    await flushMicrotasks();
    assert.equal(calls.length, 2, 'human保存の完了を受けてLLM側のGETが発行される（＝ref3側はまだ発行されていない）');
    assert.equal(calls[1].method, 'GET');

    // 5) GETを解決（既存行なし）→ LLM側のappendが発火する
    calls[1].resolve(getEmptyDecisionsResponse());
    await flushMicrotasks();
    assert.equal(calls.length, 3, 'GET解決後、LLM判定のappendが発行される（＝ref3側はまだ発行されていない）');
    assert.equal(calls[2].method, 'POST');

    // 6) LLMのappendを解決 → LLM保存が完了し、ref3のappendがようやく発行される
    calls[2].resolve(appendOkResponse(2));
    await pLlm;
    await flushMicrotasks();
    assert.equal(calls.length, 4, 'LLM保存の完了を受けてref3のappendが発行される');
    assert.equal(calls[3].method, 'POST');

    calls[3].resolve(appendOkResponse(3));
    await pHumanAfter;
});

test('scheduleGlobalSave の saveChainsByKey.clear() が無いと、既にキー別チェーンを持つキーへの後続保存がグローバル保存を追い越してしまう（回帰）', async () => {
    const { calls } = installGatedFetch();

    // 1) ref1へのhuman保存その1をスケジュール
    const humanFirst = makeDecision({
        decision_id: 'd1', ref_id: 'ref1', reviewer_id: 'alice@example.com', note: 'first',
    });
    const pHumanFirst = saveDecision(spreadsheetId, humanFirst);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'ref1その1のappendが1件飛んでいること');

    // 2) LLM判定（upsert経路）をスケジュール。ref1その1がまだ未決着なのでリクエストは飛ばない。
    //    scheduleGlobalSave() はこの時点の saveChainsByKey（ref1 -> 未決着のtail）を
    //    pending に取り込んだ上で、saveChainsByKey を clear する。
    const llmDecision = makeDecision({
        decision_id: 'd2', ref_id: 'ref2', reviewer_id: 'llm:gpt', client_version: '0.33.2-llm',
    });
    const pLlm = saveDecision(spreadsheetId, llmDecision);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'LLM側はref1その1が解決するまでリクエストを発行しない');

    // 3) 同じキー（ref1 / 同一reviewer_id / 同一screening_phase）への2件目のhuman保存。
    //    clear() が正しく効いていれば saveChainsByKey は空なので、prev は
    //    globalSaveChain（＝直前にスケジュールしたLLM保存のtail）になる。
    //    note を変えて、直前保存との内容一致による重複スキップに引っかからないようにする。
    const humanSecond = makeDecision({
        decision_id: 'd3', ref_id: 'ref1', reviewer_id: 'alice@example.com', note: 'second',
        decided_at: '2026-01-01T00:00:01Z',
    });
    const pHumanSecond = saveDecision(spreadsheetId, humanSecond);
    await flushMicrotasks();
    assert.equal(calls.length, 1, 'ref1その2はこの時点ではまだ発行されない（スケジュールされただけ）');

    // 4) ref1その1のappendを解決 → LLM保存が pending 待ちから解放されGETが発火する。
    calls[0].resolve(appendOkResponse(2));
    await pHumanFirst;
    await flushMicrotasks();

    // 5) clear() が効いていれば、ここで飛ぶのはLLM側のGETだけ（ref1その2はLLM保存の完了を
    //    待つのでまだ飛ばない）。clear() を消すと、ref1その2の prev が
    //    saveChainsByKey.get('ref1...')（＝ref1その1のtail、手順4で決着済み）のままになり、
    //    ref1その2がLLM保存を追い越してここで3件目として飛んでしまう。
    assert.equal(calls.length, 2, 'ref1その2はLLM保存の完了を待つのでまだ発行されない（＝clear()の正しさの回帰テスト）');
    assert.equal(calls[1].method, 'GET');

    // 後片付け: 残りを全部解決してこのテストを終わらせる（未解決チェーンを次のテストへ漏らさない）
    calls[1].resolve(getEmptyDecisionsResponse());
    await flushMicrotasks();
    assert.equal(calls.length, 3, 'GET解決後、LLM判定のappendが発行される');
    assert.equal(calls[2].method, 'POST');

    calls[2].resolve(appendOkResponse(3));
    await pLlm;
    await flushMicrotasks();
    assert.equal(calls.length, 4, 'LLM保存の完了を受けてref1その2のappendがようやく発行される');
    assert.equal(calls[3].method, 'POST');

    calls[3].resolve(appendOkResponse(4));
    await pHumanSecond;
});

test('前段の保存が失敗しても、同一キーの後続保存は止まらない', async () => {
    const { calls } = installGatedFetch();

    const d1 = makeDecision({ decision_id: 'd1', note: 'will fail' });
    const d2 = makeDecision({ decision_id: 'd2', note: 'should still succeed', decided_at: '2026-01-01T00:00:01Z' });

    const p1 = saveDecision(spreadsheetId, d1);
    const p2 = saveDecision(spreadsheetId, d2);

    await flushMicrotasks();
    assert.equal(calls.length, 1);
    calls[0].reject(new Error('network error'));

    await assert.rejects(p1, /network error/);
    await flushMicrotasks();

    assert.equal(calls.length, 2, '1件目の失敗後も2件目のリクエストが発行されること');
    calls[1].resolve(appendOkResponse(2));
    await assert.doesNotReject(p2);
});
