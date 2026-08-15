// llm-processor-throttle.test.ts
// 429 適応スロットリング (RateLimitGovernor + processBatch/processWithRetry への配線) のテスト。
// 完全オフライン: fetch は一切呼ばない。時刻・sleep・乱数・LLM呼び出し (screenFn) は全て注入し、
// 実時間の待機を発生させずに「クールダウン」「並列度の増減」「累積待ち上限」を検証する。

import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitGovernor, processBatch } from '../src/lib/llm-processor';
import { GeminiApiError } from '../src/lib/gemini-api';
import type { LlmProviderId, LlmScreenParams, LlmScreenResult } from '../src/lib/llm-provider';
import type { Reference, LlmBatchProgress } from '../src/lib/types';

/** テスト用の仮想時計。now()/advance() を Governor / sleepFn へ注入する */
function createClock(start = 0) {
    let current = start;
    return {
        now: () => current,
        advance: (ms: number) => { current += ms; },
    };
}

// ===========================================================================
// RateLimitGovernor（純粋な状態機械）の単体テスト
// ===========================================================================

test('RateLimitGovernor.recordRateLimit: 並列度を半減しスロット滞在時間を倍にする', () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({
        initialConcurrency: 10,
        initialSlotDwellMs: 300,
        now: clock.now,
        random: () => 0, // ジッタなし
    });
    gov.recordRateLimit(8000);
    assert.equal(gov.concurrency, 5);
    assert.equal(gov.slotDwellMs, 600);
    assert.equal(gov.rateLimitHits, 1);
    assert.equal(gov.isThrottled, true);
});

test('RateLimitGovernor.recordRateLimit: 並列度は下限 (既定1) を割らない', () => {
    const gov = new RateLimitGovernor({ initialConcurrency: 1, initialSlotDwellMs: 13000, now: () => 0, random: () => 0 });
    gov.recordRateLimit(1000);
    assert.equal(gov.concurrency, 1); // floor(1/2)=0 -> minConcurrency(1) にクランプ
});

test('RateLimitGovernor.recordRateLimit: スロット滞在時間は上限 (既定13000ms=無料プロファイル相当) を超えない', () => {
    const gov = new RateLimitGovernor({ initialConcurrency: 2, initialSlotDwellMs: 10000, now: () => 0, random: () => 0 });
    gov.recordRateLimit(500);
    assert.equal(gov.slotDwellMs, 13000); // min(13000, 20000)
});

test('RateLimitGovernor.recordRateLimit: retryAfterMs が無ければ fallbackCooldownMs を使う', () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: clock.now, random: () => 0, fallbackCooldownMs: 4000,
    });
    gov.recordRateLimit(undefined);
    assert.equal(gov.cooldownUntil, 4000);
});

test('RateLimitGovernor.recordRateLimit: より遠いクールダウンだけを延長する（後から来た短い429で縮めない）', () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({ initialConcurrency: 10, initialSlotDwellMs: 300, now: clock.now, random: () => 0 });
    gov.recordRateLimit(59000);
    const cooldownAfterLong = gov.cooldownUntil;
    gov.recordRateLimit(1000);
    assert.equal(gov.cooldownUntil, cooldownAfterLong);
});

test('RateLimitGovernor.waitForSlot: クールダウン中は残り時間だけ注入した sleepFn を呼び、明けたら即座に返る', async () => {
    const clock = createClock();
    const waited: number[] = [];
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 0,
        now: clock.now, random: () => 0,
        sleepFn: async (ms) => { waited.push(ms); clock.advance(ms); },
    });
    gov.recordRateLimit(8000); // cooldownUntil = 8000
    await gov.waitForSlot();
    assert.deepEqual(waited, [8000]);
    // クールダウンが明けていれば sleepFn を呼ばない
    await gov.waitForSlot();
    assert.deepEqual(waited, [8000]);
});

test('RateLimitGovernor.recordSuccess: 連続成功が閾値に達するまでは回復せず、達したら1段だけ戻す', () => {
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: () => 0, random: () => 0, recoverAfterSuccesses: 3,
    });
    gov.recordRateLimit(1000); // concurrency=5, slotDwell=600
    gov.recordSuccess();
    gov.recordSuccess();
    assert.equal(gov.concurrency, 5, '2回の連続成功ではまだ回復しない');
    gov.recordSuccess(); // 3回目で1段回復
    assert.equal(gov.concurrency, 6);
    assert.equal(gov.slotDwellMs, 300);
});

test('RateLimitGovernor.recordSuccess: 既定値まで回復し、かつクールダウンが明けていれば isThrottled は false になり、以降の成功は無視する', async () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({
        initialConcurrency: 2, initialSlotDwellMs: 100,
        now: clock.now, random: () => 0, recoverAfterSuccesses: 1,
        sleepFn: async (ms) => { clock.advance(ms); },
    });
    gov.recordRateLimit(1000); // concurrency=1, slotDwell=200, cooldownUntil=1000
    await gov.waitForSlot(); // 実運用では成功の前に必ずクールダウンを消化している
    gov.recordSuccess(); // 1回で回復（recoverAfterSuccesses=1）
    assert.equal(gov.concurrency, 2);
    assert.equal(gov.slotDwellMs, 100);
    assert.equal(gov.isThrottled, false);
    gov.recordSuccess(); // 既に絞られていないので何も変化しない
    assert.equal(gov.concurrency, 2);
});

test('RateLimitGovernor.isThrottled: 既に下限/上限のプロファイル（無料枠相当）でも、クールダウン中は throttled とみなす', () => {
    const clock = createClock();
    // 無料プロファイル相当: concurrency=1（下限と同値）, slotDwell=13000（上限と同値）
    // 429 を受けても concurrency/slotDwellMs 自体は変化しないため、それだけで判定すると
    // 一番レート制限を踏みやすい設定のユーザーで「減速中」表示が永久に出ない
    const gov = new RateLimitGovernor({
        initialConcurrency: 1, initialSlotDwellMs: 13000,
        now: clock.now, random: () => 0,
    });
    assert.equal(gov.isThrottled, false, '429を受ける前は throttled ではない');
    gov.recordRateLimit(8000);
    assert.equal(gov.concurrency, 1, '下限のため concurrency 自体は変化しない');
    assert.equal(gov.slotDwellMs, 13000, '上限のため slotDwellMs 自体は変化しない');
    assert.equal(gov.isThrottled, true, 'クールダウン中は throttled とみなす');
    clock.advance(8000);
    assert.equal(gov.isThrottled, false, 'クールダウンが明ければ throttled ではなくなる');
});

test('RateLimitGovernor.recordRateLimit: retryAfterMs が巨大でも maxCooldownMs（既定60000ms）でクランプする（1(a)）', () => {
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: () => 0, random: () => 0,
    });
    gov.recordRateLimit(3600000); // RPD枯渇等で1時間分のヒントが来ても
    assert.equal(gov.cooldownUntil, 60000);
});

test('RateLimitGovernor.recordRateLimit: maxCooldownMs を明示指定すればそちらが優先される', () => {
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: () => 0, random: () => 0, maxCooldownMs: 20000,
    });
    gov.recordRateLimit(3600000);
    assert.equal(gov.cooldownUntil, 20000);
});

test('RateLimitGovernor.recordRateLimit: クールダウン中の追加429は rateLimitHits だけ増え、並列度・滞在時間は減らさない（3番: 1エピソード1減少）', () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: clock.now, random: () => 0,
    });
    gov.recordRateLimit(8000); // 1回目（新しいエピソード）: concurrency 10->5, slotDwell 300->600
    assert.equal(gov.concurrency, 5);
    assert.equal(gov.slotDwellMs, 600);
    assert.equal(gov.rateLimitHits, 1);

    gov.recordRateLimit(1000); // まだ8000msのクールダウンの途中（同じエピソード）
    assert.equal(gov.concurrency, 5, '既にクールダウン中なので減少しない');
    assert.equal(gov.slotDwellMs, 600, '既にクールダウン中なので減少しない');
    assert.equal(gov.rateLimitHits, 2, 'rateLimitHits の計上とクールダウン延長は毎回行う');

    clock.advance(8000); // クールダウンが明ける
    gov.recordRateLimit(1000); // 新しいエピソード
    assert.equal(gov.concurrency, 2, 'floor(5/2)=2');
    assert.equal(gov.slotDwellMs, 1200);
    assert.equal(gov.rateLimitHits, 3);
});

test('RateLimitGovernor.recordRateLimit: onThrottleChange をクールダウンを立てる/延長するたびに呼ぶ（5番）', () => {
    const clock = createClock();
    let calls = 0;
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 300,
        now: clock.now, random: () => 0,
        onThrottleChange: () => { calls++; },
    });
    gov.recordRateLimit(1000);
    assert.equal(calls, 1);
    gov.recordRateLimit(500); // クールダウン中の延長でも呼ばれる
    assert.equal(calls, 2);
});

test('RateLimitGovernor: maxSlotDwellMs が initialSlotDwellMs 未満のプロファイルでも、下回らないよう引き上げられる（10番）', () => {
    const gov = new RateLimitGovernor({
        initialConcurrency: 4, initialSlotDwellMs: 15000,
        maxSlotDwellMs: 13000, // 誤って initialSlotDwellMs より小さい値を渡した想定
        now: () => 0, random: () => 0,
    });
    gov.recordRateLimit(1000);
    // 引き上げられていなければ min(13000, 30000)=13000 に「速くなって」しまう（潜在バグ）
    assert.equal(gov.slotDwellMs, 15000);
});

test('RateLimitGovernor.waitForSlot: 待つ長さに jitterMs 分の乱数を乗せる。recordRateLimit 自体の絶対時刻にはジッタを乗せない（9番）', async () => {
    const clock = createClock();
    const waited: number[] = [];
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 0,
        now: clock.now, random: () => 0.4, jitterMs: 1000,
        sleepFn: async (ms) => { waited.push(ms); clock.advance(ms); },
    });
    gov.recordRateLimit(8000);
    assert.equal(gov.cooldownUntil, 8000, 'recordRateLimit 自体はジッタを乗せない絶対時刻');
    await gov.waitForSlot();
    assert.deepEqual(waited, [8400], 'waitForSlot が待つ長さは remaining(8000) + floor(0.4*1000)=400');
});

test('RateLimitGovernor.waitForSlot: 戻り値は実際に待った ms（6番: processWithRetry の cumulativeWaitMs 会計に使う）', async () => {
    const clock = createClock();
    const gov = new RateLimitGovernor({
        initialConcurrency: 10, initialSlotDwellMs: 0,
        now: clock.now, random: () => 0,
        sleepFn: async (ms) => { clock.advance(ms); },
    });
    gov.recordRateLimit(5000);
    const waited = await gov.waitForSlot();
    assert.equal(waited, 5000);
    const waitedAgain = await gov.waitForSlot();
    assert.equal(waitedAgain, 0, 'クールダウンが明けていれば 0');
});

test('RateLimitGovernor.waitForSlot: 他ワーカー(worker A)が立てたクールダウンを worker B が寝た分の ms をそのまま返す（6番・(e)の核心部分）', async () => {
    const clock = createClock();
    const waited: number[] = [];
    const gov = new RateLimitGovernor({
        initialConcurrency: 2, initialSlotDwellMs: 0,
        now: clock.now, random: () => 0,
        sleepFn: async (ms) => { waited.push(ms); clock.advance(ms); },
    });
    // worker A が 429 を受けてクールダウンを立てる（自分では待たずに次の処理へ進んだ想定）
    gov.recordRateLimit(9000);
    // worker B は自分では 429 を受けていないが、送信前に共有クールダウンを尊重して待つ
    const waitedByB = await gov.waitForSlot();
    assert.equal(waitedByB, 9000, 'worker A のクールダウン残り時間をそのまま返す');
    assert.deepEqual(waited, [9000]);
});

test('RateLimitGovernor.waitForSlot: abortSignal を渡すと、sleepFn が自然には解決しなくても即座に返る（1(b)）', async () => {
    const clock = createClock();
    let sleepCalls = 0;
    const gov = new RateLimitGovernor({
        initialConcurrency: 1, initialSlotDwellMs: 0,
        now: clock.now, random: () => 0,
        sleepFn: () => { sleepCalls++; return new Promise<void>(() => {}); }, // 自然には解決しない
    });
    gov.recordRateLimit(9000);
    const controller = new AbortController();
    const pending = gov.waitForSlot(controller.signal);
    controller.abort();
    await pending; // abort が無ければ絶対にハングするので、これが解決すること自体が検証になる
    assert.equal(sleepCalls, 1);
});

test('RateLimitGovernor.waitForSlot: sleepFn が reject すると、ハングせず例外が伝播する', async () => {
    const gov = new RateLimitGovernor({
        initialConcurrency: 1, initialSlotDwellMs: 0,
        now: () => 0, random: () => 0,
        sleepFn: () => Promise.reject(new Error('sleep failed')),
    });
    gov.recordRateLimit(9000); // cooldownUntil = 9000 なので waitForSlot は実際に sleepFn を呼ぶ
    const controller = new AbortController(); // aborted ではない signal を渡し、signal 分岐（new Promise 側）を通す
    await assert.rejects(() => gov.waitForSlot(controller.signal), /sleep failed/);
});

// ===========================================================================
// processBatch への配線確認（screenFn/now/sleepFn/random を全て注入してオフライン化）
// ===========================================================================

function makeRef(title: string): Reference {
    return { ref_id: `ref-${title}`, title, abstract: 'abstract text' };
}

function makeSuccessResult(title: string): LlmScreenResult {
    return {
        output: { include_probability: 0.5, reasons: [`reason for ${title}`], evidence: [] },
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, thoughtsTokenCount: 0, totalTokenCount: 2 },
        responseMetadata: { modelVersion: 'gemini-3.1-flash-lite-test', responseId: `resp-${title}` },
    };
}

function rateLimitedError(retryAfterMs: number): GeminiApiError {
    return new GeminiApiError('rate limited', {
        status: 429,
        code: 'api_error',
        retryable: true,
        retryAfterMs,
    });
}

function serverErrorWithRetryAfter(status: number, retryAfterMs: number): GeminiApiError {
    return new GeminiApiError('server error', {
        status,
        code: 'api_error',
        retryable: true,
        retryAfterMs,
    });
}

test('processBatch: 429 を受けると progress の rateLimitHits/currentConcurrency/throttled が更新され、リトライ後に成功として保存される（実時間は待たない）', async () => {
    const clock = createClock();
    const failedOnce = new Set<string>();
    const screenFn = async (_providerId: LlmProviderId, params: LlmScreenParams): Promise<LlmScreenResult> => {
        if (params.title === 'A' && !failedOnce.has('A')) {
            failedOnce.add('A');
            throw rateLimitedError(8000);
        }
        return makeSuccessResult(params.title);
    };

    const progressSnapshots: LlmBatchProgress[] = [];
    const wallClockStart = Date.now();

    const result = await processBatch(
        [makeRef('A'), makeRef('B'), makeRef('C')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 300 }, // concurrency=1で完全に逐次化する
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
            onProgress: (p) => progressSnapshots.push({ ...p }),
        }
    );

    const wallClockElapsedMs = Date.now() - wallClockStart;
    assert.ok(wallClockElapsedMs < 2000, `実時間の sleep が発生していないこと（実測 ${wallClockElapsedMs}ms）`);

    assert.equal(result.successCount, 3);
    assert.equal(result.fallbackCount, 0);
    assert.equal(result.failCount, 0);

    const finalProgress = progressSnapshots[progressSnapshots.length - 1];
    assert.equal(finalProgress.rateLimitHits, 1);
    assert.equal(finalProgress.throttled, true); // slotDwell が 300 -> 600 に伸びたまま
    assert.ok(progressSnapshots.some(p => p.rateLimitHits === 1), '429 検出が progress に反映される');
});

test('processBatch: concurrency=4 で1件だけ429を受けると、並列度が半減したまま (4→2) バッチが完走する', async () => {
    const clock = createClock();
    const failedOnce = new Set<string>();
    const screenFn = async (_providerId: LlmProviderId, params: LlmScreenParams): Promise<LlmScreenResult> => {
        if (params.title === 'A' && !failedOnce.has('A')) {
            failedOnce.add('A');
            throw rateLimitedError(8000);
        }
        return makeSuccessResult(params.title);
    };

    const wallClockStart = Date.now();
    const result = await processBatch(
        [makeRef('A'), makeRef('B'), makeRef('C'), makeRef('D'), makeRef('E')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 4, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
        }
    );
    const wallClockElapsedMs = Date.now() - wallClockStart;
    assert.ok(wallClockElapsedMs < 2000, `実時間の sleep が発生していないこと（実測 ${wallClockElapsedMs}ms）`);

    assert.equal(result.successCount, 5);
    assert.equal(result.fallbackCount, 0);
    // 429は1回だけ発生し、5件中これ以上の成功では回復閾値 (既定20) に届かないため 4→2 のまま
    // (この経路は同時実行数に依存しないので、5件の処理順が入れ替わっても最終状態は一定)
});

test('processBatch: 429 の累積待ちが上限 (既定3分) を超えたら、429以外より緩い最大5回リトライの途中でも安全側フォールバックへ落ちる', async () => {
    const clock = createClock();
    let callCount = 0;
    // 常に429を返す（retryAfterMs=70秒だが、maxCooldownMs=既定60秒でクランプされるため
    // 実際の待ちは1回あたり60秒。180秒の累積上限を超えるには4回目の待機予測が必要
    // （実待ち60秒×3回=180秒の時点ではまだ「超えていない」ため、4回目の呼び出しで打ち切られる）
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        throw rateLimitedError(70000);
    };

    const result = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
        }
    );

    // 累積待ち上限で打ち切られるため、既定の429リトライ上限(5回=6コール)より少ない4コールで諦める
    assert.equal(callCount, 4);
    assert.equal(result.successCount, 0);
    assert.equal(result.fallbackCount, 1);
    assert.equal(result.failCount, 0);
    assert.deepEqual(result.fallbackRefIds, ['ref-A']);

    // フォールバック保存の挙動自体（include_probability=1.0 / parse_error:true）は変更していないことを確認
    const decision = result.decisions[0];
    assert.equal(decision.decision, 'pending');
    const note = JSON.parse(decision.note ?? '{}');
    assert.equal(note.parse_error, true);
    assert.equal(note.include_probability, 1.0);
});

test('processBatch: JSONパース失敗メッセージに "429" という数字が偶然含まれていても、レート制限としては扱われない', async () => {
    // 実際に飛んでくる形（モデルの生成テキスト・抄録の抜粋がそのまま連結される）を模す:
    // - gemini-api.ts: t('error_geminiJsonParseFailed') + ': ' + fullText.substring(0, 100)
    // - providers/openrouter.ts:183: `OpenRouter: JSON パース失敗。先頭200文字=${text.slice(0, 200)}`
    // 抄録に "n = 429 patients" のような文字列が含まれるだけで誤って 429 (レート制限) と
    // 判定されると、並列度が不要に半減しクールダウンが立ってしまう（実害あり）。
    const clock = createClock();
    let callCount = 0;
    const messagesSeen: string[] = [];
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        const message = callCount % 2 === 0
            ? 'error_geminiJsonParseFailed: A cohort study of n = 429 patients with condition X, mean age 429...'
            : 'OpenRouter: JSON パース失敗。先頭200文字=Results show n=429 (95% CI ...)';
        messagesSeen.push(message);
        throw new Error(message);
    };

    const progressSnapshots: LlmBatchProgress[] = [];
    const result = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
            onProgress: (p) => progressSnapshots.push({ ...p }),
        }
    );

    // 429 (レート制限) 用のリトライ予算 (既定5回=6コール) ではなく、通常エラーの既定2回
    // (=3コール) で打ち切られることを確認する
    assert.equal(callCount, 3, `メッセージ: ${JSON.stringify(messagesSeen)}`);
    assert.equal(result.fallbackCount, 1);
    // クールダウン/並列度低下も一切発生していないこと
    assert.ok(progressSnapshots.every(p => p.rateLimitHits === 0), 'rateLimitHits が誤検知で増えていないこと');
    assert.ok(progressSnapshots.every(p => p.currentConcurrency === 1), '並列度が誤って半減していないこと');
    assert.ok(progressSnapshots.every(p => p.throttled === false), '誤って減速中扱いになっていないこと');
});

test('processBatch: 429 に限りリトライ上限が既定5回に緩和される（429以外は既定2回のまま）', async () => {
    let rateLimitedCallCount = 0;
    // retryAfterMs を小さくし、累積待ち上限には引っかからないようにする（純粋にリトライ回数上限を検証）
    const screenFnAlwaysRateLimited = async (): Promise<LlmScreenResult> => {
        rateLimitedCallCount++;
        throw rateLimitedError(100);
    };

    const clockA = createClock();
    const resultRateLimited = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn: screenFnAlwaysRateLimited,
            now: clockA.now,
            sleepFn: async (ms: number) => { clockA.advance(ms); },
            random: () => 0,
        }
    );
    // 429: 既定maxRetriesOnRateLimit=5 → 初回+5リトライ = 6コール
    assert.equal(rateLimitedCallCount, 6);
    assert.equal(resultRateLimited.fallbackCount, 1);

    let genericErrorCallCount = 0;
    const screenFnAlwaysGenericError = async (): Promise<LlmScreenResult> => {
        genericErrorCallCount++;
        throw new Error('transient failure');
    };
    const clockB = createClock();
    const resultGeneric = await processBatch(
        [makeRef('B')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn: screenFnAlwaysGenericError,
            now: clockB.now,
            sleepFn: async (ms: number) => { clockB.advance(ms); },
            random: () => 0,
        }
    );
    // 429以外: 既定maxRetries=2（従来どおり変更なし）→ 初回+2リトライ = 3コール
    assert.equal(genericErrorCallCount, 3);
    assert.equal(resultGeneric.fallbackCount, 1);
});

test('processBatch: 429を2回挟んでも、連続成功が閾値に達すると1段だけ回復する（急に戻らない）', async () => {
    const clock = createClock();
    const failedOnce = new Set<string>();
    // A と B はそれぞれの最初の呼び出しでのみ429、C・Dは常に成功
    const screenFn = async (_providerId: LlmProviderId, params: LlmScreenParams): Promise<LlmScreenResult> => {
        if ((params.title === 'A' || params.title === 'B') && !failedOnce.has(params.title)) {
            failedOnce.add(params.title);
            throw rateLimitedError(100);
        }
        return makeSuccessResult(params.title);
    };

    const progressSnapshots: LlmBatchProgress[] = [];
    const result = await processBatch(
        [makeRef('A'), makeRef('B'), makeRef('C'), makeRef('D')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            // concurrency=1: A→B→C→D の順で完全に逐次実行され、結果が決定的になる
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 300 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
            governorOptions: { recoverAfterSuccesses: 3 },
            onProgress: (p) => progressSnapshots.push({ ...p }),
        }
    );

    assert.equal(result.successCount, 4);
    assert.equal(result.fallbackCount, 0);

    // slotDwell: 300 -(A失敗)-> 600 -(B失敗)-> 1200 -(A再試行成功=1回目, C成功=2回目, D成功=3回目で回復)-> 600
    // 300 の初期値までは全回復しない（1段だけ戻す）ことを確認
    const finalProgress = progressSnapshots[progressSnapshots.length - 1];
    assert.equal(finalProgress.rateLimitHits, 2);
    assert.equal(finalProgress.throttled, true, 'まだ初期値まで回復していない');
});

// ===========================================================================
// PR #87 レビュー指摘の追加テスト（1(a)(b)(c) / 4+8 / 5 / 6 / 9 / 10）
// ===========================================================================

test('processBatch: (a) サーバが巨大な retryAfterMs（例3600000ms）を返しても、実際の待ちは既定の maxCooldownMs (60000ms) を超えない', async () => {
    const clock = createClock();
    const waitedMs: number[] = [];
    let callCount = 0;
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        if (callCount === 1) throw rateLimitedError(3600000); // RPD枯渇等で1時間分のヒントが来た想定
        return makeSuccessResult('A');
    };

    const result = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { waitedMs.push(ms); clock.advance(ms); },
            random: () => 0,
        }
    );

    assert.equal(result.successCount, 1);
    assert.ok(waitedMs.length > 0, '少なくとも1回は待っている');
    assert.ok(waitedMs.every(ms => ms <= 60000), `全ての待ちが maxCooldownMs 以下であること: ${JSON.stringify(waitedMs)}`);
    assert.ok(waitedMs.some(ms => ms > 0), 'クールダウン待ち自体は発生していること');
});

test('processBatch: (b) abortSignal による中断がクールダウン待ち中に効き、中断された文献にフォールバック判定を保存しない（1(b)(c)、2番）', async () => {
    // sleepFn は自然には解決しない「詰まった」実装にし、abort だけが待機を終わらせられることを検証する。
    // 実時間・実タイマーは一切使わない（呼ばれた時点で待機開始を検知し、その後 abort する）
    let resolveWaitingStarted: (() => void) | null = null;
    const waitingStarted = new Promise<void>((resolve) => { resolveWaitingStarted = resolve; });
    const sleepCalls: number[] = [];
    const stuckSleepFn = (ms: number): Promise<void> => {
        sleepCalls.push(ms);
        resolveWaitingStarted?.();
        return new Promise<void>(() => {}); // abort だけが待機を終わらせる
    };

    const controller = new AbortController();
    const screenFn = async (): Promise<LlmScreenResult> => {
        throw rateLimitedError(3600000); // 常に429（クランプ後も60秒相当の待ちが発生する想定）
    };

    const batchPromise = processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: () => 0, // クールダウン待ちの残りが常に一定になるよう固定する
            sleepFn: stuckSleepFn,
            random: () => 0,
            abortSignal: controller.signal,
        }
    );

    await waitingStarted; // governor.waitForSlot() 内で（クールダウン待ちに）止まるまで待つ
    assert.ok(sleepCalls.length >= 1, 'クールダウン待ちに入っていること');
    controller.abort();

    const result = await batchPromise; // abort が効かなければ永久にハングするので、これが返ること自体が検証

    assert.equal(result.decisions.length, 0, '中断された文献のフォールバック判定が保存されていない');
    assert.equal(result.successCount, 0);
    assert.equal(result.fallbackCount, 0);
    assert.equal(result.failCount, 0, 'progress.failed も加算されない（aborted は processed にも failed にも数えない）');
    assert.deepEqual(result.failedRefIds, ['ref-A'], '中断された ref は noDecisionRefIds 経由で failedRefIds に入る');
});

test('processBatch: (d) 抄録断片の "rate limiting step" / "flow rate limitation" は 429 と誤判定されないが、OpenAI の rate_limit_exceeded は 429 として検知される（4+8番）', async () => {
    // 誤検知防止: 薬理・生理の抄録に頻出する空白区切りの "rate limit..." はマッチしない
    const clockA = createClock();
    let falsePositiveCallCount = 0;
    const screenFnFalsePositive = async (): Promise<LlmScreenResult> => {
        falsePositiveCallCount++;
        const message = falsePositiveCallCount % 2 === 1
            ? 'error_geminiJsonParseFailed: ...the rate limiting step of glycolysis is catalyzed by...'
            : 'error_geminiJsonParseFailed: ...flow rate limitation was observed in the distal segment...';
        throw new Error(message);
    };
    const resultFalsePositive = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn: screenFnFalsePositive,
            now: clockA.now,
            sleepFn: async (ms: number) => { clockA.advance(ms); },
            random: () => 0,
        }
    );
    // 429用の緩いリトライ予算（既定5回=6コール）ではなく、通常エラーの既定2回（=3コール）で打ち切られる
    assert.equal(falsePositiveCallCount, 3, `誤って429として扱われていないこと`);
    assert.equal(resultFalsePositive.fallbackCount, 1);

    // 検知漏れ防止: providers/openai.ts が投げる "code=rate_limit_exceeded" は検知される
    const clockB = createClock();
    let softFailCallCount = 0;
    const screenFnOpenAiSoftFail = async (): Promise<LlmScreenResult> => {
        softFailCallCount++;
        throw new Error('OpenAI: リクエストが失敗しました (code=rate_limit_exceeded): Rate limit reached');
    };
    const resultOpenAi = await processBatch(
        [makeRef('B')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gpt-5.6-terra',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn: screenFnOpenAiSoftFail,
            now: clockB.now,
            sleepFn: async (ms: number) => { clockB.advance(ms); },
            random: () => 0,
        }
    );
    // 429として検知されるため、既定5回=6コールのリトライ予算が適用される
    assert.equal(softFailCallCount, 6, 'rate_limit_exceeded が429として検知されていること');
    assert.equal(resultOpenAi.fallbackCount, 1);
});

test('processBatch: (5番) 429を受けてクールダウンが立った瞬間（＝完了より前）に onProgress が呼ばれ、UIの無言停止を防ぐ', async () => {
    const clock = createClock();
    let callCount = 0;
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        if (callCount === 1) throw rateLimitedError(9000);
        return makeSuccessResult('A');
    };
    const progressSnapshots: LlmBatchProgress[] = [];
    await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { clock.advance(ms); },
            random: () => 0,
            onProgress: (p) => progressSnapshots.push({ ...p }),
        }
    );
    // 完了（processed=1）より前に、クールダウン検出時点の progress
    // （processed=0, rateLimitHits=1, throttled=true）が onProgress へ飛んでいること
    const preCompletionThrottleSnapshot = progressSnapshots.find(p => p.processed === 0 && p.rateLimitHits === 1);
    assert.ok(preCompletionThrottleSnapshot, `snapshots=${JSON.stringify(progressSnapshots)}`);
    assert.equal(preCompletionThrottleSnapshot!.throttled, true);
});

test('processBatch: 5xx (429以外) で retryAfterMs が指定されていれば、固定バックオフではなく retryAfterMs をそのまま使う', async () => {
    const clock = createClock();
    const waitedMs: number[] = [];
    let callCount = 0;
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        throw serverErrorWithRetryAfter(500, 2000);
    };

    const result = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { waitedMs.push(ms); clock.advance(ms); },
            random: () => 0,
        }
    );

    // 429以外の既定リトライ上限（既定2回=3コール）で打ち切られる（429の緩い予算=6コールではない）
    assert.equal(callCount, 3);
    assert.equal(result.fallbackCount, 1);
    // 固定バックオフ (5000, 10000) ではなく retryAfterMs (2000) がそのまま使われている
    assert.ok(waitedMs.some(ms => ms === 2000), `retryAfterMs がそのまま使われていること: ${JSON.stringify(waitedMs)}`);
    assert.ok(waitedMs.every(ms => ms !== 5000 && ms !== 10000), `固定バックオフが使われていないこと: ${JSON.stringify(waitedMs)}`);
});

test('processBatch: 5xx (429以外) の retryAfterMs が巨大でも、maxCooldownMs（既定60000ms）でクランプされる', async () => {
    const clock = createClock();
    const waitedMs: number[] = [];
    let callCount = 0;
    const screenFn = async (): Promise<LlmScreenResult> => {
        callCount++;
        throw serverErrorWithRetryAfter(500, 3600000); // 1時間という巨大な retryAfterMs
    };

    const result = await processBatch(
        [makeRef('A')],
        {
            batchSize: 10,
            screeningPrompt: 'prompt',
            model: 'gemini-3.1-flash-lite',
            temperature: 0,
            outputLanguage: 'ja',
            rateLimitConfig: { concurrency: 1, delayBetweenRequests: 0 },
            timestamp: new Date('2026-08-15T00:00:00Z'),
            screenFn,
            now: clock.now,
            sleepFn: async (ms: number) => { waitedMs.push(ms); clock.advance(ms); },
            random: () => 0,
        }
    );

    assert.equal(callCount, 3, '429として扱われていないこと（既定2回=3コールで打ち切られる）');
    assert.equal(result.fallbackCount, 1);
    assert.ok(waitedMs.some(ms => ms === 60000), `maxCooldownMs (60000) でクランプされていること: ${JSON.stringify(waitedMs)}`);
    assert.ok(waitedMs.every(ms => ms !== 3600000), `retryAfterMs がそのまま使われていないこと: ${JSON.stringify(waitedMs)}`);
});
