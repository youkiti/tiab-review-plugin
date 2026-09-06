/**
 * CMH 停止規則のデフォルト値（定数のみ）。
 *
 * jstat 依存を持たない定数として cmh.ts から切り出したモジュール。
 * lib/ml/types.ts（共有の状態型・ファクトリ）が cmh.ts 経由で jstat（統計ライブラリ）を
 * 巻き込まないようにするため分離した。
 */
export const CMH_DEFAULTS = {
    targetRecall: 0.99,
    confidence: 0.95,
    minRecords: 1000,
    initialRandomSize: 500,
    updateInterval: 15,
    auditSampleSize: 200,
} as const;

/**
 * CMH 停止基準が有効かどうかを判定
 *
 * @param totalRecords - 総レコード数
 * @returns true なら CMH 停止基準を使用可能
 */
export function canUseCmhStopping(totalRecords: number): boolean {
    return totalRecords >= CMH_DEFAULTS.minRecords;
}
