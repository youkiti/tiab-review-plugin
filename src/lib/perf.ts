// perf.ts
// Issue #151（#150 工程0）: パフォーマンス計測基盤。performance.mark/measure の薄いラッパーを
// 提供し、開発用フラグが立っているときだけ実際に計測する。無効時は呼び出しごとに
// 「真偽値1個の判定＋関数1回の呼び出し」以上のコストをかけない（通常利用への影響をゼロにする）。
//
// 拡張版・Web版・デモ版すべてのビルドから使う共有コードのため、chrome.* API を直接参照しない
// （.eslintrc.cjs の no-restricted-globals 許可リストにこのファイルを加えていない。Web版バンドル
// にも含まれるため chrome への依存は不可）。location / performance / globalThis だけを使う。
//
// 【有効化判定】次のいずれかが真なら有効。モジュール初期化時に一度だけ判定し、以後はキャッシュ
// した真偽値を使い回す（判定自体は軽いが、計測ポイントは高頻度に呼ばれる箇所もあるため、
// 呼び出しのたびに URL パースをやり直さない）。
//   1. URL クエリ `?perf=1`（location.search）。サイドパネル / Web版のように自分でURLを
//      決められるページで有効化する（例: sidepanel.html?perf=1）。
//   2. `globalThis.__TIAB_PERF__ === true`。Playwright の `addInitScript` のように、対象ページの
//      URL を書き換えずにしか有効化フラグを渡せない場面（チャンク3のE2Eランナー）で使う。
// どちらの経路も真でない場合、および `location` / `performance` 自体が存在しない環境
// （service worker・一部のテスト実行環境）では、例外を出さず「無効」として扱う。
//
// 【detail の扱い】performance.measure() の detail には、件数など数値のメタ情報のみを渡す。
// 文献本文・メール・認証情報など機密になり得る値は絶対に渡さないこと（親issue Issue #150 の
// データ契約）。

/** globalThis.__TIAB_PERF__ 経由の有効化フラグの型（addInitScript からのみ立てられるページ用）。 */
interface PerfGlobalThis {
    __TIAB_PERF__?: boolean;
}

/**
 * 有効化判定の実体。副作用は持たない。
 * モジュール初期化時に一度だけ呼ばれ、結果を perfEnabled にキャッシュする。
 */
function computePerfEnabled(): boolean {
    try {
        // performance 自体が無い環境では計測しようがないため無効。
        if (typeof performance === 'undefined') return false;

        const queryEnabled = typeof location !== 'undefined'
            && new URLSearchParams(location.search).get('perf') === '1';
        const flagEnabled = (globalThis as typeof globalThis & PerfGlobalThis).__TIAB_PERF__ === true;

        return queryEnabled || flagEnabled;
    } catch {
        // location.search が読めない等、想定外の環境でも計測機能自体で例外を出さない。
        return false;
    }
}

let perfEnabled = computePerfEnabled();

/** 計測が有効かどうか（モジュール初期化時にキャッシュした値を返す）。 */
export function isPerfEnabled(): boolean {
    return perfEnabled;
}

/**
 * テスト専用: globalThis.__TIAB_PERF__ を書き換えた直後に呼び、isPerfEnabled() のキャッシュを
 * 再計算させる。本番コードパスからは呼ばない（「モジュール初期化時に一度だけ判定する」という
 * 設計自体は変えない。テストから有効/無効の両方を検証するための最小限の再評価口）。
 */
export function __recomputePerfEnabledForTests(): void {
    perfEnabled = computePerfEnabled();
}

function safeMark(name: string): void {
    try {
        performance.mark(name);
    } catch {
        // 計測の失敗が本体機能に影響しないよう握りつぶす。
    }
}

function safeMeasure(name: string, options: PerformanceMeasureOptions): void {
    try {
        performance.measure(name, options);
    } catch {
        // detail 付きオプション形式を受け付けない環境等でも、計測失敗が本体機能を壊さないようにする。
    }
}

/** 任意の時点にマークを打つ。 */
export function perfMark(name: string): void {
    if (!perfEnabled) return;
    safeMark(name);
}

/**
 * 非同期処理 `fn` の実時間を1本の measure にする。
 * 無効時は fn() をそのまま呼び出して返すだけで、performance.* は一切呼ばない
 * （戻り値・例外・実行順序をそのまま透過させる）。
 * 有効時は fn が reject しても finally で measure を出す（失敗した操作の時間が計測から
 * 消えないように）。
 */
export function perfSpan<T>(name: string, fn: () => Promise<T>, detail?: unknown): Promise<T> {
    if (!perfEnabled) return fn();

    const start = performance.now();
    return fn().finally(() => {
        safeMeasure(name, { start, detail });
    });
}

/** perfSpan の同期版。 */
export function perfSpanSync<T>(name: string, fn: () => T, detail?: unknown): T {
    if (!perfEnabled) return fn();

    const start = performance.now();
    try {
        return fn();
    } finally {
        safeMeasure(name, { start, detail });
    }
}

/**
 * performance.timeOrigin から呼び出し時点までの経過を1本の measure にする（起動計測用）。
 * performance.measure() の start は timeOrigin からの相対ミリ秒（または mark 名）であって
 * エポック絶対値ではないため、timeOrigin 自体からの経過を測るには start に 0 を渡す
 * （performance.timeOrigin を渡すと、エポックのミリ秒値がそのまま経過時間として解釈され、
 * duration が巨大な負値になる）。
 */
export function perfMeasureFromStart(name: string, detail?: unknown): void {
    if (!perfEnabled) return;
    safeMeasure(name, { start: 0, detail });
}

/**
 * 現在時刻を返す（起点として保持し、あとから perfMeasureFrom() へ渡すための低レベルAPI）。
 * 有効時は performance.now()、無効時は 0 を返す。無効時の戻り値は使われない前提
 * （呼び出し側は isPerfEnabled() を見ずに常に呼んでよいが、その値を計測以外の用途に使わない）。
 */
export function perfNow(): number {
    if (!perfEnabled) return 0;
    return performance.now();
}

/**
 * perfNow() で取得した start から呼び出し時点までの経過を1本の measure にする。
 * perfSpan/perfSpanSync のようにコールバックへ処理を包めない箇所（既存のループ構造を
 * 保ったまま、特定の1点でだけ計測したい場合など）向けの低レベルAPI。有効時のみ計測する。
 */
export function perfMeasureFrom(name: string, start: number, detail?: unknown): void {
    if (!perfEnabled) return;
    safeMeasure(name, { start, detail });
}
