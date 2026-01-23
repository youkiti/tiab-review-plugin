/**
 * スクリーニングログ
 * 
 * 再現性と説明責任のためのログ機能
 */

import { CmhStoppingRule } from './types';

/** ログエントリの種類 */
export type ScreeningLogEventType =
    | 'session_start'
    | 'label'
    | 'retrain'
    | 'cmh_update'
    | 'stop_proposed'
    | 'stop_confirmed'
    | 'stop_cancelled'
    | 'audit_start'
    | 'audit_complete';

/** ログエントリ */
export interface ScreeningLogEntry {
    timestamp: number;
    event: ScreeningLogEventType;
    data: Record<string, unknown>;
}

/** スクリーニングログ */
export interface ScreeningLog {
    version: string;
    startedAt: number;
    totalRecords: number;
    // 初期設定
    initialRandomSeed: number;
    initialRandomIds: string[];
    targetRecall: number;
    confidence: number;
    // エントリ
    entries: ScreeningLogEntry[];
}

/**
 * 新しいログを作成
 */
export function createScreeningLog(
    totalRecords: number,
    seed: number,
    initialIds: string[],
    rule: CmhStoppingRule
): ScreeningLog {
    return {
        version: '1.0',
        startedAt: Date.now(),
        totalRecords,
        initialRandomSeed: seed,
        initialRandomIds: initialIds,
        targetRecall: rule.targetRecall,
        confidence: rule.confidence,
        entries: [{
            timestamp: Date.now(),
            event: 'session_start',
            data: {
                totalRecords,
                targetRecall: rule.targetRecall,
                confidence: rule.confidence,
                initialRandomSize: rule.initialRandomSize,
            },
        }],
    };
}

/**
 * ログにエントリを追加
 */
export function addLogEntry(
    log: ScreeningLog,
    event: ScreeningLogEventType,
    data: Record<string, unknown>
): ScreeningLog {
    return {
        ...log,
        entries: [
            ...log.entries,
            {
                timestamp: Date.now(),
                event,
                data,
            },
        ],
    };
}

/**
 * ラベル付けイベントをログに追加
 */
export function logLabelEvent(
    log: ScreeningLog,
    refId: string,
    decision: 'include' | 'exclude',
    screenedCount: number,
    includedCount: number
): ScreeningLog {
    return addLogEntry(log, 'label', {
        refId,
        decision,
        screenedCount,
        includedCount,
    });
}

/**
 * CMH 更新イベントをログに追加
 */
export function logCmhUpdateEvent(
    log: ScreeningLog,
    minProbTarget: number,
    canStop: boolean,
    screenedCount: number,
    includedCount: number
): ScreeningLog {
    return addLogEntry(log, 'cmh_update', {
        minProbTarget,
        canStop,
        screenedCount,
        includedCount,
    });
}

/**
 * 停止提案イベントをログに追加
 */
export function logStopProposedEvent(
    log: ScreeningLog,
    minProbTarget: number,
    screenedCount: number,
    includedCount: number,
    remainingCount: number
): ScreeningLog {
    return addLogEntry(log, 'stop_proposed', {
        minProbTarget,
        screenedCount,
        includedCount,
        remainingCount,
    });
}

/**
 * 停止確定イベントをログに追加
 */
export function logStopConfirmedEvent(
    log: ScreeningLog,
    screenedCount: number,
    includedCount: number,
    remainingCount: number
): ScreeningLog {
    return addLogEntry(log, 'stop_confirmed', {
        screenedCount,
        includedCount,
        remainingCount,
    });
}

/**
 * ログを JSON としてエクスポート
 */
export function exportLogAsJson(log: ScreeningLog): string {
    return JSON.stringify(log, null, 2);
}

/**
 * ログをサマリ形式でエクスポート
 */
export function exportLogSummary(log: ScreeningLog): string {
    const labelEvents = log.entries.filter(e => e.event === 'label');
    const includeCount = labelEvents.filter(e => e.data.decision === 'include').length;
    const excludeCount = labelEvents.filter(e => e.data.decision === 'exclude').length;

    const stopEvent = log.entries.find(e => e.event === 'stop_confirmed');

    return `
# スクリーニングログサマリ

## 設定
- 総レコード数: ${log.totalRecords}
- 目標リコール: ${(log.targetRecall * 100).toFixed(1)}%
- 信頼水準: ${(log.confidence * 100).toFixed(1)}%
- 初期ランダムシード: ${log.initialRandomSeed}
- 初期ランダム件数: ${log.initialRandomIds.length}

## 結果
- スクリーニング開始: ${new Date(log.startedAt).toISOString()}
- Include: ${includeCount}
- Exclude: ${excludeCount}
- 合計ラベル数: ${labelEvents.length}
${stopEvent ? `- 停止確定: ${new Date(stopEvent.timestamp).toISOString()}` : '- 停止: 未確定'}
`.trim();
}
