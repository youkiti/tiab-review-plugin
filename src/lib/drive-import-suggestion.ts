/**
 * drive-import-suggestion.ts - 「Driveへ直接置かれたPDFの取り込み」対応付けモーダルの
 * 既定値（プリセット）を決める判定（純関数）
 *
 * 背景（Phase 1 の既知の問題。根本原因の修正は Phase 2 で別途行う）:
 * OAuth スコープが drive.file のため、共同研究者からは他人が確保した cached コピーが
 * Drive API 越しには見えない（files.list が HTTP 200 + 空配列を返す）。そのため
 * classifyImportState() は他人が既に取り込んだPDFでも「未取り込み(none)」を返す。
 * 呼び出し側は対応付け候補（mappableRefs）を cached を除外して作るため、本来対応付ける
 * べき cached 済み文献が候補から外れており、その状態でファイル名マッチの findBestMatch
 * （pdf-title-match.ts）が走ると、別の似たタイトルの未取り込み文献をスコア0.6以上で拾って
 * 既定値にプリセットしてしまう（気付かず実行すると別文献へ誤って対応付けられる）。
 *
 * ここでは findBestMatch を cached も含めた全 targets に対して実行し直し、最良マッチが
 * 本来の対応付け先である cached 済み文献であれば、既定値をプリセットせず「他のメンバーが
 * 取り込み済みの可能性がある」旨だけを呼び出し側（fulltext-drive-import.ts）へ伝える
 * （kind: 'likely-imported'）。
 *
 * さらに、同一タイトルの重複文献（AGENTS.md記載のとおり、重複解決は手動のため実在しうる）が
 * 「cached済みの1行」と「未取り込みの1行」に分かれているケースでは、findBestMatch が同スコア
 * なら targets 配列で先に来た方（＝シートの行順）を返してしまう。行順次第で未取り込み側が
 * 既定値としてプリセットされるのを避けるため、cached だけを対象に findBestMatch を取り直し、
 * 全体の最良マッチと同格（同スコア・DOI一致かどうかも一致）なら cached 側を優先する。
 * 副作用を持たないため node:test で網羅的に検証できる。
 */

import { findBestMatch } from './pdf-title-match';
import type { MatchTarget } from './pdf-title-match';

export interface MappingSuggestionTarget {
    ref_id: string;
    title?: string;
    doi?: string;
    /** fulltext_status === 'cached'（Driveに確保済み） */
    isCached: boolean;
    /** 対応付けドロップダウンに出る候補か（担当内 かつ 非cached） */
    isMappable: boolean;
}

export type MappingSuggestion =
    | { kind: 'suggest'; refId: string }
    | { kind: 'likely-imported'; refId: string; title: string }
    | { kind: 'none' };

/**
 * ファイル名から対応付けモーダルの既定値を提案する。
 *
 * 1. findBestMatch を cached も含む全 targets に対して実行する
 * 2. マッチ無し（null）→ 'none'
 * 3. cached だけを対象に findBestMatch を取り直し、全体の最良マッチと同格（スコア以上・
 *    DOI一致かどうかも一致）なら cached 側を優先する（同一タイトルの重複行対策。詳細は
 *    本ファイル冒頭コメント参照）→ 'likely-imported'
 * 4. マッチした文献がドロップダウンに出せる候補（isMappable）→ 'suggest'（従来どおり既定値にする）
 * 5. マッチした文献が cached 済み → 'likely-imported'（既定値はプリセットしない。titleが空ならref_idを入れる）
 * 6. それ以外（cachedでもmappableでもない＝担当外の未取り込み文献など、選択不能）→ 'none'
 */
export function resolveMappingSuggestion(
    fileName: string,
    targets: MappingSuggestionTarget[]
): MappingSuggestion {
    const matchTargets: MatchTarget[] = targets.map(t => ({ ref_id: t.ref_id, title: t.title, doi: t.doi }));
    const match = findBestMatch(fileName, matchTargets);
    if (!match) return { kind: 'none' };

    // findBestMatch は同スコアなら配列で先に来た方を返すため、シートの行順によって
    // 「重複文献のうち未取り込みの方」が勝ってしまう。既定値を出さない側へ倒すのが
    // 安全なので、cached だけを対象に取り直して同格なら cached を優先する。
    // DOI一致はタイトル一致より強い根拠なので、matchedByDoi が食い違う場合は同格とみなさない。
    const cachedMatchTargets = matchTargets.filter((_, i) => targets[i].isCached);
    const cachedBest = findBestMatch(fileName, cachedMatchTargets);
    const cachedWins = cachedBest !== null
        && cachedBest.matchedByDoi === match.matchedByDoi
        && cachedBest.score >= match.score;

    if (cachedWins) {
        const cachedTarget = targets.find(t => t.ref_id === cachedBest!.ref_id);
        return { kind: 'likely-imported', refId: cachedBest!.ref_id, title: cachedTarget?.title || cachedBest!.ref_id };
    }

    const target = targets.find(t => t.ref_id === match.ref_id);
    if (target?.isMappable) return { kind: 'suggest', refId: match.ref_id };
    if (target?.isCached) {
        return { kind: 'likely-imported', refId: match.ref_id, title: target.title || target.ref_id };
    }
    return { kind: 'none' };
}
