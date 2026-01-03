import type { Decision } from '../../../lib/types';
import { state } from '../../state';

const ML_REVIEWER_SUFFIX = '::ml';

/**
 * 判定がML判定か判定する（-ml-autoは除外）
 */
export function isConfirmedMlDecision(decision: Decision): boolean {
    return decision.client_version?.startsWith('0.7.0-ml') && !decision.client_version.includes('auto') || false;
}

/**
 * 判定が手動判定か判定する
 */
export function isManualDecision(decision: Decision): boolean {
    return decision.client_version === '0.1.0';
}

export function getReviewerKey(decision: Decision): string {
    const reviewerId = (decision.reviewer_id || '').trim();
    if (!reviewerId) return '';
    if (reviewerId.startsWith('llm:')) return reviewerId;

    // ML判定を手動と同一視する場合の例外
    // 0.7.0-ml (ユーザー確認済みML) の場合のみ同一視
    // ※ -ml-auto などの自動判定は常にML扱いとする
    if (state.treatMlAsManual && isConfirmedMlDecision(decision)) {
        return reviewerId;
    }

    if (decision.client_version?.includes('-ml')) return `${reviewerId}${ML_REVIEWER_SUFFIX}`;
    return reviewerId;
}

export function isLlmReviewerKey(key: string): boolean {
    return key.startsWith('llm:');
}

export function isMlReviewerKey(key: string): boolean {
    return key.endsWith(ML_REVIEWER_SUFFIX);
}

/**
 * 混在情報を含むレビュアーラベルを生成
 * @param key レビュアーキー
 * @param userEmail 現在のユーザーメール
 * @param hasBothManualAndMl treatMlAsManualがオンで手動とML両方の判定がある場合true
 */
export function getReviewerLabel(key: string, userEmail: string, hasBothManualAndMl = false): string {
    if (isLlmReviewerKey(key)) {
        const parts = key.split('@');
        let aiLabel = '🤖 AI';
        if (parts.length > 1) {
            const date = new Date(parts[1]);
            if (!Number.isNaN(date.getTime())) {
                const month = (date.getMonth() + 1).toString().padStart(2, '0');
                const day = date.getDate().toString().padStart(2, '0');
                const hours = date.getHours().toString().padStart(2, '0');
                const minutes = date.getMinutes().toString().padStart(2, '0');
                aiLabel = `🤖 AI (${month}/${day} ${hours}:${minutes})`;
            }
        }
        return aiLabel;
    }

    if (isMlReviewerKey(key)) {
        const reviewerId = key.slice(0, -ML_REVIEWER_SUFFIX.length);
        if (reviewerId === userEmail) {
            return `${reviewerId} (自分/ML)`;
        }
        return `${reviewerId} (ML)`;
    }

    // treatMlAsManualがオンで、手動とML両方がある場合
    if (hasBothManualAndMl && state.treatMlAsManual) {
        if (key === userEmail) {
            return `${key} (自分/手動＋ML)`;
        }
        return `${key} (手動＋ML)`;
    }

    if (key === userEmail) {
        return `${key} (自分)`;
    }
    return key;
}
