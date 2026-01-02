/**
 * 停止基準（Stopping Rules）のロジック
 * ASReview の NConsecutiveIrrelevant を TS で実装
 */

import { StoppingRule } from './types';

/**
 * 停止進捗を更新する
 * - include: カウンターをリセット
 * - exclude: カウンターを +1
 */
export function updateStoppingProgress(
    rule: StoppingRule,
    decision: 'include' | 'exclude'
): StoppingRule {
    if (decision === 'include') {
        return { ...rule, current: 0 };
    } else {
        return { ...rule, current: rule.current + 1 };
    }
}

/**
 * 停止基準に到達したかどうか
 */
export function isStoppingReached(rule: StoppingRule): boolean {
    return rule.current >= rule.threshold;
}

/**
 * 停止進捗のパーセンテージを計算
 */
export function getStoppingProgressPercent(rule: StoppingRule): number {
    if (rule.threshold === 0) return 100;
    return Math.min(100, Math.round((rule.current / rule.threshold) * 100));
}

/**
 * データセットサイズからパーセンテージベースの閾値を計算
 */
export function calculateThresholdFromPercent(
    totalRecords: number,
    percent: number
): number {
    return Math.max(1, Math.round(totalRecords * (percent / 100)));
}

/**
 * プリセット閾値オプション
 */
export const STOPPING_PRESETS = [
    { percent: 1, label: '1%' },
    { percent: 2, label: '2%' },
    { percent: 5, label: '5%' },
    { percent: 10, label: '10%' },
] as const;
