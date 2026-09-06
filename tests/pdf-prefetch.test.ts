// pdf-prefetch.test.ts
// Issue #156（#150 工程5）PR3: PDF先読みキャッシュの単体テスト。
// 完全オフライン: fetch は全てスタブし、実ネットワークには一切触れない。
//
// 検証する観点（AGENTS.md「テスト・作業ツリーの落とし穴」の教訓どおり、取り出し側の
// 共通ヘルパー getPdfPrefetch() 自体をテストすることで、showCachedPdf() /
// showRegistrySnapshot() の2箇所の重複していた判断ロジックを一本化できていることを担保する）:
//   1. ファイルID不一致でミスになり、古いエントリが中止・破棄されること
//   2. 保持バイト数の上限を超えたら古いエントリから追い出されること
//   3. 同時進行リクエスト数の勘定から現在地自身を除くこと（速い連続移動での回帰防止）、
//      および fileId が一致する隣接候補は再ダウンロードせずエントリを維持すること
//      （同時実行数の上限そのものが実際に新規開始を拒否する場面は、唯一の呼び出し経路
//      からは構造的に発火しない。理由は src/fulltext/pdf-prefetch.ts の
//      prefetchNeighbors() のdocstring参照。ここでは検証していない）
//   4. keep集合から外れたエントリの abort() が実際に呼ばれる（進行中のfetchへ signal で伝播する）こと
//   5. downloadDriveFile() の abort は DriveTransientError に化けない（型付きエラー契約の例外）こと

import test from 'node:test';
import assert from 'node:assert/strict';
import { setPlatform } from '../src/platform';
import type { PlatformAdapter } from '../src/platform/types';
import { DriveTransientError, downloadDriveFile } from '../src/lib/drive-api';
import { session } from '../src/fulltext/session';
import {
    prefetchNeighbors,
    getPdfPrefetch,
    discardPdfPrefetchEntry,
    clearPdfPrefetch,
    MAX_PDF_PREFETCH_TOTAL_BYTES,
    MAX_PDF_PREFETCH_CONCURRENCY,
} from '../src/fulltext/pdf-prefetch';
import type { Reference } from '../src/lib/types';

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

const originalFetch = globalThis.fetch;
test.afterEach(() => {
    globalThis.fetch = originalFetch;
    // session はモジュール全体で共有するシングルトンなので、テスト間で必ずリセットする。
    session.currentRef = null;
    session.currentCandidateIndex = -1;
    session.fulltextCandidates = [];
    session.pdfPrefetch = new Map();
});

/** Drive の cached URL（extractDriveFileId が拾える形）を組み立てる */
function driveUrl(fileId: string): string {
    return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * downloadDriveFile() は getAuthToken() の await を挟んでから実際に fetch() を呼ぶため、
 * prefetchNeighbors() を呼んだ直後（同期処理の続き）ではまだ実 fetch 呼び出しに到達していない。
 * setTimeout(0) のマクロタスクまで待てば、途中に何回 await を挟んでいても、そこまでに
 * キューされた全マイクロタスクは処理し終えている（＝実 fetch 呼び出しに到達している）ため、
 * これを挟んでから stub.resolveByUrlIncluding() を呼ぶ。
 */
function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** 先読み対象になれる最小限の cached Reference */
function cachedRef(refId: string, fileId: string): Reference {
    return { ref_id: refId, title: refId, fulltext_status: 'cached', fulltext_url: driveUrl(fileId) };
}

/**
 * 呼ばれた (url, init) を記録しつつ、任意タイミングで解決できる保留中の fetch をスタブする。
 * init.signal を渡していれば abort イベントを実際に監視し、abort されたら実 fetch と同じく
 * AbortError（DOMException）で reject する。
 */
function stubControllableFetch() {
    const pendings: Array<{
        url: string;
        resolve: (body: string) => void;
        signal?: AbortSignal;
    }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal ?? undefined;
            if (signal) {
                if (signal.aborted) {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                    return;
                }
                signal.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                });
            }
            pendings.push({
                url,
                resolve: (body: string) => resolve(new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'application/pdf' },
                })),
                signal,
            });
        });
    }) as typeof fetch;
    return {
        pendings,
        /** URLに指定バイト数の"PDF"本文で応答を解決する（先頭は%PDFのままでも構わない） */
        resolveByUrlIncluding(needle: string, byteLength: number): void {
            const idx = pendings.findIndex(p => p.url.includes(needle));
            if (idx === -1) throw new Error(`保留中のリクエストが見つかりません: ${needle}`);
            const [p] = pendings.splice(idx, 1);
            p.resolve('%PDF-1.4' + '0'.repeat(Math.max(0, byteLength - 8)));
        },
    };
}

// ---------------------------------------------------------------------------
// 1. ファイルID不一致でミス（getPdfPrefetch）
// ---------------------------------------------------------------------------

test('getPdfPrefetch: ファイルIDが一致すればヒットし、同じPromiseを返す', async () => {
    const stub = stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'file0');
    session.fulltextCandidates = [session.currentRef, cachedRef('ref1', 'fileA')];
    session.currentCandidateIndex = 0;

    prefetchNeighbors();
    await flushMicrotasks();
    stub.resolveByUrlIncluding('fileA', 1000);
    const blob = await getPdfPrefetch('ref1', 'fileA');
    assert.ok(blob);
    assert.equal(blob!.size, 1000);

    // 同じファイルIDでの再取得は同じPromiseを返す（ヒット。追加ダウンロードは発生しない）
    assert.equal(getPdfPrefetch('ref1', 'fileA'), session.pdfPrefetch.get('ref1')?.promise);
});

test('getPdfPrefetch: ファイルIDが不一致ならミスとし、古いエントリを中止・破棄する', async () => {
    stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'file0');
    session.fulltextCandidates = [session.currentRef, cachedRef('ref1', 'fileA')];
    session.currentCandidateIndex = 0;

    prefetchNeighbors();
    await flushMicrotasks();
    const entry = session.pdfPrefetch.get('ref1');
    assert.ok(entry, '先読みエントリが作られていること');

    // PDFが再アップロードでDriveファイルIDが変わったケースを想定し、別のfileIdで取り出す
    const result = getPdfPrefetch('ref1', 'fileB-差し替え後');
    assert.equal(result, undefined, 'ファイルID不一致はmiss扱いになること');
    assert.equal(session.pdfPrefetch.has('ref1'), false, '古いエントリはMapから破棄されること');
    assert.equal(entry!.controller.signal.aborted, true, '古いエントリの進行中リクエストは中止されること');

    // 後片付け: 中止されたエントリのpromise自体は（abortをnullへ丸めて）正常に解決する
    await entry!.promise;
});

// ---------------------------------------------------------------------------
// 2. 保持バイト数の上限での追い出し
// ---------------------------------------------------------------------------

test('保持バイト数の合計が上限を超えたら、古いエントリから追い出す', async () => {
    const stub = stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'file0');
    session.fulltextCandidates = [
        session.currentRef,
        cachedRef('ref1', 'fileA'), // d=1: 先に挿入される（古い）
        cachedRef('ref2', 'fileB'), // d=2: 後に挿入される（新しい）
    ];
    session.currentCandidateIndex = 0;

    prefetchNeighbors();
    await flushMicrotasks();
    assert.equal(session.pdfPrefetch.size, 2, '最大2件まで先読みされること');

    // 20MB + 15MB = 35MB は上限(32MB)を超える。古い方(ref1)が先に解決した場合、
    // 2件目(ref2)の解決時点で合計超過が判明し、挿入順で古いref1が追い出される。
    const twentyMb = 20 * 1024 * 1024;
    const fifteenMb = 15 * 1024 * 1024;
    assert.ok(twentyMb + fifteenMb > MAX_PDF_PREFETCH_TOTAL_BYTES);

    stub.resolveByUrlIncluding('fileA', twentyMb);
    await session.pdfPrefetch.get('ref1')!.promise;
    assert.equal(session.pdfPrefetch.has('ref1'), true, '単独では上限内なので、この時点ではまだ追い出されない');

    stub.resolveByUrlIncluding('fileB', fifteenMb);
    await session.pdfPrefetch.get('ref2')!.promise;

    assert.equal(session.pdfPrefetch.has('ref1'), false, '合計超過により、古いref1が追い出されること');
    assert.equal(session.pdfPrefetch.has('ref2'), true, '新しいref2は残ること');
});

test('単体で上限を超える巨大PDFは保持しない', async () => {
    const stub = stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'file0');
    session.fulltextCandidates = [session.currentRef, cachedRef('ref1', 'fileA')];
    session.currentCandidateIndex = 0;

    prefetchNeighbors();
    await flushMicrotasks();
    const tooBig = MAX_PDF_PREFETCH_TOTAL_BYTES + 1;
    stub.resolveByUrlIncluding('fileA', tooBig);
    await session.pdfPrefetch.get('ref1')?.promise;

    assert.equal(session.pdfPrefetch.has('ref1'), false, '上限単体超過のBlobは保持されないこと');
});

// ---------------------------------------------------------------------------
// 3. 同時実行数の勘定（現在地の除外）と、fileId一致時のエントリ維持
// ---------------------------------------------------------------------------

test('同時実行数の上限は現在地自身の先読みを含めないため、速い連続移動でも隣接2件の先読みが続くこと（回帰）', async () => {
    const stub = stubControllableFetch();
    const refs = [
        cachedRef('ref0', 'f0'),
        cachedRef('ref1', 'f1'),
        cachedRef('ref2', 'f2'),
        cachedRef('ref3', 'f3'),
    ];
    session.fulltextCandidates = refs;

    // 1歩目: ref0 表示中 → ref1・ref2 の先読みを開始する（未解決のまま止めておき低速回線を模す）
    session.currentRef = refs[0];
    session.currentCandidateIndex = 0;
    prefetchNeighbors();
    await flushMicrotasks();
    assert.deepEqual([...session.pdfPrefetch.keys()].sort(), ['ref1', 'ref2']);
    assert.equal(session.pdfPrefetch.size, MAX_PDF_PREFETCH_CONCURRENCY, '既定どおり2件まで先読みされること');

    // 2歩目: ref1 へ前進。ref1自身の先読みはまだ未解決（低速回線）だが、現在地自身の
    // ダウンロードなので同時実行数のカウントには含めない（countInFlightSpeculativePrefetches）。
    // 投機的に進行中なのは継続中のref2の1件だけなので、ref3の先読みが正しく開始される。
    // これが無いと「現在地自身が未解決なだけ」で枠が1件分に縮み、速く連続移動する場面で
    // 2件目の隣接先読みが恒久的に開始されなくなる（実際に踏んだ回帰）。
    session.currentRef = refs[1];
    session.currentCandidateIndex = 1;
    prefetchNeighbors();
    assert.deepEqual([...session.pdfPrefetch.keys()].sort(), ['ref1', 'ref2', 'ref3'],
        '現在地自身の先読みは上限のカウントに含めないため、ref3の先読みが開始されること');

    // 後片付け
    await flushMicrotasks();
    stub.resolveByUrlIncluding('f1', 10);
    stub.resolveByUrlIncluding('f2', 10);
    stub.resolveByUrlIncluding('f3', 10);
});

test('prefetchNeighbors: fileIdが一致する隣接候補は再ダウンロードを開始せずエントリをそのまま維持する', () => {
    // このテストが検証しているのは「同じ実体を先読み済み/進行中の候補は、再ダウンロードを
    // 開始せず既存エントリをそのまま使う」という continue 分岐（fileId一致）だけである。
    // 同時実行数の上限（MAX_PDF_PREFETCH_CONCURRENCY）がどう作用するかはここでは検証しない
    // ——fileIdが一致する限り新規開始そのものが試みられないため、上限の分岐には到達しない。
    // 上限がどのような位置づけのガードか（現在の唯一の呼び出し経路からは構造的に発火しない
    // 防御的なガードであること）は prefetchNeighbors() のdocstringを参照。
    stubControllableFetch();

    const current = cachedRef('current', 'fCurrent');
    const refA = cachedRef('refA', 'fA'); // d=1 の隣接候補
    const refB = cachedRef('refB', 'fB'); // d=2 の隣接候補
    session.fulltextCandidates = [current, refA, refB];
    session.currentRef = current;
    session.currentCandidateIndex = 0;

    // refA・refBについて、それぞれ現在のfileIdと一致するエントリが既に先読み済み/進行中の
    // 状態を直接組み立てる。
    const entryA = { fileId: 'fA', controller: new AbortController(), promise: Promise.resolve(null) };
    const entryB = { fileId: 'fB', controller: new AbortController(), promise: Promise.resolve(null) };
    session.pdfPrefetch.set('refA', entryA);
    session.pdfPrefetch.set('refB', entryB);

    prefetchNeighbors();

    // fileIdが一致するため両方とも「継続中」として扱われ、エントリ自体が差し替えられて
    // いない（＝余計な再ダウンロードが発生していない）ことを、同一参照であることで確認する。
    assert.deepEqual([...session.pdfPrefetch.keys()].sort(), ['refA', 'refB']);
    assert.equal(session.pdfPrefetch.size, 2);
    assert.equal(session.pdfPrefetch.get('refA'), entryA, '既存の進行中エントリがそのまま維持されること');
    assert.equal(session.pdfPrefetch.get('refB'), entryB, '既存の進行中エントリがそのまま維持されること');
});

// ---------------------------------------------------------------------------
// 4. keep集合から外れたエントリのabort伝播
// ---------------------------------------------------------------------------

test('prefetchNeighbors: keep集合から外れたエントリは進行中リクエストごと中止される', () => {
    stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'f0');
    session.fulltextCandidates = [cachedRef('ref0', 'f0'), cachedRef('ref1', 'f1')];
    session.currentCandidateIndex = 0;
    prefetchNeighbors();

    const entry = session.pdfPrefetch.get('ref1');
    assert.ok(entry);
    assert.equal(entry!.controller.signal.aborted, false);

    // ref1からさらに離れた文献へ移動 → ref1は候補から外れる
    session.currentRef = cachedRef('refX', 'fX');
    session.fulltextCandidates = [session.currentRef];
    session.currentCandidateIndex = 0;
    prefetchNeighbors();

    assert.equal(session.pdfPrefetch.has('ref1'), false);
    assert.equal(entry!.controller.signal.aborted, true, '外れたエントリの進行中リクエストが中止されること');
});

test('discardPdfPrefetchEntry / clearPdfPrefetch: 単体破棄と全件破棄', () => {
    stubControllableFetch();
    session.currentRef = cachedRef('ref0', 'f0');
    session.fulltextCandidates = [session.currentRef, cachedRef('ref1', 'f1'), cachedRef('ref2', 'f2')];
    session.currentCandidateIndex = 0;
    prefetchNeighbors();
    assert.equal(session.pdfPrefetch.size, 2);

    const entry1 = session.pdfPrefetch.get('ref1')!;
    discardPdfPrefetchEntry('ref1');
    assert.equal(session.pdfPrefetch.has('ref1'), false);
    assert.equal(entry1.controller.signal.aborted, true);
    assert.equal(session.pdfPrefetch.size, 1);

    // 存在しないキーへの呼び出しは無害
    discardPdfPrefetchEntry('存在しないref');

    const entry2 = session.pdfPrefetch.get('ref2')!;
    clearPdfPrefetch();
    assert.equal(session.pdfPrefetch.size, 0, 'ページ後片付け: 全エントリが空になること');
    assert.equal(entry2.controller.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// 5. downloadDriveFile(): abortはDriveTransientErrorに化けない
// ---------------------------------------------------------------------------

test('downloadDriveFile: signal経由のabortはAbortErrorのまま投げ、DriveTransientErrorにしない', async () => {
    let capturedSignal: AbortSignal | undefined;
    // 実fetchと同じ規約: 呼ばれた時点で既にabort済みならその場で reject、
    // まだなら abort イベントを待って reject する（downloadDriveFile は
    // getAuthToken() のawaitを挟むため、fetch呼び出しより先にabort()が
    // 呼ばれることがある。その場合でも正しく中断として扱われることを確認する）。
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
                return;
            }
            signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        });
    }) as typeof fetch;

    const controller = new AbortController();
    const promise = downloadDriveFile('file-1', controller.signal);
    controller.abort(); // getAuthToken() のawait中（fetch呼び出し前）に中断する

    await assert.rejects(promise, (err: unknown) => {
        assert.ok(!(err instanceof DriveTransientError), 'abortはDriveTransientErrorに化けないこと');
        assert.equal((err as Error).name, 'AbortError');
        return true;
    });
    assert.equal(capturedSignal?.aborted, true, 'downloadDriveFileはsignalをfetchへ伝播すること');
});

test('downloadDriveFile: それ以外のネットワーク例外は従来どおりDriveTransientError（回帰防止）', async () => {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await assert.rejects(downloadDriveFile('file-1'), DriveTransientError);
});
