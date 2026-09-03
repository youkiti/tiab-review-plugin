// duplicate-review.ts
// 重複候補のレビューUI（Issue #147、Issue #145 チャンク3）で使う純関数層。UI 非依存。
// chrome API・DOM・state・sheets-api には依存しない。呼び出し側（UI層）はこの turn では実装しない。

import type { Reference, DuplicateCandidate } from './types';
import type { DuplicateMatch, DuplicateMatchType } from './duplicate-detect';
import { buildMatchKeys, normalizePairKey, isLogicallyDeleted, normalizeSource } from './duplicate-detect';

/**
 * 論理削除を辿ってよい深さの上限。壊れたデータ（duplicate_of の循環、指す先が存在しない等）に
 * 対して無限ループしないための安全弁。通常の重複チェーンがこの深さに達することは想定していない。
 */
const MAX_RESOLVE_HOPS = 100;

/**
 * 論理削除済みの行から「残っている側（論理削除されていない行）」へ duplicate_of を辿り直す。
 *
 * 必要な理由: partitionIncomingReferences()（duplicate-import-filter.ts）は既存インデックスの
 * 構築時に論理削除済みの行も意図的に含めている（一度重複と判断したレコードを再取り込みでも
 * 弾くため）。そのため reviewPairs の相手（refIdA）が論理削除済みの行になることがある。
 * レビュー画面ではこの「もう存在しない側」をそのまま出さず、辿り直した「残っている側」を
 * 提示するほうが自然（Issue #147。Issue #145 チャンク2から持ち越した検討事項）。
 *
 * 停止条件（優先順に判定）:
 * - 入力の refId 自体が refsById に無い → { refId, hops: 0, broken: true }
 * - 辿り着いた行が論理削除されていない → { refId: その行, hops, broken: false }
 * - 深さが上限（MAX_RESOLVE_HOPS）に達した → broken: true（refId は上限に達した時点の行）
 * - duplicate_of の指す先が refsById に存在しない → broken: true（refId はその時点の行）
 * - duplicate_of の指す先が訪問済み（循環）→ broken: true（refId は循環を検出した時点の行。
 *   つまり「次に進もうとしたら訪問済みだった」ときの現在地。循環に入る直前の行ではなく、
 *   循環を検出できた最後の到達点を返す）
 */
export function resolveSurvivor(
    refId: string,
    refsById: Map<string, Pick<Reference, 'ref_id' | 'duplicate_of'>>
): { refId: string; hops: number; broken: boolean } {
    if (!refsById.has(refId)) {
        return { refId, hops: 0, broken: true };
    }

    const visited = new Set<string>([refId]);
    let current = refId;
    let hops = 0;

    while (true) {
        const ref = refsById.get(current);
        if (!ref) {
            // refsById.has(next) を advance 前に確認しているため理論上は到達しないが、
            // 防御的に broken 扱いで止める。
            return { refId: current, hops, broken: true };
        }
        if (!isLogicallyDeleted(ref)) {
            return { refId: current, hops, broken: false };
        }

        if (hops >= MAX_RESOLVE_HOPS) {
            return { refId: current, hops, broken: true };
        }

        const next = (ref.duplicate_of ?? '').trim();

        if (!refsById.has(next)) {
            return { refId: current, hops, broken: true };
        }
        if (visited.has(next)) {
            return { refId: current, hops, broken: true };
        }

        visited.add(next);
        current = next;
        hops += 1;
    }
}

/**
 * 左右比較で並べる10フィールド（Issue #147 指定）。この順序どおりに diffReferenceFields() が返す。
 */
export const DUPLICATE_REVIEW_COMPARE_FIELDS: readonly (keyof Reference)[] = [
    'title',
    'journal',
    'volume',
    'issue',
    'pages',
    'doi',
    'pmid',
    'year',
    'source',
    'source_file',
];

/** 表示用の文字列へ正規化する。undefined/null は空文字、数値（year等）は String() で文字列化する。 */
function toDisplayValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    return String(value);
}

/**
 * 2件の Reference を DUPLICATE_REVIEW_COMPARE_FIELDS の10フィールドで比較し、全件を
 * その順序どおりに返す（差異のあるものだけに絞らない。UIが「全フィールドを並べて差異だけ
 * 強調」できるようにするため）。
 *
 * differs は表示値を trim してから比較する（undefined・空文字・空白のみは同値扱い）。
 * 大文字小文字は区別する（別表記は差異として見せたい）。title も含めて例外は作らない
 * （正規化タイトルでの一致はマッチキー側（duplicate-detect.ts）の関心であり、ここは
 * 人が目で見る差異を出す層のため）。
 */
export function diffReferenceFields(
    a: Reference,
    b: Reference
): Array<{ field: keyof Reference; valueA: string; valueB: string; differs: boolean }> {
    return DUPLICATE_REVIEW_COMPARE_FIELDS.map((field) => {
        const valueA = toDisplayValue(a[field]);
        const valueB = toDisplayValue(b[field]);
        return {
            field,
            valueA,
            valueB,
            differs: valueA.trim() !== valueB.trim(),
        };
    });
}

/** バケット（Map<key, refId[]>）に1件追加する。先頭（＝入力順で最初に現れた件）を保持する。 */
function addToBucket(buckets: Map<string, string[]>, key: string, refId: string): void {
    const list = buckets.get(key);
    if (list) {
        list.push(refId);
    } else {
        buckets.set(key, [refId]);
    }
}

/**
 * References 全件（論理削除済みも含む）を再スキャンし、重複候補ペアを返す。
 *
 * キーは buildMatchKeys()（duplicate-detect.ts）の4本（pmid/doi/title/trialId）をそのまま使う
 * （キー生成をここで書き直さない）。各キーごとにバケット（Map<key, refId[]>）を作り、
 * バケット内の2件目以降を「バケットの先頭の1件」とペアにする（ref_id_a = 先頭、
 * ref_id_b = 後続）。全組み合わせ C(n,2) を出さない理由: n が大きいとき（同一タイトルの
 * レジストリ登録レコードが多数あるケース等）件数が n^2 で爆発し、レビューUIが実用にならない
 * ため。先頭の1件を「代表」として残りをぶら下げれば、レビューは「代表と各候補を見比べる」
 * 形になり、UI 側でも扱いやすい。
 *
 * ペアの重複排除は normalizePairKey()（duplicate-detect.ts）で行う。優先順位は
 * pmid > doi > trialId > title（duplicate-import-filter.ts が trialId を title より先に
 * 積んでいるのと同じ考え方）。同じ組が複数のキーで一致した場合、強いほうの matchType の
 * バケットを先に処理することで、弱いほうは既出ペアとしてスキップされ、1回だけ返る。
 *
 * matchType が 'trialId' のペアは、source が一致するか否かに関わらず返す（自動適用可否の
 * 判定は isAutoApplicableCandidate() の役割であり、ここでは分類しない）。
 *
 * 論理削除済みの行もここでは除外しない。除外すると、論理削除済み行と3件目の真の重複を
 * 取りこぼす（例: A・B が重複と判断されて B が論理削除された後、C が来て実は A/B/C 全部が
 * 同じ文献だった場合、B を除外すると A-C の一致しか見えず、B-C の関係が消える）。
 * 既に決着した組は filterNewDuplicatePairs()（duplicate-detect.ts）や
 * isPairAlreadySettled()（本ファイル）が別途落とす。
 *
 * 入力順に対して決定的（同じ入力なら常に同じ出力・同じ順序）: Map はキーの挿入順を保持し、
 * 各バケットの配列も push した順（＝入力順）のまま保持されるため。
 */
export function scanReferencesForDuplicatePairs(
    refs: Pick<Reference, 'ref_id' | 'pmid' | 'doi' | 'title' | 'source'>[]
): DuplicateMatch[] {
    const pmidBuckets = new Map<string, string[]>();
    const doiBuckets = new Map<string, string[]>();
    const trialIdBuckets = new Map<string, string[]>();
    const titleBuckets = new Map<string, string[]>();

    for (const ref of refs) {
        const keys = buildMatchKeys(ref);
        if (keys.pmid) addToBucket(pmidBuckets, keys.pmid, ref.ref_id);
        if (keys.doi) addToBucket(doiBuckets, keys.doi, ref.ref_id);
        if (keys.trialId) addToBucket(trialIdBuckets, keys.trialId, ref.ref_id);
        if (keys.title) addToBucket(titleBuckets, keys.title, ref.ref_id);
    }

    const seenPairKeys = new Set<string>();
    const result: DuplicateMatch[] = [];

    const collectFromBuckets = (buckets: Map<string, string[]>, matchType: DuplicateMatchType) => {
        for (const [key, ids] of buckets) {
            if (ids.length < 2) continue;
            const head = ids[0];
            for (let i = 1; i < ids.length; i++) {
                const pairKey = normalizePairKey(head, ids[i]);
                if (seenPairKeys.has(pairKey)) continue;
                seenPairKeys.add(pairKey);
                result.push({ refIdA: head, refIdB: ids[i], matchType, matchKey: key });
            }
        }
    };

    // 優先順位 pmid > doi > trialId > title。強いキーを先に処理することで、
    // 同じ組が複数キーで一致しても強いほうの matchType で1回だけ残る。
    collectFromBuckets(pmidBuckets, 'pmid');
    collectFromBuckets(doiBuckets, 'doi');
    collectFromBuckets(trialIdBuckets, 'trialId');
    collectFromBuckets(titleBuckets, 'title');

    return result;
}

/**
 * Issue #147 の「自動判定ぶん（PMID・検証済みDOI・同一レジストリの試験ID一致）」に対応する。
 *
 * - 'pmid' / 'doi' → 常に true（どちらも検証済みのレコード識別子同士の一致。DOI の形式検証は
 *   normalizeDoi()（duplicate-detect.ts）が済ませている）。
 * - 'trialId' → 両者の source が正規化後（trim + 小文字化）に一致するときだけ true。
 *   duplicate-import-filter.ts の trialId 判定と同じ考え方で、source が食い違うのは
 *   「同じ試験の別レジストリ由来の別レコード」なので人の判断が要る。
 * - 'title' → 常に false（別誌への二重掲載など、どちらを引用するか人の判断が要る）。
 * - refA / refB のどちらかが undefined（行が見つからない）なら false（安全側）。
 *
 * DUPLICATE_CANDIDATES_HEADERS に列を足して source 一致を記録する案は採らない。
 * 列追加はスキーマ変更になるうえ、source は References 側にある値なので、適用時点で
 * References を引き直せば足りる。
 */
export function isAutoApplicableCandidate(
    matchType: DuplicateMatchType,
    refA: Pick<Reference, 'source'> | undefined,
    refB: Pick<Reference, 'source'> | undefined
): boolean {
    if (!refA || !refB) return false;

    switch (matchType) {
        case 'pmid':
        case 'doi':
            return true;
        case 'trialId':
            return normalizeSource(refA.source) === normalizeSource(refB.source);
        case 'title':
            return false;
        default:
            return false;
    }
}

/**
 * 書き込み直前に読み直したデータから、「他のレビュアーが同じ組を先に処理している」ことを
 * 判定する。true ならUI側は書き込まずスキップし「他のレビュアーが処理済み」と表示する。
 *
 * true になる条件（いずれか）:
 * - candidate.status が 'suggested' 以外（既に merged / dismissed になっている）。
 * - どちらかの ref_id が refsById に存在しない（行が消えている＝物理削除された等）。
 * - 両側を resolveSurvivor() で辿った結果が同じ ref_id になる（片方が既にもう片方へ統合された）。
 *
 * 判定の順序が重要: ref_id の存在確認を resolveSurvivor() を呼ぶより先に行う。
 * resolveSurvivor() は「入力の refId 自体が refsById に無い」場合も broken: true を返すが、
 * その broken は「壊れたデータなので settled とみなさない」対象の broken とは意味が違う
 * （行が消えているのは決着の一種として扱ってよいが、生きている行同士の duplicate_of が
 * 循環している・指す先が消えているのは、人が直す機会を残すため settled とみなさない）。
 * そのため、ここでは両 ref_id の存在確認を先に済ませたうえで resolveSurvivor() を呼び、
 * それでも broken が返るケース（循環・duplicate_of の指す先が消えている・深さ上限）は
 * settled とはみなさない（false を返す）。resolveSurvivor() の戻り値だけでは
 * 「top-level が存在しない」ケースと「途中で壊れている」ケースを区別できないため、
 * この判定順序そのものが両者を分ける唯一の手段になっている。
 */
export function isPairAlreadySettled(
    candidate: Pick<DuplicateCandidate, 'ref_id_a' | 'ref_id_b' | 'status'>,
    refsById: Map<string, Pick<Reference, 'ref_id' | 'duplicate_of'>>
): boolean {
    if (candidate.status !== 'suggested') return true;

    if (!refsById.has(candidate.ref_id_a) || !refsById.has(candidate.ref_id_b)) return true;

    const survivorA = resolveSurvivor(candidate.ref_id_a, refsById);
    const survivorB = resolveSurvivor(candidate.ref_id_b, refsById);

    if (survivorA.broken || survivorB.broken) return false;

    return survivorA.refId === survivorB.refId;
}

/**
 * 一括適用でどちらを残すか決める。判定数が多い側を残す。同数なら refIdA（先に存在していた側）
 * を残す。
 *
 * 理由: 判定（Decisions）は ref_id で紐づくだけなので、判定が付いている側を消すとその判定が
 * 宙に浮く。個別レビューでは警告を出して人に確認させるが、一括適用は無人で走るため、
 * 判定を宙に浮かせない側を機械的に選ぶ。
 */
export function chooseKeptRefId(
    refIdA: string,
    refIdB: string,
    decisionCountA: number,
    decisionCountB: number
): { keptRefId: string; removedRefId: string } {
    if (decisionCountB > decisionCountA) {
        return { keptRefId: refIdB, removedRefId: refIdA };
    }
    return { keptRefId: refIdA, removedRefId: refIdB };
}
