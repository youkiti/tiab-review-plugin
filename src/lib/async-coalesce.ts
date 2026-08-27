// async-coalesce.ts
// Issue #118「レジストリ連携フェーズ1」チャンク3b フォローアップ: fire-and-forget（void で
// 呼ぶ）と await して完了を待つ呼び出しが混在する非同期処理を1本化するための汎用ヘルパー。
// DOM・state に依存しない純粋なユーティリティ（このモジュール自身は状態を1個持つが、
// factory の中身には一切関与しないため独立にテストできる）。
//
// 【解決する問題】単純な真偽値フラグ（isLoading）で二重起動を防ぐ実装
// （`if (loading) return; loading = true; ...; loading = false;`）は、進行中の呼び出しを
// 「捨てる」だけで、待っている呼び出し元には何も返さない。fire-and-forget の呼び出し元だけが
// 使う分には問題にならないが、同じ関数を await して「完了した」ことを前提に処理を進める
// 呼び出し元が別にいると、その呼び出し元は実際には何も起きていないのに完了したと思い込んで
// 先へ進んでしまう（Issue #118 チャンク3bで実際に踏んだ不具合: 一括検索/再探索の完了時に
// fire-and-forget で呼ぶ読み込みが進行中の間に、取り込みボタンが完了直後の再読込を await して
// も即座に空振りしていた）。
//
// createAsyncCoalescer() は「進行中の呼び出しがあればその Promise をそのまま返す（合流）」
// ことで、fire-and-forget側の挙動を変えずに、await する側も本当の完了まで待てるようにする。

/**
 * 非同期処理 `factory` を1本化する関数を作る。
 *
 * 返り値の関数を呼ぶと:
 * - 進行中の呼び出しが無ければ `factory()` を新規実行し、完了（成功/失敗いずれも）するまで
 *   「進行中」として記録する。完了すると記録をクリアする。
 * - 進行中の呼び出しがあれば、新しい `factory()` は呼ばず、進行中の Promise をそのまま返す
 *   （＝先に呼ばれた側と同じ結果を共有する）。
 *
 * `factory` が reject した場合、合流していた全ての呼び出し元に同じ reason で reject が伝播する
 * （`Promise.prototype.finally` は reject を握りつぶさないため）。次の呼び出しは
 * （進行中の記録が既にクリアされているため）新規実行になる。
 */
export function createAsyncCoalescer<T>(factory: () => Promise<T>): () => Promise<T> {
    let inFlight: Promise<T> | null = null;

    return () => {
        if (inFlight) return inFlight;

        const promise = factory().finally(() => {
            // factory 実行中に何らかの理由で inFlight が別の Promise に差し替わっていた場合は
            // 触らない（通常は起きないはずだが、安全側の同一性チェック）。
            if (inFlight === promise) inFlight = null;
        });
        inFlight = promise;
        return promise;
    };
}
