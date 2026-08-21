// assignment-roster.ts - 担当割り振り名簿から「この文献を判定すべきレビュアー」を求める純関数
//
// team-progress.ts / assignment.ts が個別に持っていた「文献の担当セットID」判定規則をここに集約する。
// TiAb エクスポートの分母（`decision-summary.ts` の summarizeTeamDecision）が
// 「判定実績のあるレビュアー」ではなく「名簿上の担当者」を分母にできるようにするためのモジュール。

import type { AssignmentConfig } from './types';

function normalizeEmail(email: string): string {
    return (email || '').trim().toLowerCase();
}

/**
 * 文献の担当セットID。空欄は 'unassigned'。
 * team-progress.ts の refSetOf / assignment.ts の getReferenceAssignmentSet(未設定時の一部)
 * と同じ規則。
 */
export function getRefAssignmentSet(ref: { screening_set?: string }): string {
    const normalized = (ref.screening_set || '').trim();
    return normalized || 'unassigned';
}

/**
 * この文献を判定すべきレビュアー（小文字正規化済みメール）の集合を返す。
 * 名簿から決められない場合は null（呼び出し側は判定実績ベースの推定へフォールバックすること）。
 *
 * - config.status !== 'configured' → null（名簿が存在しない）
 * - セットが 'calibration' → reviewerMap に現れる全レビュアーの和集合
 *   （assignment.ts の getAssignedSetsForUser が calibration を全員の担当としているのと整合させる）
 * - それ以外 → reviewerMap[setId]。未登録・空なら null
 */
export function getExpectedReviewersForRef(
    config: AssignmentConfig,
    ref: { screening_set?: string }
): Set<string> | null {
    if (config.status !== 'configured') {
        return null;
    }

    const setId = getRefAssignmentSet(ref);
    const reviewerMap = config.reviewerMap || {};

    if (setId === 'calibration') {
        const all = new Set<string>();
        for (const reviewers of Object.values(reviewerMap)) {
            for (const r of reviewers || []) {
                const email = normalizeEmail(r);
                if (email) all.add(email);
            }
        }
        return all.size > 0 ? all : null;
    }

    const reviewers = (reviewerMap[setId] || [])
        .map(normalizeEmail)
        .filter(Boolean);

    return reviewers.length > 0 ? new Set(reviewers) : null;
}
