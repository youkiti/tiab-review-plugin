/**
 * 描画ヘルパー関数
 * テキストハイライト、エスケープ等の共通処理
 */

import type { AppState } from '../store/types';
import { escapeHtml, escapeRegex } from '../utils/text';
import { isMlAutoDecision, isMlDecision, isConfirmedMlDecision } from '../../lib/client-version';
import { t } from '../../lib/i18n';

/**
 * テキストハイライト処理
 * @param text 対象テキスト
 * @param state アプリケーション状態
 * @param searchKeywords 検索キーワード（オプション）
 * @param evidenceList AI Evidence リスト（オプション）
 */
export function highlightText(
    text: string,
    state: AppState,
    searchKeywords: string[] = [],
    evidenceList: string[] = []
): string {
    if (!text) return '';

    let html = escapeHtml(text);

    // 1. ハイライトキーワード（include/exclude）
    const { highlightKeywords } = state.data;
    if (highlightKeywords) {
        // Excludeキーワード (赤)
        highlightKeywords.exclude.forEach(keyword => {
            if (!keyword) return;
            const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-exclude" data-action="add-term-filter" data-type="exclude">$1</span>');
        });

        // Includeキーワード (緑)
        highlightKeywords.include.forEach(keyword => {
            if (!keyword) return;
            const regex = new RegExp(`(${escapeRegex(keyword)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-include" data-action="add-term-filter" data-type="include">$1</span>');
        });
    }

    // 2. 検索キーワード（黄色）
    if (searchKeywords.length > 0) {
        searchKeywords.forEach(term => {
            if (!term) return;
            const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
            html = html.replace(regex, '<span class="highlight-search" data-action="add-term-filter" data-type="include">$1</span>');
        });
    }

    // 3. タームフィルター（青枠）
    state.ui.screening.activeTermFilters.forEach(filter => {
        const regex = new RegExp(`(${escapeRegex(filter.term)})`, 'gi');
        html = html.replace(regex, '<span class="highlight-term">$1</span>');
    });

    // 4. AI Evidence Highlights (Orange)
    if (evidenceList && evidenceList.length > 0) {
        evidenceList.forEach(quote => {
            if (!quote || quote.length < 5) return;
            const regex = new RegExp(`(${escapeRegex(quote.trim())})`, 'gi');
            html = html.replace(regex, '<span class="highlight-evidence" data-action="add-term-filter" data-type="include" title="AI Evidence">$1</span>');
        });
    }

    return html;
}

/**
 * 進捗に応じた励ましメッセージを取得
 */
export function getEncourageMessage(total: number, percent: number): string {
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

/**
 * レビュアーIDからラベルを生成
 */
export function getReviewerLabel(reviewerId: string, currentUserEmail: string): string {
    if (!reviewerId) return t('reviewer_unknown');

    // LLM reviewer
    if (reviewerId.startsWith('llm:')) {
        const modelName = reviewerId.replace('llm:', '');
        return `🤖 ${modelName}`;
    }

    // Current user
    if (reviewerId === currentUserEmail) {
        return `👤 ${t('reviewer_selfLabel')}`;
    }

    // Other human reviewer - show email prefix
    const atIndex = reviewerId.indexOf('@');
    if (atIndex > 0) {
        return `👤 ${reviewerId.substring(0, atIndex)}`;
    }

    return `👤 ${reviewerId}`;
}

/**
 * 判定アイコンを取得
 */
export function getDecisionIcon(decision: string): string {
    switch (decision) {
        case 'include': return '✓';
        case 'exclude': return '✕';
        case 'maybe': return '?';
        default: return '';
    }
}

/**
 * MLバッジHTMLを生成
 */
export function getMlBadgeHtml(clientVersion?: string): string {
    if (!clientVersion) return '';

    if (isMlAutoDecision(clientVersion)) {
        return '<span class="ml-enhanced-badge auto">🤖 ML(自動)</span>';
    } else if (isMlDecision(clientVersion)) {
        return '<span class="ml-enhanced-badge">🤖 ML</span>';
    }

    return '';
}

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
