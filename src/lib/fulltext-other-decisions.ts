/**
 * フルテキスト判定画面（PDFウィンドウ）で「他レビュアーの判定」を出すための選別ロジック。
 *
 * 純関数のみで構成する（`chrome` API や DOM を import しないこと）。
 * fulltext.ts はページ状態（allDecisions / userEmail / keyOpened）を渡して呼ぶだけにし、
 * ブラインドの線引きと最新判定の畳み込みはここでテストできるようにする。
 */
import type { Decision } from './types';
import { isAdjudicationKey, adjudicationEmail } from './fulltext-consensus';

/**
 * ある文献に対する「自分以外」のフルテキスト判定を、判定者ごとに最新1件へ畳み込んで返す。
 *
 * - `keyOpened === false`（Blind中）は常に空配列。sheets/decisions.ts の filterDecisionsForBlind() が
 *   他レビュアーの票をそもそもクライアントへ渡さないが、UI側でも同じ線引きを持たせる（多層防御）。
 * - AI票（`llm:`）は判定パネル上部のAI判定サマリで別に出しているため除外する。
 * - 通常の判定者は reviewer_id ごとに最新1件。
 * - 裁定票（`adjudication:`）は reviewer_id（＝裁定者）ごとではなく、**裁定票全体を1つのグループ**
 *   として畳み、`decided_at` が最新の1件だけを返す。`fulltext-consensus.ts` の
 *   `computeFulltextConsensus()` と同じ「裁定票のうち decidedAt が最も新しいものを最終とする」
 *   規則に合わせている（裁定者が複数いても最終裁定は常に1件のはずなので、reviewer_id ごとに
 *   畳むと相反する裁定が2行並んでしまい、どちらが最終結果か判別できなくなるため）。
 * - 並び順は 通常の判定者（reviewer_id 昇順） → 裁定票（1件のみ）。
 */
export function selectOtherFulltextDecisions(
    decisions: Decision[],
    refId: string,
    userEmail: string,
    keyOpened: boolean
): Decision[] {
    if (!keyOpened) return [];

    const normalizedEmail = (userEmail || '').trim();
    const latestByReviewer = new Map<string, Decision>();
    let latestAdjudication: Decision | null = null;
    for (const d of decisions) {
        if (d.ref_id !== refId) continue;
        if ((d.screening_phase ?? 'tiab') !== 'fulltext') continue;
        const reviewerId = (d.reviewer_id || '').trim();
        if (!reviewerId || reviewerId === normalizedEmail) continue;
        if (reviewerId.startsWith('llm:')) continue;

        if (isAdjudicationKey(reviewerId)) {
            if (!latestAdjudication || (d.decided_at || '') > (latestAdjudication.decided_at || '')) {
                latestAdjudication = d;
            }
            continue;
        }

        const existing = latestByReviewer.get(reviewerId);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            latestByReviewer.set(reviewerId, d);
        }
    }

    const regular = [...latestByReviewer.values()].sort((a, b) =>
        (a.reviewer_id || '').localeCompare(b.reviewer_id || '')
    );
    return latestAdjudication ? [...regular, latestAdjudication] : regular;
}

/**
 * 他レビュアー行の表示名。
 * 通常の判定者は reviewer_id（完全なメールアドレス）をそのまま出す。同名でもドメインが
 * 異なるレビュアー（例: alex@hospital-a.example / alex@hospital-b.example）を取り違えないため
 * （サイドパネルの getReviewerLabel() も通常レビュアーには完全なメールアドレスを使っている）。
 * 裁定票はサイドパネルの表記（`reviewer_adjudication` = 「⚖ 裁定（email）」）に合わせる。
 * ここで t() を使わないのは、この画面が i18n を経由しない日本語固定のUIのため
 * （fulltext.html のラベルも日本語直書き）。
 */
export function otherReviewerLabel(reviewerId: string, userEmail: string): string {
    if (isAdjudicationKey(reviewerId)) {
        const email = adjudicationEmail(reviewerId);
        return `⚖ 裁定（${email === (userEmail || '').trim() ? '自分' : email}）`;
    }
    return reviewerId;
}
