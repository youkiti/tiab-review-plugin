/**
 * Selectors: 派生データの計算
 * stateから計算可能なデータはここで算出し、stateには保存しない
 */

import type { AppState } from './types';
import type { ReferenceWithStatus, DecisionStatus, Decision } from '../../lib/types';
import { applyTextFilters } from '../utils/search';
import { isHumanDecision, isConfirmedMlDecision } from '../../lib/client-version';
import { canSeeFulltextRef } from '../../lib/fulltext-assignment';
import { isFulltextCandidateRef } from '../../lib/fulltext-candidates';
import { collectRefDecisions } from '../../lib/reference-status';
import { hasEffectiveConflict } from '../render/helpers';
import { resolveReferenceAssignmentSet } from '../../lib/assignment-set';

// ========== フィルタリング関連 ==========

/**
 * 自分の手動判定ステータスを取得
 * human判定（旧形式も含む）と、treatMlAsManualが有効な場合の確認済みML判定を扱う。
 */
export function getMyManualDecisionStatus(
    ref: ReferenceWithStatus,
    userEmail: string,
    treatMlAsManual: boolean
): DecisionStatus {
    const isMyManual = (d: Decision) => {
        if (d.reviewer_id !== userEmail) return false;
        if (isHumanDecision(d.client_version)) return true;
        if (treatMlAsManual && isConfirmedMlDecision(d.client_version)) {
            return true;
        }
        return false;
    };

    const myManualDecision = ref.allDecisions?.find(isMyManual);
    if (myManualDecision) {
        return myManualDecision.decision as DecisionStatus;
    }

    if (ref.myDecision && isMyManual(ref.myDecision)) {
        return ref.myDecision.decision as DecisionStatus;
    }

    return 'pending';
}

/**
 * 文献の全判定を集める（allDecisions + myDecision、重複排除）。
 * 実体は lib の純関数（論文用テキストの組み立てと共有するため）。
 */
export { collectRefDecisions };

/**
 * フルテキスト候補のうち自分の担当分か（担当割り振り適用後）
 * スクリーニングと件数集計で共有する判定
 * （フルテキスト候補判定そのものは fulltext-candidates.ts の isFulltextCandidateRef に委譲）
 */
export function isMyFulltextCandidate(ref: ReferenceWithStatus, data: AppState['data']): boolean {
    return isFulltextCandidateRef({
        ref,
        decisions: collectRefDecisions(ref),
        poolRule: data.fulltextPoolRule,
        assignment: data.fulltextAssignment,
        userEmail: data.userEmail,
        isAdmin: data.isAdmin,
    }) && canSeeFulltextRef(ref, data.fulltextAssignment, data.userEmail, data.isAdmin);
}

/**
 * フィルタリング済み文献リストを取得
 */
export function getFilteredReferences(state: AppState): ReferenceWithStatus[] {
    const { data, ui } = state;
    const { screening, settings } = ui;
    let filtered = data.references;

    // ステータスフィルター
    if (screening.currentFilter === 'fulltext_candidates') {
        filtered = filtered.filter(r => isMyFulltextCandidate(r, data));
    } else if (screening.currentFilter === 'conflict') {
        filtered = filtered.filter(r =>
            hasEffectiveConflict(r, data.enabledReviewers, screening.isKeyOpened, settings.treatMlAsManual)
        );
    } else if (screening.currentFilter !== 'all') {
        filtered = filtered.filter(r =>
            getMyManualDecisionStatus(r, data.userEmail, settings.treatMlAsManual) === screening.currentFilter
        );
    }

    // ソースファイルフィルター
    if (data.selectedSourceFiles.size > 0 && data.selectedSourceFiles.size < data.sourceFiles.size) {
        filtered = filtered.filter(r =>
            r.source_file && data.selectedSourceFiles.has(r.source_file)
        );
    }

    // 担当セットフィルター（全選択時は絞らず、未選択時は空にする）
    if (data.assignmentSets.size > 0 && data.selectedAssignmentSets.size < data.assignmentSets.size) {
        filtered = filtered.filter(r =>
            data.selectedAssignmentSets.has(resolveReferenceAssignmentSet(r, data.assignmentConfig))
        );
    }

    // 検索・タームフィルターは二重実装を避けて applyTextFilters() に集約している
    // （Issue #152（#150 工程1））。
    filtered = applyTextFilters(filtered, screening.searchQuery, screening.activeTermFilters, settings.termFilterUseAnd);

    // 判定フィルター (Blind off時のみ、レビュアーごとに独立して適用)
    if (screening.isKeyOpened) {
        for (const [reviewerId, filter] of Object.entries(settings.aiDecisionFilter)) {
            // 無効化されたレビュアーはフィルター対象外
            if (!data.enabledReviewers.has(reviewerId)) continue;

            const allowed = new Set<string>();
            if (filter.include) allowed.add('include');
            if (filter.exclude) allowed.add('exclude');
            if (filter.maybe ?? true) allowed.add('maybe');
            // 全ON or 全OFF はこのレビュアーのフィルターを適用しない
            if (allowed.size === 3 || allowed.size === 0) continue;

            filtered = filtered.filter(r => {
                const decision = r.allDecisions?.find(d => d.reviewer_id === reviewerId);
                if (!decision) return false; // 該当レビュアーの判定が無いレコードは非表示
                return allowed.has(decision.decision);
            });
        }
    }

    return filtered;
}
