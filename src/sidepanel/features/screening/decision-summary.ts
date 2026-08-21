/**
 * チーム判定サマリー（エクスポート用）
 *
 * TiAb エクスポート（CSV/RIS）に「誰が何と判定したか」を出すための集計ロジック。
 * `ref.status`（`src/lib/sheets-api.ts` の `detectConflict()`、判定1件のみでも
 * conflict 扱いになる旧定義）とは別に、判定人数を考慮した `team_status` を計算する。
 *
 * 純関数のみで構成する（`../../state` / `../../dom` を import しないこと）。
 * テストから state/dom 抜きで直接検証できるようにするための制約。
 * 必要な値（有効レビュアー集合・ML同一視設定など）はすべて引数で受け取る。
 */
import type { Decision, ReferenceWithStatus } from '../../../lib/types';
import { computeReviewerKey, detectConflictWithSettings } from '../../render/helpers';

export type TeamStatus = 'include' | 'exclude' | 'maybe' | 'conflict' | 'incomplete' | 'pending' | 'blinded';

/**
 * レビュアーキーのグループ順（人間 → ML(::ml) → AI(llm:)）
 */
function reviewerGroupOrder(key: string): number {
    if (key.startsWith('llm:')) return 2;
    if (key.endsWith('::ml')) return 1;
    return 0;
}

function sortReviewerKeys(keys: string[]): string[] {
    return [...keys].sort((a, b) => {
        const ga = reviewerGroupOrder(a);
        const gb = reviewerGroupOrder(b);
        if (ga !== gb) return ga - gb;
        return a.localeCompare(b);
    });
}

/**
 * エクスポートに出すレビュアー列のキー一覧を計算する。
 * 人間 → ML(`email::ml`) → AI(`llm:`) の順、各グループ内はキー昇順。
 *
 * - 全 ref の allDecisions を走査し computeReviewerKey でキー化する（空キーは無視）。
 * - enabledReviewers に含まれるキーだけを採用する。
 * - ただし積が空になった場合は全キーにフォールバックする
 *   （fulltext-results.ts の effectiveJudges() と同じ安全弁。最小1人を保証する）。
 */
export function collectReviewerKeys(
    refs: ReferenceWithStatus[],
    enabledReviewers: Set<string>,
    treatMlAsManual: boolean
): string[] {
    const allKeys = new Set<string>();
    for (const ref of refs) {
        for (const d of ref.allDecisions || []) {
            const key = computeReviewerKey(d, treatMlAsManual);
            if (key) allKeys.add(key);
        }
    }

    const filtered = [...allKeys].filter(k => enabledReviewers.has(k));
    const effective = filtered.length > 0 ? filtered : [...allKeys];
    return sortReviewerKeys(effective);
}

/**
 * 1文献のレビュアーキー → 有効な最新判定 のマップを作る。
 *
 * - allDecisions を computeReviewerKey でキー化し、enabledReviewers に含まれるものだけ採用する
 *   （フォールバック済みの実効レビュアー集合を呼び出し側から渡すこと）。
 * - 同一キーに複数判定がある場合（Decisions は追記専用）は decided_at が最大のものを採用する。
 * - 採用した最新判定の decision が 'pending' または空文字の場合は、未判定として map に入れない
 *   （sheets-api.ts の getReferencesWithAllDecisions と同じ扱い）。
 */
export function buildReviewerDecisionMap(
    ref: ReferenceWithStatus,
    enabledReviewers: Set<string>,
    treatMlAsManual: boolean
): Map<string, Decision> {
    const latestByKey = new Map<string, Decision>();
    for (const d of ref.allDecisions || []) {
        const key = computeReviewerKey(d, treatMlAsManual);
        if (!key || !enabledReviewers.has(key)) continue;
        const existing = latestByKey.get(key);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            latestByKey.set(key, d);
        }
    }

    const result = new Map<string, Decision>();
    for (const [key, d] of latestByKey) {
        if (!d.decision || d.decision === 'pending') continue; // 未判定として除外
        result.set(key, d);
    }
    return result;
}

/**
 * team_status と判定人数を計算する。
 *
 * | 条件                                       | teamStatus  |
 * |---------------------------------------------|-------------|
 * | reviewerKeys.length === 0 または nJudged===0 | pending     |
 * | nJudged < reviewerKeys.length                | incomplete  |
 * | 判定値が2種類以上                            | conflict    |
 * | 上記以外（全員一致）                         | その判定値  |
 *
 * `blinded` はここでは返さない（呼び出し側がブラインド時に使う）。
 *
 * `reviewerKeys` は collectReviewerKeys() の戻り値（enabledReviewers との積、フォールバック
 * 込みで解決済み）を渡すこと。このマップの実効レビュアー集合は reviewerKeys 自体から作る
 * （生の enabledReviewers で再フィルタすると、collectReviewerKeys がフォールバックした場合に
 * 判定が実際にはあるのに 0 人扱いになってしまうため）。
 */
export function summarizeTeamDecision(
    ref: ReferenceWithStatus,
    reviewerKeys: string[],
    treatMlAsManual: boolean
): { teamStatus: TeamStatus; nJudged: number; byReviewer: Map<string, Decision> } {
    // reviewerKeys が既にフォールバック込みの実効集合のため、こちらから実効レビュアー集合を作る
    const effectiveReviewers = new Set(reviewerKeys);
    const byReviewer = buildReviewerDecisionMap(ref, effectiveReviewers, treatMlAsManual);
    const nJudged = byReviewer.size;

    if (reviewerKeys.length === 0 || nJudged === 0) {
        return { teamStatus: 'pending', nJudged, byReviewer };
    }
    if (nJudged < reviewerKeys.length) {
        return { teamStatus: 'incomplete', nJudged, byReviewer };
    }

    const uniqueDecisions = new Set([...byReviewer.values()].map(d => d.decision));
    if (uniqueDecisions.size > 1) {
        return { teamStatus: 'conflict', nJudged, byReviewer };
    }

    const only = [...uniqueDecisions][0] as TeamStatus;
    return { teamStatus: only, nJudged, byReviewer };
}

/**
 * 票のメモ表示用テキスト。LLM判定の note は evidence 等を含む JSON 文字列
 * （FulltextLlmDecisionNote）のため、そのまま出すとJSONが丸見えになる。
 * その場合は人間可読な reason フィールドだけを取り出す。パース失敗時は生テキストにフォールバックする。
 *
 * （`fulltext-results.ts` から移設。挙動は変えていない）
 */
export function voteNoteText(judge: string, note: string | undefined): string {
    if (!note) return '';
    if (judge.startsWith('llm:') && note.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(note);
            if (typeof parsed.reason === 'string' && parsed.reason.trim()) return parsed.reason;
        } catch {
            // JSON以外・想定外の形の note はそのまま表示にフォールバックする
        }
    }
    return note;
}

/**
 * 全判定者の理由・メモを1列にまとめる。
 * reviewerKeys の順に `key: [reason] メモ本文` を ' / ' で連結する。
 * reason・メモ本文がどちらも空の判定はスキップする。
 */
export function formatDecisionNotes(byReviewer: Map<string, Decision>, reviewerKeys: string[]): string {
    const parts: string[] = [];
    for (const key of reviewerKeys) {
        const d = byReviewer.get(key);
        if (!d) continue;

        const noteText = voteNoteText(key, d.note);
        let text = '';
        if (d.reason && d.reason.trim()) {
            text += `[${d.reason}] `;
        }
        text += noteText;
        text = text.trim();
        if (!text) continue;

        parts.push(`${key}: ${text}`);
    }
    return parts.join(' / ');
}
