import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「ml-start」（ML の開始）。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type MlStartEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/ml-start.ts に書く。 */
export type MlStartCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'ml-start');

export const ML_START_TOUR: TourFor<MlStartEvent, MlStartCondition> = {
    id: 'ml-start',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    draft: true,
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-ml',
    steps: [],
};
