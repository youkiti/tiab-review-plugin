/**
 * ML 関連の型定義
 */

import { CMH_DEFAULTS } from './cmh-defaults';

/** ラベル: 1=include, 0=exclude, -1=unlabeled */
export type Label = 1 | 0 | -1;

/** 文献レコード（ML 用） */
export interface MlRecord {
    refId: string;
    title: string;
    abstract: string;
}

/** 停止基準タイプ */
export type StoppingRuleType = 'n_consecutive_irrelevant' | 'cmh';

/** 旧停止基準（連続除外） */
export interface ConsecutiveStoppingRule {
    type: 'n_consecutive_irrelevant';
    threshold: number; // 連続 exclude の閾値
    current: number; // 現在の連続 exclude カウント
}

/** CMH 停止基準 */
export interface CmhStoppingRule {
    type: 'cmh';
    targetRecall: number;      // 目標リコール (既定 0.99)
    confidence: number;        // 信頼水準 (既定 0.95)
    minRecords: number;        // 最小レコード数 (既定 1000)
    initialRandomSize: number; // 初期ランダム区間 (既定 500)
    updateInterval: number;    // 判定更新頻度 (既定 15)
    // 現在の状態
    screened: number;          // 既読数
    included: number;          // include 数
    initialPhaseComplete: boolean; // 初期フェーズ完了フラグ
    canStop: boolean;          // 停止可能フラグ
    probUnderTarget: number;   // 現在の min_prob_target
    // ラベル履歴（CMH 計算用）
    recentDecisions: (0 | 1)[]; // 直近のラベル列
}

/** 停止基準（Union型） */
export type StoppingRule = ConsecutiveStoppingRule | CmhStoppingRule;

/** スクリーニングフェーズ */
export type ScreeningPhase = 'initial_random' | 'prioritized';

/** ML 状態 */
export interface MlState {
    status: 'idle' | 'initializing' | 'training' | 'ready' | 'error';
    labeledCount: {
        include: number;
        exclude: number;
    };
    stoppingRule: StoppingRule | null;
    ranking: string[]; // ref_id の配列（推薦順）
    currentIndex: number; // 現在表示中のインデックス
    lastUpdated: number;
    errorMessage?: string;
    // CMH 追加フィールド
    screeningPhase?: ScreeningPhase;
    initialRandomSeed?: number;
    initialRandomIds?: string[];
}

/** Worker へのメッセージ */
export type MlWorkerMessage =
    | { type: 'init'; records: MlRecord[]; labels: Record<string, Label> }
    | { type: 'updateLabels'; labels: Record<string, Label> }
    | { type: 'reset' };

/** Worker からのレスポンス */
export type MlWorkerResponse =
    | {
        type: 'ready';
        ranking: string[];
        stats: { include: number; exclude: number };
    }
    | {
        type: 'updated';
        ranking: string[];
        stats: { include: number; exclude: number };
    }
    | { type: 'error'; message: string }
    | { type: 'progress'; stage: string; percent: number };

/** ラベル統計 */
export interface LabelStats {
    include: number;
    exclude: number;
    unlabeled: number;
    total: number;
}

/** 初期状態 */
export function createInitialMlState(): MlState {
    return {
        status: 'idle',
        labeledCount: { include: 0, exclude: 0 },
        stoppingRule: null,
        ranking: [],
        currentIndex: 0,
        lastUpdated: 0,
        screeningPhase: undefined,
        initialRandomSeed: undefined,
        initialRandomIds: undefined,
    };
}

/** 旧停止基準を作成（後方互換性のため残す） */
export function createStoppingRule(threshold: number): ConsecutiveStoppingRule {
    return {
        type: 'n_consecutive_irrelevant',
        threshold,
        current: 0,
    };
}

/** CMH 停止基準を作成 */
export function createCmhStoppingRule(
    options?: Partial<Pick<CmhStoppingRule, 'targetRecall' | 'confidence' | 'minRecords' | 'initialRandomSize' | 'updateInterval'>>
): CmhStoppingRule {
    return {
        type: 'cmh',
        targetRecall: options?.targetRecall ?? CMH_DEFAULTS.targetRecall,
        confidence: options?.confidence ?? CMH_DEFAULTS.confidence,
        minRecords: options?.minRecords ?? CMH_DEFAULTS.minRecords,
        initialRandomSize: options?.initialRandomSize ?? CMH_DEFAULTS.initialRandomSize,
        updateInterval: options?.updateInterval ?? CMH_DEFAULTS.updateInterval,
        screened: 0,
        included: 0,
        initialPhaseComplete: false,
        canStop: false,
        probUnderTarget: 1.0,
        recentDecisions: [],
    };
}

/** 旧停止基準から CMH に移行 */
export function migrateToCmhRule(oldState: MlState): MlState {
    const cmhRule = createCmhStoppingRule();

    // 既存のラベル数を引き継ぐ
    cmhRule.screened = oldState.labeledCount.include + oldState.labeledCount.exclude;
    cmhRule.included = oldState.labeledCount.include;
    // 既にスクリーニング中なので初期フェーズは完了扱い（保守的に）
    cmhRule.initialPhaseComplete = cmhRule.screened >= cmhRule.initialRandomSize;

    return {
        ...oldState,
        stoppingRule: cmhRule,
        screeningPhase: 'prioritized', // 既にスクリーニング中
    };
}

/** StoppingRule が CMH 型かどうかを判定 */
export function isCmhStoppingRule(rule: StoppingRule | null): rule is CmhStoppingRule {
    return rule !== null && rule.type === 'cmh';
}
