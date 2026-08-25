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
 * ある文献に対する「自分以外」のフルテキスト判定を、レビュアーごとに最新1件へ畳み込んで返す。
 *
 * - `keyOpened === false`（Blind中）は常に空配列。sheets-api の filterDecisionsForBlind() が
 *   他レビュアーの票をそもそもクライアントへ渡さないが、UI側でも同じ線引きを持たせる（多層防御）。
 * - AI票（`llm:`）は判定パネル上部のAI判定サマリで別に出しているため除外する。
 * - 裁定票（`adjudication:`）は「不一致がどう解消されたか」を示すので含める。
 * - 並び順は 通常の判定者 → 裁定票、各グループ内は reviewer_id 昇順（表示を安定させるため）。
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
    for (const d of decisions) {
        if (d.ref_id !== refId) continue;
        if ((d.screening_phase ?? 'tiab') !== 'fulltext') continue;
        const reviewerId = (d.reviewer_id || '').trim();
        if (!reviewerId || reviewerId === normalizedEmail) continue;
        if (reviewerId.startsWith('llm:')) continue;
        const existing = latestByReviewer.get(reviewerId);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            latestByReviewer.set(reviewerId, d);
        }
    }

    return [...latestByReviewer.values()].sort((a, b) => {
        const aKey = a.reviewer_id || '';
        const bKey = b.reviewer_id || '';
        const aAdj = isAdjudicationKey(aKey) ? 1 : 0;
        const bAdj = isAdjudicationKey(bKey) ? 1 : 0;
        if (aAdj !== bAdj) return aAdj - bAdj;
        return aKey.localeCompare(bKey);
    });
}

/** メールアドレスのローカル部（`@` より前）。`@` が無ければそのまま返す */
export function localPartOf(email: string): string {
    const atIndex = email.indexOf('@');
    return atIndex > 0 ? email.slice(0, atIndex) : email;
}

/**
 * 他レビュアー行の表示名。
 * 通常の判定者はメールのローカル部だけを出す（サイドパネルの getReviewerLabel() と同じ方針）。
 * 裁定票はサイドパネルの表記（`reviewer_adjudication` = 「⚖ 裁定（email）」）に合わせる。
 * ここで t() を使わないのは、この画面が i18n を経由しない日本語固定のUIのため
 * （fulltext.html のラベルも日本語直書き）。
 */
export function otherReviewerLabel(reviewerId: string, userEmail: string): string {
    if (isAdjudicationKey(reviewerId)) {
        const email = adjudicationEmail(reviewerId);
        return `⚖ 裁定（${email === (userEmail || '').trim() ? '自分' : localPartOf(email)}）`;
    }
    return localPartOf(reviewerId);
}
