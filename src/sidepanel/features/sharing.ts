/**
 * 共有機能モジュール
 * handleShare, loadSharedUsers
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import { addPermission, getSpreadsheetPermissions, isUserAdmin } from '../../lib/sheets-api';
import { t } from '../../lib/i18n';

// Store互換レイヤー（Phase 4）
import { closeShareInput } from '../store/compat';

/**
 * 共有設定を追加
 */
export async function handleShare() {
    const email = dom.shareEmailInput.value.trim();
    if (!email) return;

    // Email validation (simple check)
    if (!email.includes('@')) {
        showToast(t('share_invalidEmail'));
        return;
    }

    try {
        dom.shareSubmitBtn.disabled = true;
        dom.shareSubmitBtn.textContent = '...';

        await addPermission(state.spreadsheetId, email, 'writer');

        showToast(t('share_added', email));
        dom.shareEmailInput.value = '';
        // Store経由で閉じる
        closeShareInput();
    } catch (error) {
        console.error('Share error:', error);
        showToast(t('share_addError', (error as Error).message));
    } finally {
        dom.shareSubmitBtn.disabled = false;
        dom.shareSubmitBtn.textContent = t('share_add');
    }
}

/**
 * 共有ユーザーリストを読み込み
 */
export async function loadSharedUsers() {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;

    try {
        dom.sharedUsersList.innerHTML = `<div style="font-size:11px;color:#666;">${t('common_loading')}</div>`;

        // 管理者権限チェック（fallback含む）
        const isAdmin = await isUserAdmin(spreadsheetId, userEmail);

        let permissions: { emailAddress: string; role: string }[] = [];
        try {
            permissions = await getSpreadsheetPermissions(spreadsheetId);
        } catch (e) {
            console.warn('Failed to load permissions list (likely due to scope):', e);
        }

        if (permissions.length === 0) {
            if (isAdmin) {
                // Adminだがリストが見れない場合
                dom.sharedUsersList.innerHTML = '';
                const div = document.createElement('div');
                div.className = 'shared-user-item';
                div.innerHTML = `
                    <span class="shared-user-email" title="${userEmail}">${t('share_self', userEmail)}</span>
                    <span class="shared-user-role">${t('share_roleUnknown')}</span>
                `;
                dom.sharedUsersList.appendChild(div);

                const note = document.createElement('div');
                note.style.fontSize = '10px';
                note.style.color = '#999';
                note.style.marginTop = '4px';
                note.textContent = t('share_permissionNote');
                dom.sharedUsersList.appendChild(note);
            } else {
                dom.sharedUsersList.innerHTML = `<div style="font-size:11px;color:#666;">${t('share_noUsers')}</div>`;
            }
            return;
        }

        dom.sharedUsersList.innerHTML = '';
        permissions.forEach(p => {
            const div = document.createElement('div');
            div.className = 'shared-user-item';

            const emailSpan = document.createElement('span');
            emailSpan.className = 'shared-user-email';
            emailSpan.textContent = p.emailAddress;
            emailSpan.title = p.emailAddress;

            const roleSpan = document.createElement('span');
            roleSpan.className = 'shared-user-role';
            roleSpan.textContent = p.role === 'owner' ? t('share_roleOwner') : (p.role === 'writer' ? t('share_roleWriter') : t('share_roleViewer'));

            div.appendChild(emailSpan);
            div.appendChild(roleSpan);
            dom.sharedUsersList.appendChild(div);
        });

    } catch (error) {
        console.error('Failed to load shared users:', error);
        dom.sharedUsersList.innerHTML = `<div style="font-size:11px;color:#c62828;">${t('share_loadFailed')}</div>`;
    }
}
