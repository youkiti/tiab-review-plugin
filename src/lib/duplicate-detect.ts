// duplicate-detect.ts
// 取り込み時の重複検出（作り直し、Issue #145）で使う純関数層。UI 非依存。
// 既存の generateDedupeKey()（src/lib/import-helpers.ts）は PMID > DOI > 正規化タイトルの
// カスケードでキーを1本しか持たないため、「片方にだけDOIがある」ケースを取りこぼす。
// ここでは PMID・DOI・タイトルの3本のキーを別々に持たせ、判定側（duplicate-import-filter.ts）で
// OR 判定できるようにする。normalizeTitle() の挙動は変更しない（呼ぶだけ）。

import type { Reference, DuplicateCandidate } from './types';
import { normalizeTitle } from './import-helpers';
import { stripDoiPrefix } from './doi';

export type DuplicateMatchType = 'pmid' | 'doi' | 'title' | 'trialId';

/**
 * 重複と判定された2件の組。タイトル一致は取り込みをスキップしない方針のため、
 * 「レビュー候補ペア」としてこの形で記録する（消費する画面は後続で実装する重複レビューUI、Issue #145 チャンク3）。
 */
export interface DuplicateMatch {
    refIdA: string;          // 先に存在していた側
    refIdB: string;          // 後から来た側
    matchType: DuplicateMatchType;
    matchKey: string;        // 一致したキーの値（正規化後）
}

const DOI_SHAPE_RE = /^10\.\d{4,9}\/\S+$/;

/**
 * DOI を正規化する。接頭辞剥がしは `src/lib/doi.ts` の `stripDoiPrefix()` に委譲し
 * （`doi.org`・`dx.doi.org`・`http`/`https`・`doi:` の表記ゆれをまとめて剥がす）、
 * ここでは剥がした値が `/^10\.\d{4,9}\/\S+$/` の形になっているか検証する。
 * 形が合わない値（例: DOI欄に論文番号 `e98323` が入っている実データのケース）は
 * DOI として信用せず undefined を返す。将来的に壊れた値どうしが偶然一致して
 * 別論文を誤マージすることを防ぐための検証。
 */
export function normalizeDoi(doi?: string): string | undefined {
    if (!doi) return undefined;
    const trimmed = doi.trim();
    if (!trimmed) return undefined;

    const value = stripDoiPrefix(trimmed);
    return DOI_SHAPE_RE.test(value) ? value : undefined;
}

// 数字のみなら実PMID、それ以外の非空値は試験IDとみなす（消去法の判定）。
// NCT・CTRI・jRCT・UMIN など試験IDの形式はレジストリごとにバラバラで、すべてを列挙して
// 判定すると未知のレジストリ形式を取りこぼす。実PMIDが常に数字のみである（PubMedのID体系）
// ことのほうが確実に言えるため、「数字のみでなければ試験ID」の向きで判定する。
const NUMERIC_ONLY_RE = /^\d+$/;

/**
 * 1件の Reference から、重複判定に使う4本のキー（pmid/trialId/doi/title）を作る。
 * どれも「値を持っていればそのキーを設定し、無ければ未設定（undefined）」で返す。
 *
 * pmid/trialId の振り分けが要る理由: 試験登録レコード（CTG/ICTRP パーサ由来）は
 * Reference.pmid フィールドに試験ID（例: NCT04145011, CTRI/2024/01/012345）を格納している
 * （src/lib/ctg-parser.ts の `pmid: nctNumber`、src/lib/ictrp-parser.ts の
 * `pmid: trialId || undefined` 参照）。試験IDは「研究」の識別子であって「レコード」の
 * 識別子ではない ―― ひとつの試験には試験登録・プロトコル論文・本論文・学会抄録・二次解析が
 * ぶら下がり、それらは全部同じ試験IDを共有する。この値をそのまま pmid キーとして
 * 確認なしの自動スキップに使うと、別レジストリ経由で取り込んだ同一試験の登録レコード
 * （例: ClinicalTrials.gov 由来と ICTRP 経由の CTRI 由来）が、シート上に痕跡を残さず
 * 捨てられてしまう。そのため pmid フィールドの値が数字のみ（実PMIDの形）のときだけ pmid
 * キーとして扱い、それ以外は trialId キーに振り分ける。trialId 一致の扱い（source が
 * 一致するときだけ自動スキップ）は duplicate-import-filter.ts 側で判定する。
 *
 * PMID/試験IDは trim のみ（publication-suggest.ts の流儀に合わせる）、DOI は normalizeDoi()、
 * タイトルは既存の normalizeTitle()（再実装しない）。
 */
export function buildMatchKeys(
    ref: Pick<Reference, 'pmid' | 'doi' | 'title'>
): { pmid?: string; trialId?: string; doi?: string; title?: string } {
    const rawPmid = ref.pmid?.trim() || undefined;
    const pmid = rawPmid && NUMERIC_ONLY_RE.test(rawPmid) ? rawPmid : undefined;
    const trialId = rawPmid && !NUMERIC_ONLY_RE.test(rawPmid) ? rawPmid : undefined;
    const doi = normalizeDoi(ref.doi);
    const normalizedTitle = ref.title ? normalizeTitle(ref.title) : '';
    const title = normalizedTitle || undefined;

    return { pmid, trialId, doi, title };
}

/**
 * 2つの ref_id を辞書順にソートして組キーを作る。順序違い（A→B で見つけた組と B→A で
 * 見つけた組）が別扱いにならないようにするためのキー。重複候補を永続化するタブ（Issue #145 チャンク2）で、
 * 同じ組が2回登録されないようにする用途を想定している。
 */
export function normalizePairKey(a: string, b: string): string {
    const [small, large] = [a, b].sort();
    return `${small}::${large}`;
}

/**
 * References の1行が、重複として論理削除済みかどうかを判定する（Issue #145 チャンク2）。
 * `duplicate_of`（trim後）が非空なら true。空文字・空白のみ・未設定は false。
 *
 * 除外は物理削除ではなく論理削除で行う（行は残す。値には残す側の ref_id を書く）。
 * この判定ロジックは必ずこの関数を経由すること。`ref.duplicate_of` を直接見る分岐を
 * 呼び出し元ごとに書くと、同じ判断のコピーが散って片方だけ直す事故が起きる。
 */
export function isLogicallyDeleted(ref: Pick<Reference, 'duplicate_of'>): boolean {
    return (ref.duplicate_of || '').trim() !== '';
}

/**
 * source（レジストリ名）の比較用正規化。trim + 小文字化。未設定は空文字として扱う。
 *
 * 取り込み時の自動スキップ判定（duplicate-import-filter.ts の trialId 一致判定）と
 * 重複レビューの自動適用判定（duplicate-review.ts の isAutoApplicableCandidate()）が
 * 同じ正規化を使う必要があるため、ここに一元化する。isLogicallyDeleted() と同じ理由で、
 * 呼び出し元ごとに同じ実装をコピーすると、片方だけ直す事故が起きる。
 */
export function normalizeSource(source: string | undefined): string {
    return source?.trim().toLowerCase() ?? '';
}

/**
 * Duplicate_Candidates タブへ既に記録済みの組（重複ペア）を除外する。
 * `saveDuplicateCandidates()`（src/lib/sheets/duplicate-candidates.ts）が保存直前に使う（Issue #145 チャンク2）。
 *
 * publication-suggest.ts の filterNewCandidates() との決定的な違い: あちらのキーは ref_id 1本
 * だが、こちらはキーが「2つの ref_id の組」であり、順序が逆（A→B で記録済みの組を B→A で
 * 再度検出した場合）でも同じ組として扱わなければならない。normalizePairKey() が
 * ref_id を辞書順にソートしてから連結するため、順序に関わらず同じキーになる（別のキー生成を
 * ここで新たに書かない）。
 *
 * status は見ない。'dismissed'（別々の文献だと人が決めた）や 'merged'（統合済み）になった組も
 * 「既出」として弾く。一度決着した組を再スキャンのたびに再提示しないことが、この関数の存在理由
 * そのもの（Issue #145 の課題そのもの）。
 *
 * incoming 内での重複（同じ組が2回検出されるケース）も、既出セットへ検出しながら追加していく
 * ことで1回だけ返す。取り込み側（duplicate-import-filter.ts）が「最後に一括で既存キーと突き合わせ、
 * バッチ内で新しく追加されたキーに気付かない」バグを踏んだ前例があるため、同じ形にしない。
 */
export function filterNewDuplicatePairs(
    existing: Pick<DuplicateCandidate, 'ref_id_a' | 'ref_id_b'>[],
    incoming: DuplicateMatch[]
): DuplicateMatch[] {
    const seenPairKeys = new Set<string>();
    for (const e of existing) {
        seenPairKeys.add(normalizePairKey(e.ref_id_a, e.ref_id_b));
    }

    const result: DuplicateMatch[] = [];
    for (const match of incoming) {
        const pairKey = normalizePairKey(match.refIdA, match.refIdB);
        if (seenPairKeys.has(pairKey)) continue;
        seenPairKeys.add(pairKey);
        result.push(match);
    }
    return result;
}
