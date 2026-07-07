/**
 * Selectors: 派生データの計算
 * stateから計算可能なデータはここで算出し、stateには保存しない
 */

import type { AppState } from './types';
import type { ReferenceWithStatus, DecisionStatus, Decision } from '../../lib/types';
import { createSmartRegex } from '../utils/text';
import { parseSearchQuery } from '../utils/search';
import { isHumanDecision, isConfirmedMlDecision } from '../../lib/client-version';
import { isInFulltextPool } from '../../lib/fulltext-pool';
import type { FulltextPoolRule } from '../../lib/fulltext-pool';
import { canSeeFulltextRef } from '../../lib/fulltext-assignment';
import { detectConflictWithSettings, hasEffectiveConflict } from '../render/helpers';
import { t } from '../../lib/i18n';

// ========== フィルタリング関連 ==========

/**
 * 自分の手動判定ステータスを取得
 * client_version === '0.1.0' の判定のみを手動判定として扱う
 * ただし treatMlAsManual が true の場合は ML判定(0.7.0-ml)も手動判定として扱う
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
 * 文献の全判定を集める（allDecisions + myDecision、重複排除）
 */
function collectRefDecisions(ref: ReferenceWithStatus): Decision[] {
    const list = [...(ref.allDecisions ?? [])];
    if (ref.myDecision && !list.some(d => d.decision_id === ref.myDecision!.decision_id)) {
        list.push(ref.myDecision);
    }
    return list;
}

/**
 * フルテキスト候補の判定
 * - ルール設定済み: FulltextPoolRule（採用voter + 必要票数）で判定
 * - 未設定:
 *   - 管理者: 読み込まれている全レビュアーの TiAb Include が1件でもある文献
 *   - 非管理者: 自分が TiAb で Include した文献
 */
function isFulltextCandidate(
    ref: ReferenceWithStatus,
    userEmail: string,
    isAdmin: boolean,
    fulltextPoolRule: FulltextPoolRule | null
): boolean {
    const decisions = collectRefDecisions(ref);
    if (fulltextPoolRule) {
        return isInFulltextPool(decisions, fulltextPoolRule);
    }

    return decisions.some(d =>
        d.decision === 'include' &&
        (d.screening_phase ?? 'tiab') === 'tiab' &&
        (isAdmin || d.reviewer_id === userEmail)
    );
}

/**
 * フルテキスト候補のうち自分の担当分か（担当割り振り適用後）
 * features/screening/filters.ts の isMyFulltextCandidate と同じ規則
 */
function isMyFulltextCandidate(ref: ReferenceWithStatus, data: AppState['data']): boolean {
    return isFulltextCandidate(ref, data.userEmail, data.isAdmin, data.fulltextPoolRule)
        && canSeeFulltextRef(ref, data.fulltextAssignment, data.userEmail, data.isAdmin);
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

    // 検索フィルター
    const rawSearch = screening.searchQuery;
    if (rawSearch.trim()) {
        const { terms, mode } = parseSearchQuery(rawSearch, settings.termFilterUseAnd);
        filtered = filtered.filter(r => {
            const text = `${r.title} ${r.abstract || ''}`;
            const regexes = terms.map(t => createSmartRegex(t));

            if (mode === 'and') {
                return regexes.every(regex => {
                    regex.lastIndex = 0;
                    return regex.test(text);
                });
            } else {
                return regexes.some(regex => {
                    regex.lastIndex = 0;
                    return regex.test(text);
                });
            }
        });
    }

    // タームフィルター
    const termFilters = screening.activeTermFilters;
    if (termFilters.length > 0) {
        if (settings.termFilterUseAnd) {
            for (const termFilter of termFilters) {
                const regex = createSmartRegex(termFilter.term);
                filtered = filtered.filter(r => {
                    const text = `${r.title} ${r.abstract || ''}`;
                    return regex.test(text);
                });
            }
        } else {
            filtered = filtered.filter(r => {
                const text = `${r.title} ${r.abstract || ''}`;
                return termFilters.some(termFilter => {
                    const regex = createSmartRegex(termFilter.term);
                    return regex.test(text);
                });
            });
        }
    }

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

/**
 * 現在表示中の文献を取得
 */
export function getCurrentReference(state: AppState): ReferenceWithStatus | null {
    const filtered = getFilteredReferences(state);
    return filtered[state.ui.screening.currentIndex] || null;
}

/**
 * 進捗統計を取得
 */
export function getProgressStats(state: AppState): {
    total: number;
    labeled: number;
    remaining: number;
    percent: number;
} {
    const { data, ui } = state;
    const total = data.references.length;
    const labeled = data.references.filter(r => {
        const status = getMyManualDecisionStatus(r, data.userEmail, ui.settings.treatMlAsManual);
        return status !== 'pending' && status !== 'conflict';
    }).length;
    const remaining = total - labeled;
    const percent = total > 0 ? Math.round((labeled / total) * 100) : 0;

    return { total, labeled, remaining, percent };
}

/**
 * フィルター別のカウントを取得
 */
export function getFilterCounts(state: AppState): {
    pending: number;
    all: number;
    include: number;
    exclude: number;
    maybe: number;
    conflict: number;
    fulltextCandidates: number;
} {
    const { data, ui } = state;

    // ソースファイルフィルターを適用したものでカウント
    let filtered = data.references;
    if (data.selectedSourceFiles.size > 0 && data.selectedSourceFiles.size < data.sourceFiles.size) {
        filtered = data.references.filter(r =>
            r.source_file && data.selectedSourceFiles.has(r.source_file)
        );
    }

    const getStatus = (r: ReferenceWithStatus) =>
        getMyManualDecisionStatus(r, data.userEmail, ui.settings.treatMlAsManual);

    return {
        pending: filtered.filter(r => getStatus(r) === 'pending').length,
        all: filtered.length,
        include: filtered.filter(r => getStatus(r) === 'include').length,
        exclude: filtered.filter(r => getStatus(r) === 'exclude').length,
        maybe: filtered.filter(r => getStatus(r) === 'maybe').length,
        conflict: filtered.filter(r =>
            hasEffectiveConflict(r, data.enabledReviewers, ui.screening.isKeyOpened, ui.settings.treatMlAsManual)
        ).length,
        fulltextCandidates: filtered.filter(r => isMyFulltextCandidate(r, data)).length,
    };
}

// ========== ML関連 ==========

/**
 * ML用のフィルタリング済みランキングを取得
 */
export function getMlFilteredRanking(state: AppState): string[] {
    const { data, ui } = state;
    const ranking = data.mlState.ranking;

    if (!ui.ml.searchQuery.trim()) {
        return ranking;
    }

    const { terms, mode } = parseSearchQuery(ui.ml.searchQuery, ui.settings.termFilterUseAnd);

    return ranking.filter(refId => {
        const ref = data.references.find(r => r.ref_id === refId);
        if (!ref) return false;

        const text = `${ref.title} ${ref.abstract || ''}`;
        const regexes = terms.map(t => createSmartRegex(t));

        if (mode === 'and') {
            return regexes.every(regex => {
                regex.lastIndex = 0;
                return regex.test(text);
            });
        } else {
            return regexes.some(regex => {
                regex.lastIndex = 0;
                return regex.test(text);
            });
        }
    });
}

/**
 * 現在のML表示用文献を取得
 */
export function getCurrentMlReference(state: AppState): ReferenceWithStatus | null {
    const ranking = getMlFilteredRanking(state);
    const refId = ranking[state.ui.ml.currentIndex];
    if (!refId) return null;
    return state.data.references.find(r => r.ref_id === refId) || null;
}

// ========== Evidence関連 ==========

/**
 * AI Evidenceリストを取得（ハイライト用）
 */
export function getAiEvidenceList(
    ref: ReferenceWithStatus,
    state: AppState
): string[] {
    const evidenceList: string[] = [];

    if (!state.ui.settings.showAiHighlights || !ref.allDecisions) {
        return evidenceList;
    }

    ref.allDecisions.forEach(d => {
        // 表示されているレビュアーのみ
        if (state.data.enabledReviewers.size > 0 &&
            !state.data.enabledReviewers.has(d.reviewer_id)) {
            return;
        }
        // 閾値確定済みで有効なAI判定のみ
        if (!d.reviewer_id.startsWith('llm:') ||
            !state.data.activeLlmExecutionIds.has(d.reviewer_id)) {
            return;
        }

        try {
            if (d.note && d.note.trim().startsWith('{')) {
                const parsed = JSON.parse(d.note);
                if (parsed.evidence && Array.isArray(parsed.evidence)) {
                    parsed.evidence.forEach((e: { quote?: string }) => {
                        if (e.quote) evidenceList.push(e.quote);
                    });
                }
            }
        } catch {
            // Ignore parse errors
        }
    });

    return evidenceList;
}

// ========== 励ましメッセージ ==========

/**
 * 進捗に応じた励ましメッセージを取得
 */
export function getEncourageMessage(state: AppState): string {
    const { total, percent } = getProgressStats(state);

    if (total === 0) {
        return t('progress_importPrompt');
    } else if (percent === 0) {
        return t('progress_start');
    } else if (percent <= 25) {
        return t('progress_goodStart');
    } else if (percent <= 50) {
        return t('progress_goodPace');
    } else if (percent <= 75) {
        return t('progress_pastHalf');
    } else if (percent < 100) {
        return t('progress_nearGoal');
    } else {
        return t('progress_complete');
    }
}
