import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「resolve-conflicts」（不一致の解消）。
 * 独立判定が終わったあとの流れ。キーの開封は押させない（プロジェクト全体に効くため）。
 * キーが未開封の間は不一致が見えないので、「開封したらもう一度開く」と伝える手順（key-closed）を置く。
 */

/** このツアー固有のイベント名。 */
export type ResolveConflictsEvent =
    | 'conflict-filter-selected' // ステータスフィルターで「不一致」を選んだ
    | 'consensus-mode-on'; // 合議モードのスイッチをオンにした
/** このツアー固有の条件名（計算は sidepanel/features/guide/conditions/resolve-conflicts.ts）。 */
export type ResolveConflictsCondition =
    | 'not-admin' // 管理者でない（Blind のスイッチの行が表示されない）
    | 'key-opened' // キー開封済み（他のレビュアーの判定が見える）
    | 'key-closed' // キー未開封（Blind）
    | 'conflict-banner-shown-or-blind' // 不一致のバナーが出ている、またはキー未開封
    | 'no-other-decisions-shown'; // 他のレビュアーの判定の一覧が出ていない（キー未開封を含む）

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'resolve-conflicts');

export const RESOLVE_CONFLICTS_TOUR: TourFor<ResolveConflictsEvent, ResolveConflictsCondition> = {
    id: 'resolve-conflicts',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    steps: [
        {
            id: 'blind',
            target: 'blind',
            textKey: stepKey(BASE, 'blind'),
            // キーの開封はプロジェクト全体に効くので押させず、説明だけにする
            advance: { type: 'next' },
            blockTarget: true,
            // スイッチの行は管理者にだけ表示される
            skipIf: 'not-admin',
        },
        {
            id: 'key-closed',
            target: 'conflict-filter',
            textKey: stepKey(BASE, 'key-closed'),
            advance: { type: 'next' },
            skipIf: 'key-opened',
        },
        {
            id: 'filter',
            target: 'conflict-filter',
            textKey: stepKey(BASE, 'filter'),
            advance: { type: 'events', events: ['conflict-filter-selected'], optional: true },
            skipIf: 'key-closed',
        },
        {
            id: 'no-conflict',
            target: 'conflict-filter',
            textKey: stepKey(BASE, 'no-conflict'),
            advance: { type: 'next' },
            skipIf: 'conflict-banner-shown-or-blind',
        },
        {
            id: 'others',
            target: 'all-decisions',
            textKey: stepKey(BASE, 'others'),
            advance: { type: 'next' },
            skipIf: 'no-other-decisions-shown',
        },
        {
            id: 'consensus',
            target: 'consensus-mode',
            textKey: stepKey(BASE, 'consensus'),
            // スイッチは押すと判定の記録のされ方が変わるだけで、オフに戻せる。実際に切り替えてもよい手順にする
            advance: { type: 'events', events: ['consensus-mode-on'], optional: true },
            skipIf: 'key-closed',
        },
        {
            id: 'redecide',
            target: 'decision-buttons',
            textKey: stepKey(BASE, 'redecide'),
            // 判定の保存は実データを変えるので、押さずに次へも出す
            advance: { type: 'events', events: ['decision-saved'], optional: true },
            skipIf: 'key-closed',
            scroll: 'if-hidden',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
