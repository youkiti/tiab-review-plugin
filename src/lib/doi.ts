/**
 * DOI 文字列の表記ゆれを剥がす純関数。UI 非依存。
 *
 * `src/lib/duplicate-detect.ts` の `normalizeDoi()`（検証あり、形が合わなければ undefined）と
 * `src/lib/pdf-title-match.ts` の `normalizeDoiForCompare()`（検証なし、常に文字列を返す）が
 * それぞれ独自の接頭辞剥がし正規表現を持っていた（PR #146 レビュー指摘）。
 * 一方だけが `http://doi.org/` と `https://dx.doi.org/` を扱えず、生DOIとの一致を
 * 取りこぼすバグが発生した。同じ正規表現を2箇所に持たせると「片方だけ古い」が再発するため、
 * ここへ一元化する。
 */

// doi.org / dx.doi.org（http/https 両方）、doi: 接頭辞を剥がす。小文字化した値に対して適用する。
const DOI_PREFIX_RE = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)/;

/**
 * DOI の表記ゆれ（doi.org / dx.doi.org / http / https / `doi:` 接頭辞）を剥がして
 * 小文字化する。検証はしない — 形が合わない値（DOIでない文字列）もそのまま返す。
 *
 * 呼び出し側の契約:
 * - `duplicate-detect.ts` の `normalizeDoi()` はこの関数を呼んだ後、`DOI_SHAPE_RE`
 *   （`^10\.\d{4,9}\/\S+$`）で検証し、形が合わなければ `undefined` を返す。
 * - `pdf-title-match.ts` の `normalizeDoiForCompare()` は検証をせず、この関数の
 *   戻り値をそのまま比較に使う（ファイル名から抽出した DOI 候補は既に
 *   `DOI_PATTERN` で緩く絞り込まれているため）。
 */
export function stripDoiPrefix(doi: string): string {
    return doi.trim().toLowerCase().replace(DOI_PREFIX_RE, '').trim();
}
