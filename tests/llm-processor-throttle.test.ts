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
    // 常に429を返す（retryAfterMs=70秒。3回目の待機で累積 210秒 > 180秒の上限を超える）
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

    // 累積待ち上限で打ち切られるため、既定の429リトライ上限(5回=6コール)より少ない3コールで諦める
    assert.equal(callCount, 3);
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
