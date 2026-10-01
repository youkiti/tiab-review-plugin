import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「duplicate-review」（重複の確認）。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type DuplicateReviewEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/duplicate-review.ts に書く。 */
export type DuplicateReviewCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'duplicate-review');

export const DUPLICATE_REVIEW_TOUR: TourFor<DuplicateReviewEvent, DuplicateReviewCondition> = {
    id: 'duplicate-review',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    draft: true,
    steps: [],
};
