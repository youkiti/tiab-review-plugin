import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「fulltext-page」（全文の判定ページ（PDF を開く別タブ src/fulltext/））。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type FulltextPageEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/fulltext-page.ts に書く。 */
export type FulltextPageCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'fulltext-page');

export const FULLTEXT_PAGE_TOUR: TourFor<FulltextPageEvent, FulltextPageCondition> = {
    id: 'fulltext-page',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'fulltext',
    draft: true,
    steps: [],
};
