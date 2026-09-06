// candidates-loader.ts
// フルテキストタブの論文候補（Publication_Candidates）読み込みを、プロジェクト（spreadsheetId）
// 単位で合流・破棄するローダーを作る。DOM・state に一切依存しない依存注入型のファクトリにして
// tab.ts から node のテストだけで検証できるようにする（tab.ts 本体は DOM 依存でテストから
// 直接は通せない。tests/fulltext-lazy.test.ts が tab.ts を require.cache で差し替えて
// 回避しているのと同じ事情）。
//
// Issue #188: フルテキストタブの論文候補読み込みがプロジェクトをまたいで混線する不具合の修正。
// 原因は2つあり、片方だけ直すと別の不具合になる。
//
// 1. 取得完了後に「今も同じプロジェクトを見ているか」を確認せず無条件でキャッシュへ書き込んで
//    いたため、取得中にプロジェクトが切り替わると旧プロジェクトの候補が新プロジェクトの画面へ
//    書き込まれていた。
// 2. 合流（createAsyncCoalescer）をプロジェクトをまたいで1本しか持たないと、1だけを
//    「切り替わっていたら破棄」に直しても、切替先の呼び出しが旧プロジェクトの取得へ合流して
//    しまい、その結果は破棄対象になるため、切替先は自分自身の候補を取り直さないまま無言で
//    空になる（症状が別の形に移るだけ）。
//
// そのため、プロジェクト（spreadsheetId）ごとに合流先を分ける単一スロットの memo にする
// （src/lib/sheets/llm-history.ts の createLlmSheetEnsureMemo() / getLlmExecutionsEnsureMemo()
// と同型）。Map ではなく単一スロットなのは、表示するのは常に現在のプロジェクト1つだけで、
// セッション中に訪れた全プロジェクト分のエントリを残す必要が無いため
// （src/sidepanel/utils/offline-queue.ts の flushCoalescers のように、複数プロジェクトを
// 同時に扱う必要がある場合は Map を使うが、ここでは該当しない）。

import { createAsyncCoalescer } from '../../../lib/async-coalesce';
import type { PublicationCandidate } from '../../../lib/types';

export interface PublicationCandidatesLoaderDeps {
    /** Sheets から候補を取得する（実体は sheets-api.ts の getPublicationCandidates） */
    fetchCandidates: (spreadsheetId: string) => Promise<PublicationCandidate[]>;
    /** 現在表示中のプロジェクト。取得完了時に呼んで切替を検知する */
    getCurrentSpreadsheetId: () => string;
    /** 取得結果をキャッシュへ反映する */
    applyCandidates: (candidates: PublicationCandidate[]) => void;
    /** 再描画 */
    render: () => void;
}

type CandidatesMemo = {
    spreadsheetId: string;
    fetch: () => Promise<boolean>;
};

/**
 * プロジェクト単位で合流・破棄する論文候補ローダーを作る。
 *
 * 【なぜ真偽値フラグの二重起動防止ではだめか】単純な `if (loading) return;` だと、進行中の
 * 呼び出しを「捨てる」だけで、待っている呼び出し元には何も返せない。fire-and-forget
 * （`void loadCandidatesForProject(...)`）で呼ぶ分には問題にならないが、
 * fulltext/publication-candidates.ts の handleImportCandidate は
 * `await deps.reloadPublicationCandidates()` と**待って**からトースト表示・パネル更新へ進む。
 * 一括検索/再探索の完了直後の読み込みが飛んでいる最中に「取り込む」を押すと、待っている側の
 * 呼び出しが（真偽値ガードのせいで）即座に空振りし、取り込み済みの候補が suggested のまま
 * パネル・バッジに残り続ける不具合を実際に踏んだ（Issue #118 チャンク3b）。createAsyncCoalescer()
 * は進行中の Promise をそのまま返す（合流）ため、fire-and-forget側の挙動を変えずに、await
 * する側も本当の完了まで待てるようにする。
 *
 * 【プロジェクト別に合流を分ける理由】上の合流をプロジェクトをまたいで1本の
 * コールセーサーで実装すると、取得完了時に「現在のプロジェクトと突き合わせて破棄する」判定を
 * 足しただけでは直らない。切替先の呼び出しが旧プロジェクトの取得へ合流してしまい、
 * その結果は破棄対象（stale）になるため、切替先は自分自身の候補を一度も取り直さないまま
 * 無言で空になる。プロジェクト（spreadsheetId）が変わるたびに合流先を作り直せば、
 * 切替先は必ず自分専用の新しい取得を開始できる。
 *
 * 【戻り値と合流セマンティクス】成功したら true、Sheets読み込みが失敗したら false を返す。
 * ただし、取得完了時に stale（後述の isStale 判定）と分かった場合は、成功・失敗のいずれでも
 * true を返し、`applyCandidates()` も `render()` も呼ばない。stale のときに false を返すと、
 * 待っている呼び出し元（loadPublicationCandidates）が「読み込み失敗」と誤認し、旧プロジェクト
 * 由来のエラートーストを新しい画面に出してしまうため、あえて true にしている
 * （旧プロジェクトの候補で新しい画面を上書きしないことは別途 applyCandidates を呼ばないことで
 * 保証しており、この true は「エラー扱いにしない」ためだけの意味）。
 *
 * 【stale 判定は2条件のANDではなくORで、両方必要】(a) 自分の memo スロットがまだ現役か
 * （`memo !== created`）、(b) 表示中のプロジェクトが自分の取得対象と一致するか
 * （`getCurrentSpreadsheetId() !== spreadsheetId`）のどちらかが成立すれば stale とする。
 * 片方だけでは次の事故が残る。
 *
 * - (a) を削って (b) だけにすると: A取得中→Bへ切替（memoをBへ作り直し）→Aへ戻る
 *   （memoを新しいA2へ作り直し、A2の取得を開始）という順で操作したとき、最初のA1の取得が
 *   A2より後に完了すると、その完了時点で `getCurrentSpreadsheetId()` は 'sheet-a' のままなので
 *   (b) の判定だけではA1をstaleと判定できず、A1の結果がA2の結果を上書きしてしまう
 *   （Issue #188）。同じ spreadsheetId へ戻ってきた場合を区別するには、`spreadsheetId` の
 *   一致だけでなく「自分の作った memo スロットがまだ現役か」を見る必要がある。
 * - (b) を削って (a) だけにすると: memo が現役のままでも表示中プロジェクトが違うケースが残る。
 *   切替先Bに registration行が1件も無いと、tab.ts の loadPublicationCandidates() が
 *   早期returnしてこの関数自体を呼ばないため、memoはAのまま更新されない。この状態でAの
 *   取得が完了すると、(a) は「現役のまま」なので通り抜けてしまい、Bの画面にAの候補が
 *   書き込まれてしまう。
 */
export function createPublicationCandidatesLoader(
    deps: PublicationCandidatesLoaderDeps
): (spreadsheetId: string) => Promise<boolean> {
    let memo: CandidatesMemo | null = null;

    return (spreadsheetId: string): Promise<boolean> => {
        if (memo === null || memo.spreadsheetId !== spreadsheetId) {
            // プロジェクトが変わった（＝合流先を作り直す）場合は、取得の完了を待たずに
            // 即座にキャッシュを空にする。ここでクリアしないと、新プロジェクトの取得が
            // 終わるまで前のプロジェクトの候補が画面に残り続ける。
            // 初回（memo が null）はキャッシュを空にする意味が無いため行わない。
            if (memo !== null) {
                deps.applyCandidates([]);
                deps.render();
            }
            // 渡された spreadsheetId をここで引数として閉じ込めて使う。取得中に
            // getCurrentSpreadsheetId() の値が変わりうるため、取得そのものの入力には
            // 使わない（入力に使うと、取得中にプロジェクトが切り替わった時点でリクエスト先
            // そのものが変わってしまう）。
            const created: CandidatesMemo = {
                spreadsheetId,
                fetch: createAsyncCoalescer(async (): Promise<boolean> => {
                    // stale 判定の2条件の理由は関数本体のJSDoc「stale 判定は2条件のANDでは
                    // なくORで、両方必要」を参照。
                    const isStale = () => memo !== created || deps.getCurrentSpreadsheetId() !== spreadsheetId;
                    // try は取得（fetchCandidates）だけを覆う。applyCandidates()/render() まで
                    // 覆うと、描画側の例外が「論文候補の読み込みに失敗」という誤ったログと
                    // 読み込みエラーのトーストに化けてしまう（描画のバグが取得の失敗として
                    // 報告される）。
                    let candidates: PublicationCandidate[];
                    try {
                        candidates = await deps.fetchCandidates(spreadsheetId);
                    } catch (err) {
                        console.warn('[fulltext-candidates-loader] 論文候補の読み込みに失敗:', err);
                        if (isStale()) return true; // stale: render しない
                        deps.render();
                        return false;
                    }
                    if (isStale()) return true; // stale: 何もしない
                    deps.applyCandidates(candidates);
                    deps.render();
                    return true;
                }),
            };
            memo = created;
        }
        return memo.fetch();
    };
}
