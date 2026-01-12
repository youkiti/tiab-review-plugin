/**
 * ML 関連の型定義
 */

/** ラベル: 1=include, 0=exclude, -1=unlabeled */
export type Label = 1 | 0 | -1;

/** 文献レコード（ML 用） */
export interface MlRecord {
    refId: string;
    title: string;
    abstract: string;
}

/** 停止基準 */
export interface StoppingRule {
    type: 'n_consecutive_irrelevant';
    threshold: number; // 連続 exclude の閾値
    current: number; // 現在の連続 exclude カウント
}

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
    };
}

/** デフォルトの停止基準を作成 */
export function createStoppingRule(threshold: number): StoppingRule {
    return {
        type: 'n_consecutive_irrelevant',
        threshold,
        current: 0,
    };
}
