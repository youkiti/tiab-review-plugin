import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncCoalescer } from '../src/lib/async-coalesce';

// Issue #118 チャンク3b フォローアップ: fire-and-forget と await が混在する非同期処理の
// 二重起動防止が「捨てる」実装だと、await する呼び出し元が完了を待てない不具合を踏んだ
// （loadPublicationCandidates()。詳細は src/lib/async-coalesce.ts のコメント参照）。

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

test('createAsyncCoalescer: ロード中に呼ばれた2つ目の呼び出しは、1つ目の完了を待ってから返る（合流）', async () => {
    let callCount = 0;
    const d = deferred<number>();
    const run = createAsyncCoalescer(() => {
        callCount++;
        return d.promise;
    });

    const first = run();
    const second = run(); // 進行中なので新規実行せず合流するはず

    let secondSettled = false;
    void second.then(() => { secondSettled = true; });

    // マイクロタスクを経ても、1つ目がまだ解決していなければ2つ目も解決していないはず
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(secondSettled, false, '1つ目が終わるまで2つ目もまだ解決していない');
    assert.equal(callCount, 1, 'factory は1回しか呼ばれない（合流）');

    d.resolve(42);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(callCount, 1);
    assert.equal(firstResult, 42);
    assert.equal(secondResult, 42, '2つ目の呼び出し元も1つ目と同じ結果を受け取る');
});

test('createAsyncCoalescer: 前回の呼び出しが完了した後に呼ばれると新規実行になる', async () => {
    let callCount = 0;
    const run = createAsyncCoalescer(async () => {
        callCount++;
        return callCount;
    });

    const r1 = await run();
    const r2 = await run();

    assert.equal(r1, 1);
    assert.equal(r2, 2);
    assert.equal(callCount, 2, '前回完了後は合流対象がないため新規実行される');
});

test('createAsyncCoalescer: factory が失敗すると、合流していた全呼び出し元に同じ理由で伝播し、進行中の記録もクリアされる', async () => {
    let callCount = 0;
    let d = deferred<number>();
    const run = createAsyncCoalescer(() => {
        callCount++;
        return d.promise;
    });

    const first = run();
    const second = run();

    const boom = new Error('boom');
    d.reject(boom);

    await assert.rejects(first, boom);
    await assert.rejects(second, boom);
    assert.equal(callCount, 1, '失敗時も合流していれば factory は1回しか呼ばれない');

    // 失敗後の次の呼び出しは、進行中の記録がクリアされているため新規実行になる
    d = deferred<number>();
    const third = run();
    d.resolve(99);
    assert.equal(await third, 99);
    assert.equal(callCount, 2);
});
