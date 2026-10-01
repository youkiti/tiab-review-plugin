import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「assignment-setup」（分担の設定（担当セットのウィザード））。
 * 設定画面 → 案内カード → ウィザード（キャリブレーション件数・チーム数・担当者・作成）→ 作成後の設定画面
 * （担当者の保存・再シャッフル）→ 手動タブの担当セット、の順。作成は費用ではなく実データを書き換える操作なので
 * `optional`（「押さずに次へ」でも進める）。再シャッフルは全件を振り直すので `blockTarget`。
 */

/** このツアー固有のイベント名。 */
export type AssignmentSetupEvent =
    | 'settings-opened' // 設定画面を開いた
    | 'settings-closed' // 設定画面を閉じた
    | 'assignment-wizard-opened' // 担当セットのウィザードが開いた
    | 'assignment-created' // 担当セットの作成（割り振りの書き込み）に成功した
    | 'assignment-dismissed' // 「今回は分割しない」を保存した
    | 'assignment-map-saved'; // 設定画面で担当者を保存した
/** このツアー固有の条件名。条件の計算は sidepanel/features/guide/conditions/assignment-setup.ts。 */
export type AssignmentSetupCondition =
    | 'settings-screen-or-wizard-open' // 設定画面にいるか、ウィザードが開いている
    | 'wizard-open-or-configured' // ウィザードが開いているか、担当セットが作成済み
    | 'wizard-closed' // ウィザードが開いていない
    | 'settings-screen-or-unconfigured' // 設定画面にいるか、担当セットが未作成
    | 'assignment-unconfigured'; // 担当セットが未作成

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'assignment-setup');

export const ASSIGNMENT_SETUP_TOUR: TourFor<AssignmentSetupEvent, AssignmentSetupCondition> = {
    id: 'assignment-setup',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    steps: [
        {
            id: 'open-settings',
            target: 'settings-open',
            textKey: stepKey(BASE, 'open-settings'),
            advance: { type: 'events', events: ['settings-opened'] },
            skipIf: 'settings-screen-or-wizard-open',
        },
        {
            id: 'banner',
            target: 'assignment-banner-open',
            textKey: stepKey(BASE, 'banner'),
            advance: { type: 'events', events: ['assignment-wizard-opened'] },
            skipIf: 'wizard-open-or-configured',
        },
        {
            id: 'wizard-numbers',
            target: 'assignment-wizard-preview',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'wizard-numbers'),
            advance: { type: 'next' },
            skipIf: 'wizard-closed',
        },
        {
            id: 'wizard-reviewers',
            target: 'assignment-wizard-reviewers',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'wizard-reviewers'),
            advance: { type: 'next' },
            skipIf: 'wizard-closed',
        },
        {
            id: 'wizard-create',
            target: 'assignment-wizard-create',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'wizard-create'),
            advance: { type: 'events', events: ['assignment-created', 'assignment-dismissed'], optional: true },
            skipIf: 'wizard-closed',
        },
        {
            id: 'reopen-settings',
            target: 'settings-open',
            textKey: stepKey(BASE, 'reopen-settings'),
            advance: { type: 'events', events: ['settings-opened'] },
            skipIf: 'settings-screen-or-unconfigured',
        },
        {
            id: 'save-map',
            target: 'assignment-reviewer-map',
            textKey: stepKey(BASE, 'save-map'),
            advance: { type: 'events', events: ['assignment-map-saved'], optional: true },
            skipIf: 'assignment-unconfigured',
        },
        {
            id: 'reshuffle',
            target: 'assignment-reshuffle',
            textKey: stepKey(BASE, 'reshuffle'),
            advance: { type: 'next' },
            blockTarget: true,
            skipIf: 'assignment-unconfigured',
        },
        {
            id: 'close-settings',
            target: 'settings-close',
            textKey: stepKey(BASE, 'close-settings'),
            advance: { type: 'events', events: ['settings-closed'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'sets',
            target: 'assignment-sets',
            textKey: stepKey(BASE, 'sets'),
            advance: { type: 'next' },
            skipIf: 'no-assignment-sets',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
