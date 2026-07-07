/**
 * CMH（Callaghan & Müller-Hansen）停止基準の計算ロジック
 * 
 * 参照実装: vendor/rapid-screening/analysis/rapid_review.py L263-275
 * 論文: Callaghan & Müller-Hansen (2020) "Statistical stopping criteria for automated screening"
 */

import jStat from 'jstat';

/**
 * 超幾何分布の累積分布関数
 * 
 * @param k - 成功数（抽出中の include 数）
 * @param N - 母集団サイズ（残り未読 + 直近読んだ n 件）
 * @param K - 母集団中の成功要素数（仮説的残存 relevant 数）
 * @param n - 抽出数（直近で読んだ件数）
 * @returns P(X <= k) - k 以下の成功数が観測される確率
 */
export function hypergeomCdf(k: number, N: number, K: number, n: number): number {
    // 境界チェック
    if (K < 0 || K > N || n < 0 || n > N || k < 0) {
        return 0;
    }
    if (k >= Math.min(n, K)) {
        return 1;
    }

    // jStat.hypgeom.cdf(k, N, K, n)
    // k: 成功数, N: 母集団サイズ, K: 母集団中の成功数, n: 抽出数
    return jStat.hypgeom.cdf(k, N, K, n);
}

/**
 * 仮説的残存 relevant 数を計算
 * 
 * 目標リコールを達成するために必要な総 relevant 数から、
 * 既に見つけた数を引き、ウィンドウ内の数を加える
 * 
 * 参照: rapid_review.py L146-147
 * def gen_hypo(X, r_seen, r_target):
 *     return math.ceil(r_seen/r_target+0.01) - r_seen + X
 * 
 * @param observedRelevantInWindow - 直近ウィンドウ内の include 数
 * @param totalRelevantSeen - これまでの総 include 数
 * @param targetRecall - 目標リコール (例: 0.99)
 * @returns 仮説的残存 relevant 数
 */
export function calculateHypothetical(
    observedRelevantInWindow: number,
    totalRelevantSeen: number,
    targetRecall: number
): number {
    if (targetRecall <= 0 || targetRecall > 1) {
        throw new Error(`Invalid targetRecall: ${targetRecall}. Must be in (0, 1].`);
    }
    if (totalRelevantSeen === 0) {
        // まだ include が 0 の場合、仮説値を大きく取る
        return observedRelevantInWindow + 1;
    }
    // 目標リコールを達成するために必要な総 relevant 数
    const requiredTotal = Math.ceil(totalRelevantSeen / targetRecall + 0.01);
    return requiredTotal - totalRelevantSeen + observedRelevantInWindow;
}

/**
 * CMH 停止判定のコア計算
 * 
 * 直近のラベル列から min_prob_target を計算する
 * 
 * 参照: rapid_review.py L265-270
 * Xs = np.cumsum(np.array(self.ratings[::-1]))
 * ns = np.arange(len(self.ratings))
 * hypotheticals = vgen_hypo(Xs, self.r_seen, self.recall_target)
 * prob_target = hypergeom.cdf(Xs, self.n_remaining+ns, hypotheticals, ns+1)
 * self.min_prob_target = prob_target.min()
 * 
 * @param recentDecisions - 直近のラベル列 (1=include, 0=exclude)、スクリーニング順
 * @param totalIncluded - これまでの総 include 数
 * @param nRemaining - 残り未読件数
 * @param targetRecall - 目標リコール
 * @returns min_prob_target - 停止判定に使う最小確率
 */
export function calculateMinProbTarget(
    recentDecisions: (0 | 1)[],
    totalIncluded: number,
    nRemaining: number,
    targetRecall: number
): number {
    if (recentDecisions.length === 0) {
        return 1.0;
    }

    // 直近から逆順にして累積和を計算
    const reversed = [...recentDecisions].reverse();
    let minProb = 1.0;
    let cumSum = 0;

    for (let i = 0; i < reversed.length; i++) {
        cumSum += reversed[i];
        const n = i + 1;  // 抽出数
        const hypothetical = calculateHypothetical(cumSum, totalIncluded, targetRecall);

        // 超幾何分布のパラメータ
        // N = nRemaining + i (母集団サイズ: 残り + これまでに見た i 件)
        // K = hypothetical (仮説的残存 relevant 数)
        // n = n (抽出数)
        // k = cumSum (観測された成功数)
        const N = nRemaining + i;
        const prob = hypergeomCdf(cumSum, N, hypothetical, n);

        if (prob < minProb) {
            minProb = prob;
        }
    }

    return minProb;
}

/**
 * 停止可能かどうかを判定
 * 
 * @param minProbTarget - calculateMinProbTarget の結果
 * @param confidence - 信頼水準 (例: 0.95)
 * @returns true なら停止可能
 */
export function shouldStop(minProbTarget: number, confidence: number): boolean {
    // 停止条件: min_prob_target < 1 - confidence (例: < 0.05)
    return minProbTarget < (1 - confidence);
}

/**
 * CMH 停止状態を計算
 * 
 * @param totalRecords - 総レコード数
 * @param screenedCount - 既読数
 * @param includedCount - include 数
 * @param recentDecisions - 直近のラベル列
 * @param targetRecall - 目標リコール
 * @param confidence - 信頼水準
 * @returns 停止判定結果
 */
export function calculateCmhStopping(
    totalRecords: number,
    screenedCount: number,
    includedCount: number,
    recentDecisions: (0 | 1)[],
    targetRecall: number,
    confidence: number
): { canStop: boolean; minProbTarget: number } {
    const nRemaining = totalRecords - screenedCount;
    const minProbTarget = calculateMinProbTarget(
        recentDecisions,
        includedCount,
        nRemaining,
        targetRecall
    );

    return {
        canStop: shouldStop(minProbTarget, confidence),
        minProbTarget,
    };
}

// CMH_DEFAULTS は共有の状態型 lib/ml/types.ts からも参照するため、jstat 非依存の
// cmh-defaults.ts へ分離。互換のため再エクスポートする。
export { CMH_DEFAULTS } from './cmh-defaults';
