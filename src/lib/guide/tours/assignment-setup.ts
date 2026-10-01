import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「assignment-setup」（分担の設定（担当セットのウィザード））。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type AssignmentSetupEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/assignment-setup.ts に書く。 */
export type AssignmentSetupCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'assignment-setup');

export const ASSIGNMENT_SETUP_TOUR: TourFor<AssignmentSetupEvent, AssignmentSetupCondition> = {
    id: 'assignment-setup',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    draft: true,
    steps: [],
};
