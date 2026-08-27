// publication-candidate-rerun.ts
// Issue #118「レジストリ連携フェーズ1」チャンク2、PR #122 レビュー指摘2: registration行の論文候補探索を
// フルテキスト取得状態（fulltext_status）から独立して再実行するための、UI（dom/state）に
// 依存しない純粋部分。呼び出し側は src/sidepanel/features/fulltext-tab.ts の
// handleBulkSuggest()（一括再探索。fulltext_status を一切見ず、registration行全部が対象）。
//
// 「候補行が既にあるかどうか」で探索済みを推測する実装にはしていない（まだ探索していない／
// 探索したが候補0件だった／探索に失敗したを区別できず、候補0件の登録が永久に対象リストへ
// 残って押すたびに外部APIを叩き続けることになるため）。代わりに、取得状態を一切見ない
// 明示的な再探索の導線を1本用意し、savePublicationCandidates() 側の filterNewCandidates()
// （同一 ref_id かつ同一PMID/DOIを除外）による冪等性を根拠に「何度再実行しても安全」としている。

import type { PublicationCandidateDraft } from './publication-suggest';

/** extractTrialId()（src/lib/registry-record.ts）が返す試験ID。型を再定義せず利用側に合わせる。 */
export interface RerunTrial {
    id: string;
    kind: 'nct' | 'other';
}

/**
 * registration行1件ぶんの論文候補を、フルテキスト取得状態から独立して探索する。
 *
 * NCTのときだけ fetchCtg（fetchCtgStudy）を1回呼び、その pmids を discoverCandidates
 * （discoverPublicationCandidates）の ctgPmids にそのまま渡す。フルテキスト取得と論文候補探索が
 * 同一操作内で連続する既存経路（retrieveRegistrationSnapshot → discoverRegistryPublicationCandidates、
 * outcome.registryPmids 経由でCTG APIを2回叩かない配線）とは別の、独立した再探索専用の経路のため、
 * ここで自前にCTG APIへ問い合わせる必要がある（既存配線は変更しない）。
 *
 * fetchCtg が null を返しても（CTG API失敗）、あるいは kind==='other' で最初から呼ばなくても、
 * ctgPmids: [] のまま discoverCandidates は必ず呼ぶ（pubmed_id / europepmc の2戦略は
 * ctgov_reference と独立に動くため、CTG側の欠落だけで探索全体を諦めない）。
 *
 * 例外はここで握りつぶし空配列を返す（呼び出し側の一括ループを1件の失敗で止めないため。
 * discoverPublicationCandidates 自体は内部で各戦略ごとに握りつぶす設計だが、念のため二重に構える）。
 */
export async function discoverCandidatesForRerun(
    trial: RerunTrial,
    discoverCandidates: (ctgPmids: string[]) => Promise<PublicationCandidateDraft[]>,
    fetchCtg: (nctId: string) => Promise<{ pmids: string[] } | null>
): Promise<PublicationCandidateDraft[]> {
    try {
        const ctgPmids = trial.kind === 'nct' ? (await fetchCtg(trial.id))?.pmids ?? [] : [];
        return await discoverCandidates(ctgPmids);
    } catch {
        return [];
    }
}

/**
 * 候補バッファを save() でまとめて保存し、保存に成功した分だけ buffer から取り除く。
 *
 * 失敗時は buffer をそのまま残す（呼び出し側が次のflush呼び出しで再送できるように）。
 * 「先に buffer を空にしてから保存する」実装だと、保存に失敗した瞬間にバッファごと候補が
 * 消えてしまう（Issue #118 チャンク2、PR #122 レビュー指摘2（候補保存失敗時にバッファを破棄していた点））。buffer は呼び出し側の配列をそのまま
 * 破壊的に更新する（splice）ため、呼び出し側は同じ配列参照を使い回すこと。
 *
 * @returns 保存に成功した（または buffer が空だった）ら true、失敗して buffer に要素が
 *          残っているなら false
 */
export async function flushCandidateBuffer<T>(
    buffer: T[],
    save: (items: T[]) => Promise<void>
): Promise<boolean> {
    if (buffer.length === 0) return true;
    const batch = buffer.slice();
    try {
        await save(batch);
        buffer.splice(0, batch.length);
        return true;
    } catch {
        return false;
    }
}

/**
 * 次に flush を試みるべきバッファ長の閾値を決める（PR #122 レビュー指摘2: handleBulkSuggest が
 * 保存失敗時に毎行リトライしてしまう問題の修正）。
 *
 * flushCandidateBuffer() は失敗時に buffer を保持する設計のため、呼び出し側が閾値を
 * baseInterval 固定のまま毎行 `buffer.length >= baseInterval` を見ていると、Sheetsが
 * 落ちている間は以降のループが毎行 flush を呼び直し、1行につき1回ずつ ensure→読み取り→append を
 * 空振りさせることになる（registration行が200件なら200回）。失敗したら「さらに baseInterval 件
 * たまるまで再試行しない」ことで、リトライ頻度を抑える。
 */
export function nextCandidateFlushThreshold(
    bufferLength: number,
    saveSucceeded: boolean,
    baseInterval = 5
): number {
    return saveSucceeded ? baseInterval : bufferLength + baseInterval;
}
