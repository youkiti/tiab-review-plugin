import { stepKey, tourKeyBase } from './keys';
import type { TourFor } from './types';

/**
 * ツアー「share-invite」（共有と招待）。
 * 共有の追加は実際に相手へ編集権限が付く（フォルダがあるプロジェクトではフォルダごと共有される）ので optional、
 * 共有済みユーザーの解除（✕）は取り消しが面倒なので押せない説明の手順にする。
 */

/** このツアー固有のイベント名。 */
export type ShareInviteEvent =
    | 'share-panel-opened' // 共有パネルを開き、共有済みユーザーの一覧の描画が済んだ
    | 'share-added' // 共有の追加に成功した（パネルは閉じる）
    | 'share-panel-closed' // 共有パネルが閉じた
    | 'invite-copied'; // 招待文をクリップボードへコピーできた
/** このツアー固有の条件名。条件の計算は sidepanel/features/guide/conditions/share-invite.ts に書く。 */
export type ShareInviteCondition =
    | 'share-panel-open' // 共有パネルが開いている
    | 'no-link-share' // 共有済みの一覧に「リンクを知っている全員」の警告が出ていない
    | 'share-panel-closed-or-no-team-progress' // 共有パネルが閉じている、またはチーム進捗のチップが無い（閉じてもらう必要が無い）
    | 'has-team-progress' // チーム進捗のチップが出ている（メンバーが2人以上）
    | 'no-team-progress';

// 拡張版だけのツアーなので、`guideExt_` 接頭辞（Web 版ビルドが落とす）。
const BASE = tourKeyBase('guideExt_tour_', 'share-invite');

export const SHARE_INVITE_TOUR: TourFor<ShareInviteEvent, ShareInviteCondition> = {
    id: 'share-invite',
    titleKey: `${BASE}_title`,
    descriptionKey: `${BASE}_desc`,
    platforms: ['extension'],
    audience: 'admin',
    page: 'sidepanel',
    steps: [
        {
            id: 'open-share',
            target: 'share-btn',
            textKey: stepKey(BASE, 'open-share'),
            advance: { type: 'events', events: ['share-panel-opened'] },
            skipIf: 'share-panel-open',
        },
        {
            id: 'add',
            target: 'share-submit-btn',
            textKey: stepKey(BASE, 'add'),
            advance: { type: 'events', events: ['share-added'], optional: true },
        },
        {
            // 追加に成功すると共有パネルは閉じるので、続きを見るために開き直してもらう
            id: 'reopen-share',
            target: 'share-btn',
            textKey: stepKey(BASE, 'reopen-share'),
            advance: { type: 'events', events: ['share-panel-opened'] },
            skipIf: 'share-panel-open',
        },
        {
            id: 'link-warning',
            target: 'share-link-warning',
            dynamicTarget: true,
            textKey: stepKey(BASE, 'link-warning'),
            advance: { type: 'next' },
            skipIf: 'no-link-share',
        },
        {
            // ✕ は行ごとに動的に作られるので、一覧全体を対象にして覆う（押せない）
            id: 'shared-users',
            target: 'shared-users',
            textKey: stepKey(BASE, 'shared-users'),
            advance: { type: 'next' },
            blockTarget: true,
        },
        {
            id: 'copy-invite',
            target: 'share-copy-invite-btn',
            textKey: stepKey(BASE, 'copy-invite'),
            advance: { type: 'events', events: ['invite-copied'], optional: true },
        },
        {
            // 共有パネルはチーム進捗のチップに重なるので、閉じてから説明する
            id: 'close-share',
            target: 'share-btn',
            textKey: stepKey(BASE, 'close-share'),
            advance: { type: 'events', events: ['share-panel-closed'] },
            skipIf: 'share-panel-closed-or-no-team-progress',
        },
        {
            id: 'team-progress',
            target: 'team-progress-host',
            textKey: stepKey(BASE, 'team-progress'),
            advance: { type: 'next' },
            skipIf: 'no-team-progress',
        },
        {
            // チップはメンバーが1人のうちは出ないので、出るようになる条件を伝える
            id: 'team-progress-later',
            target: 'share-btn',
            textKey: stepKey(BASE, 'team-progress-later'),
            advance: { type: 'next' },
            skipIf: 'has-team-progress',
        },
        {
            id: 'finish',
            target: 'tour-list',
            textKey: stepKey(BASE, 'finish'),
            advance: { type: 'next' },
        },
    ],
};
