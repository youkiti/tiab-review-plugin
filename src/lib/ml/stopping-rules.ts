/**
 * 停止基準（Stopping Rules）のロジック
 * 
 * - 旧方式: NConsecutiveIrrelevant（連続除外）
 * - 新方式: CMH（Callaghan & Müller-Hansen）
 */

import { StoppingRule, CmhStoppingRule, ConsecutiveStoppingRule, isCmhStoppingRule } from './types';
import { calculateCmhStopping } from './cmh';

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
 * CMH 停止基準を更新する
 * 
 * @param rule - 現在の CMH ルール
 * @param decision - ラベル判定
 * @param totalRecords - 総レコード数
 * @returns 更新後の CMH ルール
 */
export function updateCmhStoppingProgress(
    rule: CmhStoppingRule,
    decision: 'include' | 'exclude',
    totalRecords: number
): CmhStoppingRule {
    const newDecision: 0 | 1 = decision === 'include' ? 1 : 0;
    const newRecentDecisions = [...rule.recentDecisions, newDecision];

    const newScreened = rule.screened + 1;
    const newIncluded = decision === 'include' ? rule.included + 1 : rule.included;

    // 初期フェーズ完了判定
    const newInitialPhaseComplete = rule.initialPhaseComplete ||
        newScreened >= rule.initialRandomSize;

    // CMH 計算（初期フェーズ完了後、updateInterval ごとに更新）
    let canStop = rule.canStop;
    let probUnderTarget = rule.probUnderTarget;

    if (newInitialPhaseComplete && newScreened % rule.updateInterval === 0) {
        const result = calculateCmhStopping(
            totalRecords,
            newScreened,
            newIncluded,
            newRecentDecisions,
            rule.targetRecall,
            rule.confidence
        );
        canStop = result.canStop;
        probUnderTarget = result.minProbTarget;
    }

    return {
        ...rule,
        screened: newScreened,
        included: newIncluded,
        initialPhaseComplete: newInitialPhaseComplete,
        canStop,
        probUnderTarget,
        recentDecisions: newRecentDecisions,
    };
}

/**
 * CMH 停止基準に到達したかどうか
 */
export function isCmhStoppingReached(rule: CmhStoppingRule): boolean {
    // ガード条件:
    // 1. 初期フェーズ完了
    // 2. 最小 include 数 (10)
    // 3. 初期後の追加スクリーニング (100)
    const minIncludeCount = 10;
    const minAdditionalScreening = 100;

    if (!rule.initialPhaseComplete) {
        return false;
    }
    if (rule.included < minIncludeCount) {
        return false;
    }
    if (rule.screened < rule.initialRandomSize + minAdditionalScreening) {
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
    if (!rule.initialPhaseComplete) {
        // 初期フェーズ中は初期フェーズの進捗を返す
        return Math.min(100, Math.round((rule.screened / rule.initialRandomSize) * 100));
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
 * 停止進捗を更新する（汎用）
 * 
 * @deprecated CMH に移行後は updateCmhStoppingProgress を直接使用
 */
export function updateStoppingProgress(
    rule: StoppingRule,
    decision: 'include' | 'exclude',
    totalRecords?: number
): StoppingRule {
    if (isCmhStoppingRule(rule)) {
        if (totalRecords === undefined) {
            throw new Error('totalRecords is required for CMH stopping rule');
        }
        return updateCmhStoppingProgress(rule, decision, totalRecords);
    } else {
        return updateConsecutiveStoppingProgress(rule, decision);
    }
}

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
