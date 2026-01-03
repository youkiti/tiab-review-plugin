/**
 * 共有機能モジュール
 * handleShare, loadSharedUsers
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import { addPermission, getSpreadsheetPermissions, isUserAdmin } from '../../lib/sheets-api';

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
        showToast('有効なメールアドレスを入力してください');
        return;
    }

    try {
        dom.shareSubmitBtn.disabled = true;
        dom.shareSubmitBtn.textContent = '...';

        await addPermission(state.spreadsheetId, email, 'writer');

        showToast(`${email} を追加しました`);
        dom.shareEmailInput.value = '';
        // Store経由で閉じる
        closeShareInput();
    } catch (error) {
        console.error('Share error:', error);
        showToast(`追加エラー: ${(error as Error).message}`);
    } finally {
        dom.shareSubmitBtn.disabled = false;
        dom.shareSubmitBtn.textContent = '追加';
    }
}

/**
 * 共有ユーザーリストを読み込み
 */
export async function loadSharedUsers() {
    const spreadsheetId = state.spreadsheetId;
    const userEmail = state.userEmail;

    try {
        dom.sharedUsersList.innerHTML = '<div style="font-size:11px;color:#666;">読み込み中...</div>';

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
                    <span class="shared-user-email" title="${userEmail}">${userEmail} (自分)</span>
                    <span class="shared-user-role">編集者(詳細不明)</span>
                `;
                dom.sharedUsersList.appendChild(div);

                const note = document.createElement('div');
                note.style.fontSize = '10px';
                note.style.color = '#999';
                note.style.marginTop = '4px';
                note.textContent = '※権限リストの取得には追加の認証が必要な場合があります';
                dom.sharedUsersList.appendChild(note);
            } else {
                dom.sharedUsersList.innerHTML = '<div style="font-size:11px;color:#666;">ユーザーが見つかりません</div>';
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
            roleSpan.textContent = p.role === 'owner' ? 'オーナー' : (p.role === 'writer' ? '編集者' : '閲覧者');

            div.appendChild(emailSpan);
            div.appendChild(roleSpan);
            dom.sharedUsersList.appendChild(div);
        });

    } catch (error) {
        console.error('Failed to load shared users:', error);
        dom.sharedUsersList.innerHTML = '<div style="font-size:11px;color:#c62828;">読み込み失敗</div>';
    }
}
