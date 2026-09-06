import { t } from '../../lib/i18n';
import { showToast } from './feedback';

/** 読み込み失敗には再試行手順、それ以外の起動失敗には原因を表示する。 */
export function reportFeatureLoadError(error: unknown, feature: 'ml' | 'llm' | 'fulltext'): void {
    const isChunkLoadError = error instanceof Error
        && (error.name === 'ChunkLoadError' || /Loading chunk/i.test(error.message));
    if (isChunkLoadError) {
        showToast(t(`${feature}_featureLoadFailed`), 5000);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    showToast(t(`${feature}_activationFailed`, [message]), 5000);
}
