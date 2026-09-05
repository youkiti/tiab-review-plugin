import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isPerfEnabled,
    perfMark,
    perfSpan,
    perfSpanSync,
    perfMeasureFromStart,
    __recomputePerfEnabledForTests,
} from '../src/lib/perf';

// Issue #151（#150 工程0）: 計測基盤（src/lib/perf.ts）の単体テスト。
//
// isPerfEnabled() は「モジュール初期化時に一度だけ判定してキャッシュする」設計
// （呼び出し頻度の高い計測ポイントで毎回 URL パースをやり直さないため）。そのため
// テストから有効/無効を切り替えるには globalThis.__TIAB_PERF__ を書き換えたうえで
// __recomputePerfEnabledForTests()（テスト専用の再評価口）を呼ぶ。本番コードパスは
// この関数を呼ばない。

type PerfFlagValue = boolean | undefined;

function getPerfFlag(): PerfFlagValue {
    return (globalThis as { __TIAB_PERF__?: boolean }).__TIAB_PERF__;
}

function setPerfFlag(value: PerfFlagValue): void {
    (globalThis as { __TIAB_PERF__?: boolean }).__TIAB_PERF__ = value;
    __recomputePerfEnabledForTests();
}

// 各テストの前後で必ずフラグを元に戻す（他のテスト・他のテストファイルへ状態を漏らさないため）。
const originalPerfFlag = getPerfFlag();
test.afterEach(() => {
    setPerfFlag(originalPerfFlag);
});

/** performance.measure をスパイに差し替える。restore() で必ず元へ戻すこと。 */
function spyOnMeasure(): {
    calls: { name: string; options: PerformanceMeasureOptions }[];
    restore: () => void;
} {
    const calls: { name: string; options: PerformanceMeasureOptions }[] = [];
    const original = performance.measure.bind(performance);
    (performance as unknown as { measure: unknown }).measure = (
        name: string,
        options?: PerformanceMeasureOptions
    ) => {
        calls.push({ name, options: options ?? {} });
        return original(name, options);
    };
    return {
        calls,
        restore: () => {
            (performance as unknown as { measure: unknown }).measure = original;
        },
    };
}

/** performance.mark をスパイに差し替える。restore() で必ず元へ戻すこと。 */
function spyOnMark(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const original = performance.mark.bind(performance);
    (performance as unknown as { mark: unknown }).mark = (name: string) => {
        calls.push(name);
        return original(name);
    };
    return {
        calls,
        restore: () => {
            (performance as unknown as { mark: unknown }).mark = original;
        },
    };
}

test('isPerfEnabled: __recomputePerfEnabledForTests() でフラグの反映を再計算できる', () => {
    setPerfFlag(true);
    assert.equal(isPerfEnabled(), true);

    setPerfFlag(false);
    assert.equal(isPerfEnabled(), false);

    setPerfFlag(undefined);
    assert.equal(isPerfEnabled(), false);
});

test('無効時: perfSpan は fn() の戻り値をそのまま返し、performance.measure を一度も呼ばない', async () => {
    setPerfFlag(false);
    const spy = spyOnMeasure();
    try {
        const result = await perfSpan('tiab:test.disabledSpan', async () => 42);
        assert.equal(result, 42);
        assert.equal(spy.calls.length, 0);
    } finally {
        spy.restore();
    }
});

test('無効時: perfSpanSync は fn() の戻り値をそのまま返し、performance.measure を一度も呼ばない', () => {
    setPerfFlag(false);
    const spy = spyOnMeasure();
    try {
        const result = perfSpanSync('tiab:test.disabledSpanSync', () => 'ok');
        assert.equal(result, 'ok');
        assert.equal(spy.calls.length, 0);
    } finally {
        spy.restore();
    }
});

test('無効時: perfMark / perfMeasureFromStart も performance.* を呼ばない', () => {
    setPerfFlag(false);
    const markSpy = spyOnMark();
    const measureSpy = spyOnMeasure();
    try {
        perfMark('tiab:test.disabledMark');
        perfMeasureFromStart('tiab:test.disabledFromStart');
        assert.equal(markSpy.calls.length, 0);
        assert.equal(measureSpy.calls.length, 0);
    } finally {
        markSpy.restore();
        measureSpy.restore();
    }
});

test('有効時（globalThis.__TIAB_PERF__ 経路）: perfSpan は指定名の measure を1本出し、detail も渡る', async () => {
    setPerfFlag(true);
    const spy = spyOnMeasure();
    try {
        const result = await perfSpan('tiab:test.enabledSpan', async () => 'value', { count: 3 });
        assert.equal(result, 'value');
        assert.equal(spy.calls.length, 1);
        assert.equal(spy.calls[0].name, 'tiab:test.enabledSpan');
        assert.deepEqual(spy.calls[0].options.detail, { count: 3 });
        assert.equal(typeof spy.calls[0].options.start, 'number');
    } finally {
        spy.restore();
    }
});

test('有効時: perfSpanSync は指定名の measure を1本出す', () => {
    setPerfFlag(true);
    const spy = spyOnMeasure();
    try {
        const result = perfSpanSync('tiab:test.enabledSpanSync', () => 'sync-value');
        assert.equal(result, 'sync-value');
        assert.equal(spy.calls.length, 1);
        assert.equal(spy.calls[0].name, 'tiab:test.enabledSpanSync');
    } finally {
        spy.restore();
    }
});

test('有効時: perfMark / perfMeasureFromStart はそれぞれ performance.mark / measure を1回呼ぶ', () => {
    setPerfFlag(true);
    const markSpy = spyOnMark();
    const measureSpy = spyOnMeasure();
    try {
        perfMark('tiab:test.enabledMark');
        assert.deepEqual(markSpy.calls, ['tiab:test.enabledMark']);

        perfMeasureFromStart('tiab:test.enabledFromStart', { pages: 5 });
        assert.equal(measureSpy.calls.length, 1);
        assert.equal(measureSpy.calls[0].name, 'tiab:test.enabledFromStart');
        assert.deepEqual(measureSpy.calls[0].options.detail, { pages: 5 });
        // performance.measure() の start は timeOrigin からの相対ミリ秒であって、エポック絶対値
        // ではない。timeOrigin 自体からの経過を測るには 0 を渡す（timeOrigin を渡すと、エポック
        // 値がそのまま経過時間として解釈され、duration が巨大な負値になるバグがあった）。
        assert.equal(measureSpy.calls[0].options.start, 0);
    } finally {
        markSpy.restore();
        measureSpy.restore();
    }
});

test('perfMeasureFromStart: 実測エントリの duration が 0 以上で、呼び出し時点の performance.now() を超えない（tiab:boot 相当の妥当性検証）', () => {
    // スパイで名前・引数の突き合わせだけを見るテストでは、start に timeOrigin を渡す取り違え
    // （duration が巨大な負値になるバグ）を検出できなかった。実際の PerformanceMeasure エントリの
    // duration 値を見て、時間として妥当な範囲に収まっていることを検証する。
    setPerfFlag(true);
    const name = 'tiab:test.durationSanity';
    performance.clearMeasures(name);
    try {
        const before = performance.now();
        perfMeasureFromStart(name);
        const after = performance.now();

        const entries = performance.getEntriesByName(name, 'measure');
        assert.equal(entries.length, 1);
        const duration = entries[0].duration;

        assert.ok(duration >= 0, `duration が負値: ${duration}`);
        assert.ok(
            duration <= after,
            `duration (${duration}) が呼び出し時点の performance.now() (${after}, 開始時は ${before}) を超えている`
        );
    } finally {
        performance.clearMeasures(name);
    }
});

test('perfSpan が reject したとき、例外がそのまま呼び出し元へ伝わり、かつ measure が出る', async () => {
    setPerfFlag(true);
    const spy = spyOnMeasure();
    const boom = new Error('boom');
    try {
        await assert.rejects(
            perfSpan('tiab:test.rejectedSpan', async () => { throw boom; }),
            boom
        );
        assert.equal(spy.calls.length, 1);
        assert.equal(spy.calls[0].name, 'tiab:test.rejectedSpan');
    } finally {
        spy.restore();
    }
});

test('perfSpanSync が例外を投げたとき、例外がそのまま呼び出し元へ伝わり、かつ measure が出る', () => {
    setPerfFlag(true);
    const spy = spyOnMeasure();
    const boom = new Error('boom-sync');
    try {
        assert.throws(() => perfSpanSync('tiab:test.thrownSpanSync', () => { throw boom; }), boom);
        assert.equal(spy.calls.length, 1);
        assert.equal(spy.calls[0].name, 'tiab:test.thrownSpanSync');
    } finally {
        spy.restore();
    }
});

test('performance.measure が例外を投げる環境でも、perfSpan は本体の戻り値をそのまま返す', async () => {
    setPerfFlag(true);
    const original = performance.measure.bind(performance);
    (performance as unknown as { measure: unknown }).measure = () => {
        throw new Error('この環境の performance.measure は detail 付きオプションを受け付けない');
    };
    try {
        const result = await perfSpan('tiab:test.measureThrows', async () => 'still-works');
        assert.equal(result, 'still-works');
    } finally {
        (performance as unknown as { measure: unknown }).measure = original;
    }
});

test('performance.measure が例外を投げる環境でも、perfSpanSync は本体の戻り値をそのまま返す', () => {
    setPerfFlag(true);
    const original = performance.measure.bind(performance);
    (performance as unknown as { measure: unknown }).measure = () => {
        throw new Error('この環境の performance.measure は detail 付きオプションを受け付けない');
    };
    try {
        const result = perfSpanSync('tiab:test.measureThrowsSync', () => 'still-works-sync');
        assert.equal(result, 'still-works-sync');
    } finally {
        (performance as unknown as { measure: unknown }).measure = original;
    }
});
