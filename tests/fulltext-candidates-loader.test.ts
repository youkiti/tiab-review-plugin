import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicationCandidatesLoader } from '../src/sidepanel/features/fulltext/candidates-loader';
import type { PublicationCandidatesLoaderDeps } from '../src/sidepanel/features/fulltext/candidates-loader';
import type { PublicationCandidate } from '../src/lib/types';

// Issue #188: フルテキストタブの論文候補読み込みがプロジェクトをまたいで混線する不具合の修正。
// createPublicationCandidatesLoader() は DOM・state に依存しないため、依存を差し替えて
// 完了タイミングを手で制御できる（tests/async-coalesce.test.ts の deferred<T>() と同じ流儀）。

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeCandidate(id: string): PublicationCandidate {
    return {
        candidate_id: id,
        ref_id: 'ref-1',
        trial_id: 'NCT00000001',
        strategy: 'pubmed_id',
        status: 'suggested',
        suggested_at: '2026-01-01T00:00:00Z',
    };
}

/**
 * テスト用の依存一式。currentSpreadsheetId を書き換えてプロジェクト切替を模擬する。
 *
 * fetchCandidates の呼び出しは spreadsheetId ではなく**呼び出し順（0始まり）**で解決/失敗させる。
 * 同じ spreadsheetId（例: 'sheet-a'）へ A→B→A のように戻ってくると、'sheet-a' 宛ての
 * fetchCandidates 呼び出しが2回（1回目と3回目）発生し、どちらを先に完了させるかをテスト側で
 * 自由に制御する必要があるため、spreadsheetId をキーにした解決だと呼び出し順を区別できない。
 */
function makeDeps() {
    let currentSpreadsheetId = 'sheet-a';
    const fetchCalls: string[] = [];
    const applyCalls: PublicationCandidate[][] = [];
    let renderCount = 0;
    const pending: Deferred<PublicationCandidate[]>[] = [];

    const deps: PublicationCandidatesLoaderDeps = {
        fetchCandidates: async (spreadsheetId: string) => {
            fetchCalls.push(spreadsheetId);
            const d = deferred<PublicationCandidate[]>();
            pending.push(d);
            return d.promise;
        },
        getCurrentSpreadsheetId: () => currentSpreadsheetId,
        applyCandidates: (candidates) => { applyCalls.push(candidates); },
        render: () => { renderCount++; },
    };

    return {
        deps,
        fetchCalls,
        applyCalls,
        getRenderCount: () => renderCount,
        /** 直近で applyCandidates に渡された引数（`Array.prototype.at` は tsconfig の lib 対象外）。 */
        getLastApply: () => applyCalls[applyCalls.length - 1],
        setCurrentSpreadsheetId: (id: string) => { currentSpreadsheetId = id; },
        /** fetchCandidates の callIndex 番目（0始まり）の呼び出しを成功させる。 */
        resolveCall: (callIndex: number, candidates: PublicationCandidate[]) => {
            pending[callIndex].resolve(candidates);
        },
        /** fetchCandidates の callIndex 番目（0始まり）の呼び出しを失敗させる。 */
        rejectCall: (callIndex: number, err: unknown) => {
            pending[callIndex].reject(err);
        },
    };
}

test.beforeEach(() => {
    mock.method(console, 'warn', () => {});
});
test.afterEach(() => {
    mock.restoreAll();
});

test('createPublicationCandidatesLoader: 同じ spreadsheetId の2回目の呼び出しは進行中の取得へ合流する', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    const second = load('sheet-a');

    assert.equal(h.fetchCalls.length, 1, 'fetchCandidates は1回しか呼ばれない');

    h.resolveCall(0, [makeCandidate('c1')]);
    const [r1, r2] = await Promise.all([first, second]);

    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(h.fetchCalls.length, 1);
});

test('createPublicationCandidatesLoader: 別の spreadsheetId の呼び出しは合流せず新しい取得を必ず開始し、Bの結果が反映されAの結果（stale）は反映されない', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    const second = load('sheet-b');

    assert.deepEqual(h.fetchCalls, ['sheet-a', 'sheet-b'], 'fetchCandidates がそれぞれ正しい id で2回呼ばれる');

    h.setCurrentSpreadsheetId('sheet-b');
    const bCandidates = [makeCandidate('b1')];
    h.resolveCall(1, bCandidates); // Bの取得が先に完了する
    const resultB = await second;
    assert.equal(resultB, true);
    assert.deepEqual(h.getLastApply(), bCandidates, 'Bの候補がキャッシュへ反映される');

    h.resolveCall(0, [makeCandidate('a1')]); // Aの取得は切替後に完了する（stale）
    const resultA = await first;
    assert.equal(resultA, true, 'staleでも呼び出し元には成功扱いで返す（旧プロジェクトのエラートーストを防ぐため）');

    // Issue #188（合流をプロジェクト単位に分けないと、切替先が自分の候補を取り直さないまま
    // 無言で空になる点）の回帰確認。ここではBの候補が最後まで残り、Aのstale結果で
    // 上書きされないことを見る。
    assert.deepEqual(h.getLastApply(), bCandidates, 'Aのstale結果でBの候補が上書きされない');
    assert.ok(
        !h.applyCalls.some(candidates => candidates.some(c => c.candidate_id === 'a1')),
        'Aの結果（stale）は一度もキャッシュへ反映されない'
    );
});

test('createPublicationCandidatesLoader: Aの取得中にBへ切り替わってからAが成功で完了した場合、applyCandidatesもrenderも呼ばれず戻り値はtrue', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    // Bへ切り替え（Bの取得自体は始めない。Aの結果だけを見るケース）
    h.setCurrentSpreadsheetId('sheet-b');

    h.resolveCall(0, [makeCandidate('a1')]);
    const result = await first;

    assert.equal(result, true, 'stale でも呼び出し元には成功として返す（旧プロジェクトのエラートーストを防ぐため）');
    assert.equal(h.applyCalls.length, 0, 'stale な結果はキャッシュへ反映しない');
    assert.equal(h.getRenderCount(), 0, 'stale な結果では再描画しない');
});

test('createPublicationCandidatesLoader: Aの取得中にBへ切り替わってからAが失敗で完了した場合も戻り値はtrue', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    h.setCurrentSpreadsheetId('sheet-b');

    h.rejectCall(0, new Error('boom'));
    const result = await first;

    assert.equal(result, true, 'stale な失敗は呼び出し元には成功扱いで返す');
    assert.equal(h.getRenderCount(), 0, 'stale な失敗では render しない');
});

test('createPublicationCandidatesLoader: 切り替わっていない状態で成功した場合はapplyCandidatesに結果が渡りrenderが呼ばれ戻り値はtrue', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    const candidates = [makeCandidate('a1')];
    h.resolveCall(0, candidates);
    const result = await first;

    assert.equal(result, true);
    assert.equal(h.applyCalls.length, 1);
    assert.deepEqual(h.applyCalls[0], candidates);
    assert.equal(h.getRenderCount(), 1);
});

test('createPublicationCandidatesLoader: 切り替わっていない状態で失敗した場合はrenderが呼ばれ戻り値はfalse', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const first = load('sheet-a');
    h.rejectCall(0, new Error('boom'));
    const result = await first;

    assert.equal(result, false);
    assert.equal(h.getRenderCount(), 1);
});

test('createPublicationCandidatesLoader: プロジェクトが変わって合流先を作り直すとき取得完了を待たずにapplyCandidates([])とrenderが呼ばれる（初回は起きない）', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    // 初回呼び出し: クリアは起きない
    const first = load('sheet-a');
    assert.equal(h.applyCalls.length, 0, '初回はキャッシュを空にする意味が無いため呼ばれない');
    assert.equal(h.getRenderCount(), 0);

    // プロジェクトが変わる（Aの取得完了を待たない）
    h.setCurrentSpreadsheetId('sheet-b');
    const second = load('sheet-b');

    assert.equal(h.applyCalls.length, 1, '合流先を作り直す時点で即座にキャッシュを空にする');
    assert.deepEqual(h.applyCalls[0], []);
    assert.equal(h.getRenderCount(), 1);

    // 後始末: pending なfetchを解決してテストのハングを防ぐ
    h.resolveCall(0, [makeCandidate('a1')]);
    h.resolveCall(1, [makeCandidate('b1')]);
    await Promise.all([first, second]);
});

test('createPublicationCandidatesLoader: A→B→A と切り替えたあと、後発のA2を先に完了させても先発のA1の結果はA2の結果を上書きしない', async () => {
    const h = makeDeps();
    const load = createPublicationCandidatesLoader(h.deps);

    const a1 = load('sheet-a'); // callIndex 0: A1（最初のAの取得）
    h.setCurrentSpreadsheetId('sheet-b');
    const b = load('sheet-b'); // callIndex 1: B
    h.setCurrentSpreadsheetId('sheet-a');
    const a2 = load('sheet-a'); // callIndex 2: A2（Aへ戻ってきて作り直した合流先）

    assert.deepEqual(h.fetchCalls, ['sheet-a', 'sheet-b', 'sheet-a']);

    // A2を先に完了させる
    const a2Candidates = [makeCandidate('a2-1')];
    h.resolveCall(2, a2Candidates);
    assert.equal(await a2, true);
    assert.deepEqual(h.getLastApply(), a2Candidates, 'A2の結果がキャッシュへ反映される');

    // A1（最初の取得）が後から完了する。spreadsheetId は 'sheet-a' で現在の表示中プロジェクトとも
    // 一致するため、getCurrentSpreadsheetId() による判定だけでは stale と見抜けない
    // （Issue #188。同じ spreadsheetId へ戻った場合は表示中プロジェクトの一致だけでは stale と
    // 見抜けない点）。memo の同一性チェックで A1 を stale と判定できることを確認する。
    h.resolveCall(0, [makeCandidate('a1-1')]);
    assert.equal(await a1, true, 'staleでも呼び出し元には成功扱いで返す');

    assert.deepEqual(h.getLastApply(), a2Candidates, 'A1の結果でA2の結果が上書きされない');
    assert.ok(
        !h.applyCalls.some(candidates => candidates.some(c => c.candidate_id === 'a1-1')),
        'A1の結果（stale）は一度もキャッシュへ反映されない'
    );

    // 後始末: Bの取得も解決してテストのハングを防ぐ
    h.resolveCall(1, [makeCandidate('b1')]);
    await b;
});
