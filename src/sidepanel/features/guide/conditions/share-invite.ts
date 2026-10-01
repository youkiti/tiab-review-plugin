/**
 * ツアー「share-invite」固有の条件（手順の skipIf）の計算。
 * 条件名は src/lib/guide/tours/share-invite.ts の ShareInviteCondition に足し、ここで全部の真偽を返す
 * （返す型が条件名を網羅していないとコンパイルが通らない）。遅延チャンク `guide-feature` に入る。
 */
import type { ShareInviteCondition } from '../../../../lib/guide/tours/share-invite';
import { getState } from '../../../store';

export function computeShareInviteConditions(): Record<ShareInviteCondition, boolean> {
    // チーム進捗のチップは、メンバーが1人のプロジェクトでは features/team-progress.ts が hidden にする
    const host = document.getElementById('team-progress-host');
    const hasTeamProgress = host !== null && !host.classList.contains('hidden');
    const shareOpen = getState().ui.flags.shareInputOpen;
    return {
        'share-panel-open': shareOpen,
        // リンク共有の警告は loadSharedUsers が一覧の先頭に描画する（出る条件は mergePermissionsForDisplay の linkShare）
        'no-link-share': document.querySelector('[data-tour="share-link-warning"]') === null,
        'share-panel-closed-or-no-team-progress': !shareOpen || !hasTeamProgress,
        'has-team-progress': hasTeamProgress,
        'no-team-progress': !hasTeamProgress,
    };
}
