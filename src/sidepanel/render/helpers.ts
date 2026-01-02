/**
 * 描画ヘルパー関数
 * テキストハイライト、エスケープ等の共通処理
 */

import type { AppState } from '../store/types';
import { escapeHtml, escapeRegex } from '../utils/text';

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
        return '文献をインポートしてください 📂';
    } else if (percent === 0) {
        return 'さあ、始めましょう！💪';
    } else if (percent <= 25) {
        return '順調なスタートです！🚀';
    } else if (percent <= 50) {
        return 'いいペースです！半分まであと少し 📈';
    } else if (percent <= 75) {
        return '折り返し地点を過ぎました！🎯';
    } else if (percent < 100) {
        return 'ゴールが見えてきました！✨';
    } else {
        return '完了しました！お疲れ様でした 🎉';
    }
}

/**
 * レビュアーIDからラベルを生成
 */
export function getReviewerLabel(reviewerId: string, currentUserEmail: string): string {
    if (!reviewerId) return '(不明)';

    // LLM reviewer
    if (reviewerId.startsWith('llm:')) {
        const modelName = reviewerId.replace('llm:', '');
        return `🤖 ${modelName}`;
    }

    // Current user
    if (reviewerId === currentUserEmail) {
        return `👤 自分`;
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

    if (clientVersion.includes('-ml-auto')) {
        return '<span class="ml-enhanced-badge auto">🤖 ML(自動)</span>';
    } else if (clientVersion.includes('-ml')) {
        return '<span class="ml-enhanced-badge">🤖 ML</span>';
    }

    return '';
}
