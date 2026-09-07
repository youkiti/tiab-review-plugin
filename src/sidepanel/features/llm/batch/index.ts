/**
 * LLMバッチ処理モジュール - 公開APIの再export（Issue #191）
 *
 * 元 `batch.ts`（1,393行）を `./run`（実行制御）・`./target-count`（画面更新：対象件数・
 * 実行モード表示）・`./threshold`（閾値調整・採用操作）・`./history`（実行履歴）へ分割し、
 * このファイルは薄い入口として公開APIを再exportするのみ。
 * TypeScript も `scripts/check-structure.mjs` も `./batch` を `./batch/index.ts` へ解決するため、
 * `features/llm/index.ts` など既存の `from './batch'` という import 経路はそのまま動く。
 *
 * `./threshold` の `prepareThresholdAdjustment` と `./history` の `loadExecutionHistory` は
 * 互いに必要とし合う関係にあり、直接 import し合うと `./threshold` <-> `./history` の
 * 循環依存になってしまう（`node scripts/check-structure.mjs` の循環検出対象）。そのため
 * `./history` 側に `setPrepareThresholdAdjustment` という注入口を用意し、このファイルが
 * モジュール読み込み時に一度だけ配線する。挙動は直接 import していたときと変わらない。
 */

import { prepareThresholdAdjustment } from './threshold';
import { setPrepareThresholdAdjustment } from './history';

// ./threshold <-> ./history の循環依存を避けるための配線（ファイル冒頭の説明を参照）
setPrepareThresholdAdjustment(prepareThresholdAdjustment);

export {
    handleToggleRestartRun,
    handleStartBatch,
    handleStopBatch,
    handleRetryFailed,
    updateBatchProgress,
} from './run';

export {
    updateBatchTargetCount,
} from './target-count';

export {
    setLoadDataAndShowScreening,
    handleThresholdChange,
    toggleDistributionChart,
    renderDistributionChart,
    handleConfirmThreshold,
} from './threshold';

export {
    loadExecutionHistory,
} from './history';
