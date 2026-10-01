import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「ml-start」（ML の開始）。
 * ML タブは文献が 1,000 件以上のプロジェクトでだけ開ける。使えないプロジェクトでは、手順を飛ばして
 * 「使えない」と伝える `unavailable` の手順で終える（土台の一覧・提案は件数を見ないため、ツアー側で受ける）。
 */

/** このツアー固有のイベント名 */
export type MlStartEvent =
    | 'ml-setup-done' // 停止基準の確認が済み、ML の学習が使える状態になった
    | 'ml-decision-saved'; // ML タブで判定を保存した
/** このツアー固有の条件名（計算は sidepanel/features/guide/conditions/ml-start.ts） */
export type MlStartCondition =
    | 'ml-unusable' // スクリーニング画面にいて、文献が ML タブの最小件数に満たない
    | 'ml-usable' // 上の否定（画面がまだ分からないときも真）
    | 'ml-tab-open-or-unusable' // ML タブを開いている、または使えない
    | 'ml-tab-open' // ML タブを開いている
    | 'ml-tab-closed' // ML タブを開いていない
    | 'ml-dialog-not-needed'; // 停止基準の確認ダイアログを待つ必要が無い（使えない、または停止基準が設定済み）

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'ml-start');

export const ML_START_TOUR: TourFor<MlStartEvent, MlStartCondition> = {
    id: 'ml-start',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    // ML タブを使える人（管理者に限らない）
    audience: 'participant',
    page: 'sidepanel',
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-ml',
    steps: [
        {
            id: 'open-tab',
            target: 'ml-tab',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-ml'] },
            skipIf: 'ml-tab-open-or-unusable',
        },
        {
            id: 'stopping-dialog',
            target: 'ml-stopping-confirm',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'stopping-dialog'),
            advance: { type: 'events', events: ['ml-setup-done'], optional: true },
            skipIf: 'ml-dialog-not-needed',
        },
        {
            id: 'decide',
            target: 'ml-decision-buttons',
            textKey: stepKey(BASE, 'decide'),
            advance: { type: 'events', events: ['ml-decision-saved'], optional: true },
            skipIf: 'ml-unusable',
            scroll: 'if-hidden',
        },
        {
            id: 'learning-state',
            target: 'ml-stats',
            textKey: stepKey(BASE, 'learning-state'),
            advance: { type: 'next' },
            skipIf: 'ml-unusable',
            scroll: 'if-hidden',
        },
        {
            id: 'stopping-progress',
            target: 'ml-stopping',
            textKey: stepKey(BASE, 'stopping-progress'),
            advance: { type: 'next' },
            skipIf: 'ml-unusable',
            scroll: 'if-hidden',
        },
        {
            id: 'stopping-reached',
            target: 'ml-stopping',
            textKey: stepKey(BASE, 'stopping-reached'),
            advance: { type: 'next' },
            skipIf: 'ml-unusable',
            scroll: 'if-hidden',
        },
        {
            id: 'unavailable',
            target: 'ml-tab',
            textKey: stepKey(BASE, 'unavailable'),
            advance: { type: 'next' },
            skipIf: 'ml-usable',
        },
        {
            // ML タブには ❓（ツアー一覧）が無いので、ML タブにいる間は、画面内の「?」を指して終える
            id: 'finish-ml',
            target: 'ml-help',
            textKey: stepKey(BASE, 'finish-ml'),
            advance: { type: 'next' },
            skipIf: 'ml-tab-closed',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
            skipIf: 'ml-tab-open',
        },
    ],
};
