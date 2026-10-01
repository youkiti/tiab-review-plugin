import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「assignment-setup」（分担の設定（担当セットのウィザード））。
 * 手動タブ → 設定画面 → 案内カード → ウィザード（キャリブレーション件数・チーム数・担当者・作成）→ 作成後の設定画面
 * （担当者の保存・再シャッフル）→ 手動タブの担当セット、の順。作成は費用ではなく実データを書き換える操作なので
 * `optional`（「押さずに次へ」でも進める）。再シャッフルは全件を振り直すので `blockTarget`。
 * 担当分けの設定欄は管理者にしか出ないので、管理者でない人にはこのツアーを出さない（`unavailableIf`）。
 */

/** このツアー固有のイベント名。 */
export type AssignmentSetupEvent =
    | 'settings-opened' // 設定画面を開いた
    | 'settings-closed' // 設定画面を閉じた
    | 'assignment-wizard-opened' // 担当セットのウィザードが開いた
    | 'assignment-created' // 担当セットの作成（割り振りの書き込み）に成功した
    | 'assignment-dismissed' // 「今回は分割しない」を保存した
    | 'assignment-map-saved'; // 設定画面で担当者を保存した
/** このツアー固有の条件名。条件の真偽は下の純関数 assignmentSetupConditions が作る。 */
export type AssignmentSetupCondition =
    | 'tab-step-unneeded' // 設定画面・ウィザードが開いている、手動タブにいる、または管理者でない
    | 'settings-step-unneeded' // 設定画面にいる、ウィザードが開いている、または管理者でない
    | 'banner-unneeded' // ウィザードが開いている、担当セットが作成済み、または管理者でない
    | 'wizard-closed' // ウィザードが開いていない
    | 'reopen-unneeded' // 設定画面にいる、担当セットが未作成、または管理者でない
    | 'map-steps-unneeded' // 担当セットが未作成、または管理者でない
    | 'manual-tab-open-or-not-admin' // 手動タブにいる、または管理者でない
    | 'sets-unneeded' // 担当セットの欄が出ていない、または管理者でない
    | 'admin-or-unconnected' // 管理者、またはプロジェクトに接続していない（非管理者向けの案内を出さない）
    | 'not-admin-connected'; // プロジェクトに接続していて、管理者でない（一覧・提案から外す）

/** 条件の計算に使う画面の状態（テストで差し替えられるよう、引数で受ける）。 */
export interface AssignmentSetupInput {
    /** ui.view（'login' | 'project' | 'screening' | 'llm' | 'ml' | 'settings'）。タブはスクリーニング画面（'screening'）の中の切替 */
    view: string;
    currentTab: string;
    spreadsheetId: string;
    isAdmin: boolean;
    configured: boolean;
    assignmentSetCount: number;
    wizardOpen: boolean;
}

/**
 * 条件の真偽を、画面の状態から作る純関数。管理者かどうかは、プロジェクトに接続しているときだけ決まる
 * （プロジェクト選択画面では未定なので「管理者でない」とは扱わない）。
 */
export function assignmentSetupConditions(input: AssignmentSetupInput): Record<AssignmentSetupCondition, boolean> {
    const connected = input.view !== 'login' && input.view !== 'project' && input.spreadsheetId !== '';
    const nonAdmin = connected && !input.isAdmin;
    const onSettings = input.view === 'settings';
    const onManualTab = input.view === 'screening' && input.currentTab === 'screening';
    const hasSets = input.configured && input.assignmentSetCount > 0;
    return {
        'tab-step-unneeded': onSettings || input.wizardOpen || onManualTab || nonAdmin,
        'settings-step-unneeded': onSettings || input.wizardOpen || nonAdmin,
        'banner-unneeded': input.wizardOpen || input.configured || nonAdmin,
        'wizard-closed': !input.wizardOpen,
        'reopen-unneeded': onSettings || !input.configured || nonAdmin,
        'map-steps-unneeded': !input.configured || nonAdmin,
        'manual-tab-open-or-not-admin': onManualTab || nonAdmin,
        'sets-unneeded': !hasSets || nonAdmin,
        'admin-or-unconnected': !nonAdmin,
        'not-admin-connected': nonAdmin,
    };
}

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'assignment-setup');

export const ASSIGNMENT_SETUP_TOUR: TourFor<AssignmentSetupEvent, AssignmentSetupCondition> = {
    id: 'assignment-setup',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    unavailableIf: 'not-admin-connected',
    steps: [
        {
            id: 'open-manual-tab',
            target: 'tab-screening',
            textKey: stepKey(BASE, 'open-manual-tab'),
            advance: { type: 'events', events: ['tab-opened-screening'] },
            skipIf: 'tab-step-unneeded',
        },
        {
            id: 'open-settings',
            target: 'settings-open',
            textKey: stepKey(BASE, 'open-settings'),
            advance: { type: 'events', events: ['settings-opened'] },
            skipIf: 'settings-step-unneeded',
        },
        {
            id: 'banner',
            target: 'assignment-banner-open',
            textKey: stepKey(BASE, 'banner'),
            advance: { type: 'events', events: ['assignment-wizard-opened'] },
            skipIf: 'banner-unneeded',
        },
        {
            id: 'wizard-numbers',
            target: 'assignment-wizard-numbers',
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
            skipIf: 'reopen-unneeded',
        },
        {
            id: 'save-map',
            target: 'assignment-reviewer-map',
            textKey: stepKey(BASE, 'save-map'),
            advance: { type: 'events', events: ['assignment-map-saved'], optional: true },
            skipIf: 'map-steps-unneeded',
        },
        {
            id: 'reshuffle',
            target: 'assignment-reshuffle',
            textKey: stepKey(BASE, 'reshuffle'),
            advance: { type: 'next' },
            blockTarget: true,
            skipIf: 'map-steps-unneeded',
        },
        {
            id: 'close-settings',
            target: 'settings-close',
            textKey: stepKey(BASE, 'close-settings'),
            advance: { type: 'events', events: ['settings-closed'] },
            skipIf: 'on-screening-screen',
        },
        {
            id: 'back-to-manual-tab',
            target: 'tab-screening',
            textKey: stepKey(BASE, 'back-to-manual-tab'),
            advance: { type: 'events', events: ['tab-opened-screening'] },
            skipIf: 'manual-tab-open-or-not-admin',
        },
        {
            id: 'sets',
            target: 'assignment-sets',
            textKey: stepKey(BASE, 'sets'),
            advance: { type: 'next' },
            skipIf: 'sets-unneeded',
        },
        {
            id: 'not-admin',
            target: 'tour-list',
            textKey: stepKey(BASE, 'not-admin'),
            advance: { type: 'next' },
            skipIf: 'admin-or-unconnected',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
