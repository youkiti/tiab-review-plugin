/**
 * pdf-title-match.ts - Driveから取り込むPDFのファイル名からReference候補を推定する
 *
 * V1ではPDF本文を読まず、ファイル名のみでスコアリングする
 * （V2でPDF本文抽出によるタイトル/DOI検出を予定。AGENTS.md / pdf-import-plan.md 参照）。
 * - 正規化: Unicode NFKC → 小文字化 → 記号除去 → 空白圧縮
 * - DOI抽出: ファイル名に埋め込まれたDOI（`10.xxxx/...`）があれば最優先でReference.doiと突き合わせる
 * - スコア: タイトルの単語トークンのうち、ファイル名側にも現れる割合（タイトル側を分母にする。
 *   ファイル名は "[著者名, 年] タイトル.pdf" のように前後へ識別子が付きやすいため、
 *   ファイル名側を分母にすると正しいタイトルでも一致率が不当に下がってしまう）
 */

import { stripDoiPrefix } from './doi';

/** DOIの一般的なパターン（プレフィックス10.NNNN以上 + サフィックス）。末尾の記号は呼び出し側で削る。 */
const DOI_PATTERN = /10\.\d{4,}\/\S+/;

/** 提案をデフォルト選択とみなす最低スコア（0〜1）。未満は「未選択」のまま提示する。 */
export const MATCH_SCORE_THRESHOLD = 0.6;

/**
 * 文字列をマッチング用に正規化する。
 * Unicode NFKC → 小文字化 → 文字・数字以外を空白化 → 連続空白を1つに圧縮。
 */
export function normalizeForMatch(input: string): string {
    return input
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * ファイル名に埋め込まれたDOIを抽出する（見つからなければ null）。
 * 拡張子 .pdf は事前に取り除き、末尾に付きがちな括弧・句読点を削る。
 */
export function extractDoiFromFilename(filename: string): string | null {
    const withoutExt = filename.replace(/\.pdf$/i, '');
    const match = DOI_PATTERN.exec(withoutExt);
    if (!match) return null;
    return match[0].replace(/[)\]},.;]+$/, '');
}

/**
 * DOI比較用の正規化（doi.org / dx.doi.org / http / https / `doi:` 接頭辞の除去・小文字化）。
 * 接頭辞剥がしは `src/lib/doi.ts` の `stripDoiPrefix()` に委譲する（検証はしない契約はそのまま
 * 維持する。ファイル名から抽出したDOI候補は `DOI_PATTERN` で既に緩く絞り込まれているため）。
 */
function normalizeDoiForCompare(doi: string): string {
    return stripDoiPrefix(doi);
}

function tokenize(normalized: string): Set<string> {
    return new Set(normalized.split(' ').filter(tok => tok.length >= 2));
}

/**
 * ファイル名とタイトルのトークン重複率を 0〜1 で返す。
 * タイトル側のトークン数を分母にする（理由は本ファイル冒頭コメント参照）。
 */
export function titleSimilarityScore(filename: string, title: string): number {
    const fileTokens = tokenize(normalizeForMatch(filename.replace(/\.pdf$/i, '')));
    const titleTokens = tokenize(normalizeForMatch(title));
    if (fileTokens.size === 0 || titleTokens.size === 0) return 0;

    let overlap = 0;
    for (const tok of titleTokens) {
        if (fileTokens.has(tok)) overlap += 1;
    }
    return overlap / titleTokens.size;
}

export interface MatchTarget {
    ref_id: string;
    title?: string;
    doi?: string;
}

export interface MatchCandidate {
    ref_id: string;
    score: number;
    matchedByDoi: boolean;
}

/**
 * ファイル名から最も一致度の高いReference候補を推定する。
 * ファイル名にDOIが埋め込まれ、候補群のいずれかのDOIと完全一致すれば最優先で採用する（score=1）。
 * それ以外はタイトルのトークン重複率が最大の候補を返し、MATCH_SCORE_THRESHOLD未満ならnull（未選択）。
 */
export function findBestMatch(filename: string, candidates: MatchTarget[]): MatchCandidate | null {
    const doi = extractDoiFromFilename(filename);
    if (doi) {
        const normDoi = normalizeDoiForCompare(doi);
        const doiHit = candidates.find(c => c.doi && normalizeDoiForCompare(c.doi) === normDoi);
        if (doiHit) return { ref_id: doiHit.ref_id, score: 1, matchedByDoi: true };
    }

    let best: MatchCandidate | null = null;
    for (const c of candidates) {
        if (!c.title) continue;
        const score = titleSimilarityScore(filename, c.title);
        if (!best || score > best.score) {
            best = { ref_id: c.ref_id, score, matchedByDoi: false };
        }
    }
    return best && best.score >= MATCH_SCORE_THRESHOLD ? best : null;
}
