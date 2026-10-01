/**
 * ML タブでどの停止基準を有効にするかの判断と、判定済みの記録からの進み具合の復元。
 *
 * DOM・Store・chrome.storage に依存しない純関数だけを置く（呼び出し側は
 * `src/sidepanel/features/ml/` の actions.ts / stopping.ts / stopping-storage.ts）。
 *
 * 保存形式（`mlStoppingRule_<spreadsheetId>`）は `{ confirmed, threshold }` で始まり、
 * 後から `ruleType` を足した。`ruleType` が無い保存値（旧形式）の読み方は
 * `resolveStoppingRuleKind` に理由つきで書いてある。
 */

import { canUseCmhStopping } from './cmh-defaults';
import { calculateCmhStopping } from './cmh';
import { updateConsecutiveStoppingProgress } from './stopping-rules';
import {
    createCmhStoppingRule,
    createStoppingRule,
    type CmhStoppingRule,
    type StoppingRule,
} from './types';

/** 停止基準の種類（保存値の `ruleType`）。 */
export type StoppingRuleKind = 'cmh' | 'consecutive';

/** 連続 Exclude の既定しきい値（旧ダイアログの推奨値）。 */
export const DEFAULT_CONSECUTIVE_THRESHOLD = 50;

/** 旧形式（ruleType なし）の保存値で、CMH のつもりで確定したことを示すしきい値。過去に保存された値との照合なので、warmupSize を変えてもここは変えない。 */
export const LEGACY_CMH_SAVED_THRESHOLD = 500;

/** ブラウザに保存している停止基準の設定（読み出し後に正規化したもの）。 */
export interface SavedStoppingRule {
    confirmed: boolean;
    threshold: number;
    /** 旧形式の保存値では undefined。 */
    ruleType?: StoppingRuleKind;
}

/** 進み具合の復元に使う、利用者自身の判定1件。 */
export interface ScreenedDecision {
    decision: string;
    /** ISO 文字列。判定した順に並べ替えるために使う。 */
    decidedAt: string;
    /** 「停止基準に到達 → 残りを一括 Exclude」で機械的に付いた判定。読んだ件数に数えない。 */
    auto?: boolean;
}

/** 有効にする停止基準と、それに伴う ML の状態。 */
export interface MlStoppingSetup {
    stoppingRule: StoppingRule;
}

/** chrome.storage から読んだ生の値を保存設定へ正規化する。未保存・未確定は `confirmed: false`。 */
export function parseSavedStoppingRule(raw: unknown): SavedStoppingRule {
    const data = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (!data.confirmed) {
        return { confirmed: false, threshold: DEFAULT_CONSECUTIVE_THRESHOLD };
    }
    const threshold = typeof data.threshold === 'number' && Number.isFinite(data.threshold) && data.threshold > 0
        ? data.threshold
        : DEFAULT_CONSECUTIVE_THRESHOLD;
    const ruleType = data.ruleType === 'cmh' || data.ruleType === 'consecutive' ? data.ruleType : undefined;
    return { confirmed: true, threshold, ruleType };
}

/**
 * 保存設定から、有効にする停止基準の種類を決める。
 *
 * - CMH が使えない件数（`canUseCmhStopping` が偽）では常に連続 Exclude。
 * - `ruleType` があればそれに従う（ダイアログで確定した選択。次回以降も保たれる）。
 * - `ruleType` の無い旧形式は、しきい値が CMH の旧保存値（500）と同じなら CMH とみなす。
 *   CMH ダイアログの確定は「しきい値＝旧保存値」だけを保存していて（CMH の基準は
 *   確定直後に連続 Exclude で上書きされていた）、CMH のつもりで使い始めた利用者の保存値は
 *   必ずこの形になるため。それ以外のしきい値（30・50・100・200・割合プリセット由来の値など）は
 *   連続 Exclude の設定ダイアログで利用者が選んだ値なので、連続 Exclude のまま保つ。
 *   旧形式では「連続 Exclude・500件を明示的に選んだ」場合と区別できず、その場合は CMH に倒れる。
 */
export function resolveStoppingRuleKind(
    saved: Pick<SavedStoppingRule, 'threshold' | 'ruleType'>,
    totalRecords: number
): StoppingRuleKind {
    if (!canUseCmhStopping(totalRecords)) return 'consecutive';
    if (saved.ruleType) return saved.ruleType;
    return saved.threshold === LEGACY_CMH_SAVED_THRESHOLD ? 'cmh' : 'consecutive';
}

/**
 * 判定済みの記録から CMH の進み具合（読んだ件数・include 数・直近のラベル列・停止可否）を作る。
 *
 * 停止可否は updateInterval ごとの更新を再現せず、現在の件数で1回だけ計算する
 * （ウォームアップを終えているときだけ）。判定済みが 0 件なら新規の CMH 基準と同じ。
 */
export function rebuildCmhRule(
    decisions: readonly ScreenedDecision[],
    totalRecords: number
): CmhStoppingRule {
    return rebuildCmhProgress(createCmhStoppingRule(), decisions, totalRecords, true);
}

/** 判定し直した文献は、新しい decidedAt に従ってラベル列の最新の位置へ移る。 */
function rebuildCmhProgress(
    previous: CmhStoppingRule,
    decisions: readonly ScreenedDecision[],
    totalRecords: number,
    forceCalculation: boolean
): CmhStoppingRule {
    const rule = { ...previous };
    const ordered = decisions
        .filter(d => !d.auto && (d.decision === 'include' || d.decision === 'exclude'))
        .map((d, index) => ({ d, index, time: Date.parse(d.decidedAt) }))
        .sort((a, b) => {
            const at = Number.isNaN(a.time) ? 0 : a.time;
            const bt = Number.isNaN(b.time) ? 0 : b.time;
            return at - bt || a.index - b.index;
        })
        .map(x => x.d);

    rule.recentDecisions = ordered.map((d): 0 | 1 => (d.decision === 'include' ? 1 : 0));
    rule.screened = ordered.length;
    rule.included = rule.recentDecisions.filter(x => x === 1).length;
    rule.warmupComplete = rule.screened >= rule.warmupSize;

    if (!rule.warmupComplete) {
        rule.canStop = false;
        rule.probUnderTarget = 1.0;
    } else if (forceCalculation || rule.screened <= previous.screened ||
        Math.floor(rule.screened / rule.updateInterval) > Math.floor(previous.screened / rule.updateInterval)) {
        const result = calculateCmhStopping(
            totalRecords,
            rule.screened,
            rule.included,
            rule.recentDecisions,
            rule.targetRecall,
            rule.confidence
        );
        rule.canStop = result.canStop;
        rule.probUnderTarget = result.minProbTarget;
    }
    return rule;
}

/** 判定1件を反映したあとの停止基準を返す。 */
export function advanceStoppingRule(
    previous: StoppingRule,
    event: { decision: 'include' | 'exclude'; rejudged: boolean },
    decisions: readonly ScreenedDecision[],
    totalRecords: number
): StoppingRule {
    if (previous.type === 'cmh') {
        return rebuildCmhProgress(previous, decisions, totalRecords, false);
    }
    if (event.rejudged && event.decision === 'exclude') return { ...previous };
    return updateConsecutiveStoppingProgress(previous, event.decision);
}

/**
 * 停止基準の種類としきい値から、有効にする基準と ML の状態を作る。
 * 初回の確定でも、再訪での復元でも同じ関数を通す。
 */
export function buildMlStoppingSetup(
    kind: StoppingRuleKind,
    threshold: number,
    totalRecords: number,
    decisions: readonly ScreenedDecision[]
): MlStoppingSetup {
    if (kind === 'cmh') {
        const rule = rebuildCmhRule(decisions, totalRecords);
        return { stoppingRule: rule };
    }
    return { stoppingRule: createStoppingRule(threshold) };
}

/** 再訪時の計画: 未確定ならダイアログ、確定済みなら復元する基準。 */
export type MlStoppingPlan =
    | { action: 'ask' }
    | { action: 'restore'; kind: StoppingRuleKind; setup: MlStoppingSetup };

/** 保存設定と判定済みの記録から、ML タブを開いたときの動作を決める。 */
export function planMlStoppingRule(
    saved: SavedStoppingRule,
    totalRecords: number,
    decisions: readonly ScreenedDecision[]
): MlStoppingPlan {
    if (!saved.confirmed) return { action: 'ask' };
    const kind = resolveStoppingRuleKind(saved, totalRecords);
    return { action: 'restore', kind, setup: buildMlStoppingSetup(kind, saved.threshold, totalRecords, decisions) };
}
