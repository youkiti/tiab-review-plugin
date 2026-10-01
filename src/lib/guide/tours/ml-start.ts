import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「ml-start」（ML の開始）。
 * ML タブは文献が 1,000 件以上のプロジェクトでだけ開ける。使えないプロジェクトでは `unavailableIf` で
 * 一覧・「?」の吹き出し・提案・開始から外す。
 */

/** このツアー固有のイベント名 */
export type MlStartEvent =
    | 'ml-setup-done' // 停止基準の確認が済み、ML の学習が使える状態になった
    | 'ml-decision-saved'; // ML タブで判定を保存した
/** このツアー固有の条件名（計算は sidepanel/features/guide/conditions/ml-start.ts） */
export type MlStartCondition =
    | 'ml-unusable' // スクリーニング画面にいて、文献が ML タブの最小件数に満たない（ツアー全体の unavailableIf）
    | 'ml-tab-open' // ML タブを開いている
    | 'ml-dialog-not-needed'; // 停止基準の確認ダイアログを待つ必要が無い（停止基準が設定済み）

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'ml-start');

export const ML_START_TOUR: TourFor<MlStartEvent, MlStartCondition> = {
    id: 'ml-start',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    // ML タブを使える人（管理者に限らない）
    audience: 'participant',
    unavailableIf: 'ml-unusable',
    page: 'sidepanel',
    // このタブを開いたときに提案する（初期バンドルの lazy.ts の SUGGEST_TOUR_BY_EVENT と合わせる）
    suggestOn: 'tab-opened-ml',
    steps: [
        {
            id: 'open-tab',
            target: 'ml-tab',
            textKey: stepKey(BASE, 'open-tab'),
            advance: { type: 'events', events: ['tab-opened-ml'] },
            skipIf: 'ml-tab-open',
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
            scroll: 'if-hidden',
        },
        {
            id: 'learning-state',
            target: 'ml-stats',
            textKey: stepKey(BASE, 'learning-state'),
            advance: { type: 'next' },
            scroll: 'if-hidden',
        },
        {
            id: 'stopping-progress',
            target: 'ml-stopping',
            textKey: stepKey(BASE, 'stopping-progress'),
            advance: { type: 'next' },
            scroll: 'if-hidden',
        },
        {
            id: 'stopping-reached',
            target: 'ml-stopping',
            textKey: stepKey(BASE, 'stopping-reached'),
            advance: { type: 'next' },
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
