/**
 * 描画ヘルパー関数
 * レビュアーキー算出・判定フィルタ・コンフリクト判定の共通処理
 */

import { isMlDecision, isConfirmedMlDecision } from '../../lib/client-version';

/**
 * Decision から reviewer の集約キーを計算する。
 * `availableReviewers` / `enabledReviewers` に格納されているキーと一致する。
 * - LLM: `reviewer_id` をそのまま
 * - 人間 manual: email
 * - 人間 ML 確認済み: treatMlAsManual=true なら email、false なら `email::ml`
 * - 人間 ML auto: `email::ml`
 */
export function computeReviewerKey(
    decision: import('../../lib/types').Decision,
    treatMlAsManual: boolean
): string {
    const reviewerId = (decision.reviewer_id || '').trim();
    if (!reviewerId) return '';
    if (reviewerId.startsWith('llm:')) return reviewerId;
    if (treatMlAsManual && isConfirmedMlDecision(decision.client_version)) {
        return reviewerId;
    }
    if (isMlDecision(decision.client_version)) return `${reviewerId}::ml`;
    return reviewerId;
}

/**
 * 有効なレビュアーの判定のみを返す。
 * Blind ON（`isKeyOpened=false`）時は全件返す（reviewer フィルター無効化）。
 * Blind OFF 時は `enabledReviewers` に含まれるキーの判定のみ返す。
 */
export function filterEnabledDecisions(
    decisions: import('../../lib/types').Decision[] | undefined,
    enabledReviewers: Set<string>,
    isKeyOpened: boolean,
    treatMlAsManual: boolean
): import('../../lib/types').Decision[] {
    if (!decisions || decisions.length === 0) return [];
    if (!isKeyOpened) return decisions;
    return decisions.filter(d => {
        const key = computeReviewerKey(d, treatMlAsManual);
        return key !== '' && enabledReviewers.has(key);
    });
}

/**
 * 有効なレビュアーのみで不一致を検出する（Reference 単位）。
 * Blind ON 時は `enabledReviewers` を無視して全レビュアーで検出する。
 */
export function hasEffectiveConflict(
    ref: { allDecisions?: import('../../lib/types').Decision[] } | undefined,
    enabledReviewers: Set<string>,
    isKeyOpened: boolean,
    treatMlAsManual: boolean
): boolean {
    if (!ref?.allDecisions || ref.allDecisions.length === 0) return false;
    const decisions = filterEnabledDecisions(ref.allDecisions, enabledReviewers, isKeyOpened, treatMlAsManual);
    return detectConflictWithSettings(decisions, treatMlAsManual);
}

/**
 * 不一致を検出（treatMlAsManual設定を考慮）
 * - treatMlAsManualがONの場合、同一ユーザーのML判定と手動判定を同一視
 * - 2人以上のレビュアーが存在し、判定内容が異なる場合のみ不一致
 */
export function detectConflictWithSettings(
    decisions: import('../../lib/types').Decision[],
    treatMlAsManual: boolean
): boolean {
    if (decisions.length === 0) {
        return false;
    }

    // レビュアーごとの最新判定をマップ化
    const reviewerDecisions = new Map<string, import('../../lib/types').Decision>();

    decisions.forEach(d => {
        const reviewerId = (d.reviewer_id || '').trim();
        if (!reviewerId) return;

        // LLMはそのまま
        let reviewerKey = reviewerId;

        // treatMlAsManualがONで、かつML判定(0.7.0-ml、autoを除く)の場合
        // 同一ユーザーの手動判定と同じキーにする
        if (!reviewerId.startsWith('llm:') && treatMlAsManual) {
            if (isConfirmedMlDecision(d.client_version)) {
                // ML判定も手動と同じreviewerIdをキーとする（サフィックスなし）
                reviewerKey = reviewerId;
            }
        } else if (!reviewerId.startsWith('llm:') && !treatMlAsManual) {
            // treatMlAsManualがOFFの場合、ML判定は別キーにする
            if (isMlDecision(d.client_version)) {
                reviewerKey = `${reviewerId}::ml`;
            }
        }

        const existing = reviewerDecisions.get(reviewerKey);
        if (!existing || (d.decided_at || '') > (existing.decided_at || '')) {
            reviewerDecisions.set(reviewerKey, d);
        }
    });

    const uniqueReviewers = reviewerDecisions.size;

    // 0人または1人のレビュアーの場合は不一致なし
    // （マージ後に1人になった場合も含む）
    if (uniqueReviewers <= 1) return false;

    // 2人以上の場合、判定内容が異なれば不一致
    const uniqueDecisionValues = new Set([...reviewerDecisions.values()].map(d => d.decision));
    return uniqueDecisionValues.size > 1;
}
