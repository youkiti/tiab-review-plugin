/**
 * ツアー「ml-start」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/ml-start.ts の MlStartCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { MlStartCondition } from '../../../../lib/guide/tours/ml-start';
import { canUseCmhStopping } from '../../../../lib/ml/cmh-defaults';
import { state } from '../../../state';
import { getState } from '../../../store';

export function computeMlStartConditions(): Record<MlStartCondition, boolean> {
    const onScreening = getState().ui.view === 'screening';
    // 画面がまだ分からない（プロジェクトを開いていない）間は「使えない」とは言わない。
    // ML タブを開けるかの判定は features/ml/lazy.ts の activateMlTab と同じ（canUseCmhStopping）
    const unusable = onScreening && !canUseCmhStopping(state.references.length);
    const onMlTab = onScreening && state.currentTab === 'ml';
    return {
        'ml-unusable': unusable,
        'ml-tab-open': onMlTab,
        'ml-dialog-not-needed': state.mlState.stoppingRule !== null,
    };
}
