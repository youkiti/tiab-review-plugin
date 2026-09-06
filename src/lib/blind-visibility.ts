/**
 * ブラインド中に判定を表示してよいかどうかの述語。
 *
 * 純関数のみで構成する（`chrome` API や DOM を import しないこと）。
 * `src/lib/sheets/decisions.ts` の `filterDecisionsForBlind()` と
 * `src/fulltext/fulltext.ts`（PDF判定画面）の両方から同じポリシーで判定できるよう、
 * ここへ一元化する（ポリシーの定義が2か所に分かれるのを避けるため）。
 */
import type { Decision } from './types';

/**
 * ブラインド中（keyOpened === false）でもこの判定を表示してよいか。
 * 「自分自身の判定」または「AI（`llm:` プレフィックス）の判定」だけ true になる。
 * `userEmail` との比較は前後の空白を trim してから行う。
 */
export function isDecisionVisibleDuringBlind(decision: Decision, userEmail: string): boolean {
    const reviewerId = (decision.reviewer_id || '').trim();
    const normalizedEmail = (userEmail || '').trim();
    return reviewerId === normalizedEmail || reviewerId.startsWith('llm:');
}
