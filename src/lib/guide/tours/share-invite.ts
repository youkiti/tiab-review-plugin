import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「share-invite」（共有と招待）。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type ShareInviteEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/share-invite.ts に書く。 */
export type ShareInviteCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'share-invite');

export const SHARE_INVITE_TOUR: TourFor<ShareInviteEvent, ShareInviteCondition> = {
    id: 'share-invite',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    draft: true,
    steps: [],
};
