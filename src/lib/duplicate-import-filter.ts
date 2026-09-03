// duplicate-import-filter.ts
// 取り込み時の重複検出（作り直し、Issue #145）で使う純関数層。UI 非依存。
// 旧実装（src/sidepanel/features/import-export.ts の handleRISImport() にインライン展開されていた
// もの）は、既存シート行から作った Set としか照合せずバッチ内で同じキーの2件が来ても
// 両方通ってしまうバグがあった（実データで DOI 完全一致の2件がこれで通過していた）。
// ここでは incoming を入力順に走査しながらインデックスを更新していくことで、
// バッチ内の重複も検出する。

import type { Reference } from './types';
import type { DuplicateMatch, DuplicateMatchType } from './duplicate-detect';
import { buildMatchKeys, normalizePairKey, normalizeSource } from './duplicate-detect';

/** PMID・DOI・試験IDの一致により自動的にスキップされた1件 */
export interface AutoSkippedReference {
    ref: Reference;
    matchType: 'pmid' | 'doi' | 'trialId';
    matchKey: string;
    existingRefId: string;   // 一致した既存側の ref_id
}

export interface PartitionResult {
    toImport: Reference[];
    autoSkipped: AutoSkippedReference[];
    reviewPairs: DuplicateMatch[];
}

/**
 * 自動スキップ用 trialId インデックスのキーを作る。試験IDと source（正規化後）の
 * 両方を含めることで、「試験IDは同じだが別レジストリ」の行を誤って一致させない。
 */
function trialIdSourceKey(trialId: string, source: string | undefined): string {
    return `${trialId}::${normalizeSource(source)}`;
}

/**
 * 取り込み対象（incoming）を、既存シート行（existing）およびバッチ内の先行レコードと
 * 突き合わせて3つに仕分ける。
 *
 * - PMID 一致・DOI 一致（どちらも「検証済み」のレコード識別子同士の一致）は取り込みを
 *   スキップし `autoSkipped` に積む。
 * - 試験ID（trialId）一致は、**source（レジストリ）も一致するときだけ**取り込みをスキップする。
 *   試験IDは「研究」の識別子であって「レコード」の識別子ではなく、ひとつの試験には試験登録・
 *   プロトコル論文・本論文・学会抄録・二次解析がぶら下がり、それらは全部同じ試験IDを共有する
 *   （詳細は duplicate-detect.ts の buildMatchKeys() JSDoc参照）。source まで一致するのは
 *   「同一レジストリの同一登録レコードが二重に取り込まれた」ケースに限られ、これは真の重複と
 *   言える。source が食い違う場合（例: ClinicalTrials.gov 由来と ICTRP 経由の CTRI 由来）は
 *   別レコードとして残す必要があるため、取り込みは通したうえで `reviewPairs` に記録するだけに
 *   とどめる。
 * - タイトルだけの一致も**取り込みをスキップしない**。別誌への二重掲載などどちらを
 *   引用するか人の判断が要るため、`toImport` に入れたうえで `reviewPairs` に記録するだけに
 *   とどめる（消費する画面は後続で実装する重複レビューUI、Issue #145 チャンク3）。
 *
 * インデックスは pmid/doi/title/trialId(+source)/trialId単独 の5本を別々に持ち、incoming を
 * 入力順に走査しながら「取り込むと決めた件」のキーをそのつど追加していく。これにより、
 * 既存シートには無くてもバッチ内で後から重複してきた件（例: 同一ファイル内でDOIが完全一致する
 * 2件）を正しく検出できる。既存インデックス構築時・走査中の追加時とも、同じキーに複数件が
 * ぶら下がる場合は最初に現れた ref_id を保持する（後から来た件で上書きしない）。
 *
 * trialId まわりのインデックスを2本に分けている理由: 試験IDだけをキーにした1本だけでは、
 * 「同じ試験IDで source が違う既存行が複数ある」場合に自動スキップの判定を誤る。
 * 例えば既存シートに ClinicalTrials.gov 由来と CTRI 由来の同一試験IDの行が両方（正しく）
 * 残っている状態で、CTRI 由来の行を含む別ファイルを取り込むと、試験IDだけのインデックスは
 * 先に登録された ClinicalTrials.gov 側しか保持できず、真の重複（CTRI 側）を取りこぼして
 * 誤って取り込んでしまう。そのため、
 * - `trialIdSourceIndex`（キー: 試験ID::正規化後source）で自動スキップの判定を行い、
 * - ヒットしなかった場合だけ `trialIdOnlyIndex`（キー: 試験IDのみ、first-wins）を見て
 *   「試験IDは同じだが別レジストリ」のレビュー候補を作る。
 *
 * pmid と doi が別々の既存行に一致したときは pmid 側だけを autoSkipped の理由として記録し、
 * doi 側の一致は記録しない（両方一致する状況自体が通常起きないデータの矛盾だが、ここでは
 * 先に一致した1本だけを記録する）。この取りこぼしうる推移的な結び付き（A=B, B=C だが A=C は
 * 未確認、のようなケース）はここでは解消しない。全件を union-find 的にグルーピングする
 * スキャンを後続で入れる際に解消する想定（Issue #145 チャンク2〜3）。
 *
 * 【existing に論理削除済み（duplicate_of 非空）の行も含めること（Issue #145 チャンク2）】
 * existing のインデックス構築はここでは duplicate_of を見ておらず、渡された行をすべて対象にする。
 * 除外してはいけない理由: 例えば A（doi X）と B（doi Y、同一タイトル）を人が「Bを重複」と判断して
 * 論理削除した後、B を含むファイルを別名で再取り込みすると、doi Y が existing インデックスに
 * 無ければ B がもう一度取り込まれてしまう。論理削除済み行を含めることで「一度重複と判断した
 * レコードは再取り込みでも弾く」という挙動を担保している。一致相手が論理削除済みだった場合に
 * reviewPairs の相手を「残す側（duplicate_of の指す先）」へ辿り直す処理はこのチャンクでは
 * 実装しない（重複レビューUI 側の関心のため）。
 */
export function partitionIncomingReferences(
    existing: Pick<Reference, 'ref_id' | 'pmid' | 'doi' | 'title' | 'source'>[],
    incoming: Reference[]
): PartitionResult {
    const pmidIndex = new Map<string, string>();
    const doiIndex = new Map<string, string>();
    const titleIndex = new Map<string, string>();
    // 自動スキップ用（試験ID::source が両方一致したときだけヒットする）
    const trialIdSourceIndex = new Map<string, string>();
    // レビュー候補用（試験IDのみ、first-wins）。自動スキップ判定でヒットしなかったときに見る。
    const trialIdOnlyIndex = new Map<string, string>();

    const registerTrialId = (trialId: string, source: string | undefined, refId: string) => {
        const sourceKey = trialIdSourceKey(trialId, source);
        if (!trialIdSourceIndex.has(sourceKey)) trialIdSourceIndex.set(sourceKey, refId);
        if (!trialIdOnlyIndex.has(trialId)) trialIdOnlyIndex.set(trialId, refId);
    };

    for (const ref of existing) {
        const keys = buildMatchKeys(ref);
        if (keys.pmid && !pmidIndex.has(keys.pmid)) pmidIndex.set(keys.pmid, ref.ref_id);
        if (keys.doi && !doiIndex.has(keys.doi)) doiIndex.set(keys.doi, ref.ref_id);
        if (keys.title && !titleIndex.has(keys.title)) titleIndex.set(keys.title, ref.ref_id);
        if (keys.trialId) registerTrialId(keys.trialId, ref.source, ref.ref_id);
    }

    const toImport: Reference[] = [];
    const autoSkipped: AutoSkippedReference[] = [];
    const reviewPairs: DuplicateMatch[] = [];
    // レビュー候補の組キー（normalizePairKey()）の既出集合。1件が trialId でも title でも
    // 同じ既存側に一致した場合、同じ組を2回積まないための重複排除。trialId を先に判定して
    // 積むため、優先順位は自然に trialId が上になる（後から来る title 側は握りつぶされる）。
    const seenReviewPairKeys = new Set<string>();

    const pushReviewPair = (refIdA: string, refIdB: string, matchType: DuplicateMatchType, matchKey: string) => {
        const pairKey = normalizePairKey(refIdA, refIdB);
        if (seenReviewPairKeys.has(pairKey)) return;
        seenReviewPairKeys.add(pairKey);
        reviewPairs.push({ refIdA, refIdB, matchType, matchKey });
    };

    for (const ref of incoming) {
        const keys = buildMatchKeys(ref);

        const pmidMatch = keys.pmid ? pmidIndex.get(keys.pmid) : undefined;
        const doiMatch = keys.doi ? doiIndex.get(keys.doi) : undefined;

        if (pmidMatch || doiMatch) {
            // pmid を doi より優先する（先に判定する）。インデックスは更新しない。
            const matchType: 'pmid' | 'doi' = pmidMatch ? 'pmid' : 'doi';
            const matchKey = pmidMatch ? (keys.pmid as string) : (keys.doi as string);
            const existingRefId = (pmidMatch ?? doiMatch) as string;
            autoSkipped.push({ ref, matchType, matchKey, existingRefId });
            continue;
        }

        const trialIdSourceMatch = keys.trialId
            ? trialIdSourceIndex.get(trialIdSourceKey(keys.trialId, ref.source))
            : undefined;
        if (trialIdSourceMatch) {
            // 同一レジストリ（source）の同一試験IDは真の重複としてスキップする。
            autoSkipped.push({
                ref,
                matchType: 'trialId',
                matchKey: keys.trialId as string,
                existingRefId: trialIdSourceMatch,
            });
            continue;
        }

        // trialId は一致したが source が食い違う（別レジストリ由来の別レコード）場合は
        // 取り込みを通したうえでレビュー候補として記録する。
        const trialIdOnlyMatch = keys.trialId ? trialIdOnlyIndex.get(keys.trialId) : undefined;
        if (trialIdOnlyMatch) {
            pushReviewPair(trialIdOnlyMatch, ref.ref_id, 'trialId', keys.trialId as string);
        }

        // タイトル一致の判定は、この件をインデックスへ追加する前（＝既存分・先行incoming分だけを
        // 見た状態）で行う。追加後に判定すると自分自身と一致してしまう。
        const titleMatch = keys.title ? titleIndex.get(keys.title) : undefined;
        if (titleMatch) {
            pushReviewPair(titleMatch, ref.ref_id, 'title', keys.title as string);
        }

        toImport.push(ref);

        // 取り込むと決めた件のキーをインデックスへ追加する。既存シート行だけでなく
        // バッチ内の先行レコードとも照合できるようにするための追加。
        if (keys.pmid && !pmidIndex.has(keys.pmid)) pmidIndex.set(keys.pmid, ref.ref_id);
        if (keys.doi && !doiIndex.has(keys.doi)) doiIndex.set(keys.doi, ref.ref_id);
        if (keys.title && !titleIndex.has(keys.title)) titleIndex.set(keys.title, ref.ref_id);
        if (keys.trialId) registerTrialId(keys.trialId, ref.source, ref.ref_id);
    }

    return { toImport, autoSkipped, reviewPairs };
}
