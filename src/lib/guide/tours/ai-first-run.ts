import { tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「ai-first-run」（AI 判定の初回）。
 * 中身（手順・固有のイベント・固有の条件）はまだ無い枠。手順を書き終えたら `draft` を外す。
 */

/** このツアー固有のイベント名。使うものを足す（例: `'my-event' | 'other-event'`）。 */
export type AiFirstRunEvent = never;
/** このツアー固有の条件名。使うものを足し、条件の計算は sidepanel/features/guide/conditions/ai-first-run.ts に書く。 */
export type AiFirstRunCondition = never;

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'ai-first-run');

export const AI_FIRST_RUN_TOUR: TourFor<AiFirstRunEvent, AiFirstRunCondition> = {
    id: 'ai-first-run',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    draft: true,
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-llm',
    steps: [],
};
