/**
 * 停止基準（Stopping Rules）のロジック
 * 
 * - 旧方式: NConsecutiveIrrelevant（連続除外）
 * - 新方式: CMH（Callaghan & Müller-Hansen）
 */

import { StoppingRule, CmhStoppingRule, ConsecutiveStoppingRule, isCmhStoppingRule } from './types';
import { CMH_DEFAULTS } from './cmh-defaults';

// ========================================
// 旧方式（連続除外）の関数群
// ========================================

/**
 * 連続除外の停止進捗を更新する
 * - include: カウンターをリセット
 * - exclude: カウンターを +1
 */
export function updateConsecutiveStoppingProgress(
    rule: ConsecutiveStoppingRule,
    decision: 'include' | 'exclude'
): ConsecutiveStoppingRule {
    if (decision === 'include') {
        return { ...rule, current: 0 };
    } else {
        return { ...rule, current: rule.current + 1 };
    }
}

/**
 * 連続除外の停止基準に到達したかどうか
 */
export function isConsecutiveStoppingReached(rule: ConsecutiveStoppingRule): boolean {
    return rule.current >= rule.threshold;
}

/**
 * 連続除外の停止進捗のパーセンテージを計算
 */
export function getConsecutiveStoppingProgressPercent(rule: ConsecutiveStoppingRule): number {
    if (rule.threshold === 0) return 100;
    return Math.min(100, Math.round((rule.current / rule.threshold) * 100));
}

// ========================================
// CMH 停止基準の関数群
// ========================================

/**
 * CMH 停止基準に到達したかどうか
 */
export function isCmhStoppingReached(rule: CmhStoppingRule): boolean {
    // ウォームアップと最低限の Include・追加判定件数を満たすまで停止しない。
    if (!rule.warmupComplete) {
        return false;
    }
    if (rule.included < CMH_DEFAULTS.minIncludedForStop) {
        return false;
    }
    if (rule.screened < rule.warmupSize + CMH_DEFAULTS.minAdditionalScreened) {
        return false;
    }

    return rule.canStop;
}

/**
 * CMH 停止進捗のパーセンテージを計算
 * 
 * 信頼度ベース: probUnderTarget が 1-confidence に近づくほど 100% に近づく
 */
export function getCmhStoppingProgressPercent(rule: CmhStoppingRule): number {
    if (!rule.warmupComplete) {
        // ウォームアップ中はウォームアップの進捗を返す
        return Math.min(100, Math.round((rule.screened / rule.warmupSize) * 100));
    }

    // 停止閾値 = 1 - confidence (例: 0.05)
    const threshold = 1 - rule.confidence;
    // probUnderTarget が threshold 以下なら 100%
    if (rule.probUnderTarget <= threshold) {
        return 100;
    }
    // そうでなければ、1.0 から threshold への進捗を計算
    // probUnderTarget = 1.0 → 0%, probUnderTarget = threshold → 100%
    const progress = (1 - rule.probUnderTarget) / (1 - threshold);
    return Math.min(100, Math.max(0, Math.round(progress * 100)));
}

// ========================================
// 汎用関数（型に応じて振り分け）
// ========================================

/**
 * 停止基準に到達したかどうか（汎用）
 */
export function isStoppingReached(rule: StoppingRule): boolean {
    if (isCmhStoppingRule(rule)) {
        return isCmhStoppingReached(rule);
    } else {
        return isConsecutiveStoppingReached(rule);
    }
}

/**
 * 停止進捗のパーセンテージを計算（汎用）
 */
export function getStoppingProgressPercent(rule: StoppingRule): number {
    if (isCmhStoppingRule(rule)) {
        return getCmhStoppingProgressPercent(rule);
    } else {
        return getConsecutiveStoppingProgressPercent(rule);
    }
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

// canUseCmhStopping は jstat 非依存の cmh-defaults.ts へ分離。互換のため再エクスポートする
// （CMH_DEFAULTS を cmh.ts から re-export しているのと同じ流儀・同じ理由）。
export { canUseCmhStopping } from './cmh-defaults';

/**
 * プリセット閾値オプション（旧方式用）
 */
export const STOPPING_PRESETS = [
    { percent: 1, label: '1%' },
    { percent: 2, label: '2%' },
    { percent: 5, label: '5%' },
    { percent: 10, label: '10%' },
] as const;
