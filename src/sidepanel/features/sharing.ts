/**
 * 共有機能モジュール
 * handleShare, loadSharedUsers
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import { addPermission, getProjectDriveFolderId, getSpreadsheetPermissions, isUserAdmin } from '../../lib/sheets-api';
import { t } from '../../lib/i18n';
import { addShareEmailToHistory, getShareEmailHistory, mergeShareEmailsToHistory } from '../../lib/share-email-history';

// Store互換レイヤー（Phase 4）
import { closeShareInput } from '../store/compat';

/** 候補チップとして表示する最大件数（datalistは全件、チップは絞る） */
const SHARE_SUGGESTION_CHIP_LIMIT = 5;

/**
 * 共有メール候補（チップ + datalist）を描画する。
 * 履歴から自分のメールと excludeEmails（現プロジェクトで共有済み）を除外して表示する。
 */
export function loadShareSuggestions(excludeEmails: string[] = []): void {
    const selfEmail = state.userEmail.trim().toLowerCase();
    // excludeEmails は呼び出し元でフィルタ済みの想定だが、リンク共有等でemailAddressが
    // undefinedになるDriveレスポンスが紛れ込む事故があったため、ここでも防御的に除外する
    const normalizedExcludes = excludeEmails
        .filter((e): e is string => typeof e === 'string')
        .map(e => e.trim().toLowerCase());
    const excludeSet = new Set([selfEmail, ...normalizedExcludes].filter(e => e.length > 0));

    void getShareEmailHistory().then(history => {
        const candidates = history.filter(email => !excludeSet.has(email));

        // 前回の描画内容をクリア
        dom.shareSuggestionChips.innerHTML = '';
        dom.shareEmailDatalist.innerHTML = '';

        if (candidates.length === 0) {
            dom.shareSuggestionArea.classList.add('hidden');
            return;
        }

        dom.shareSuggestionArea.classList.remove('hidden');

        candidates.slice(0, SHARE_SUGGESTION_CHIP_LIMIT).forEach(email => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'share-suggestion-chip';
            chip.textContent = email;
            chip.title = email;
            chip.addEventListener('click', () => {
                dom.shareEmailInput.value = email;
                dom.shareEmailInput.focus();
            });
            dom.shareSuggestionChips.appendChild(chip);
        });

        candidates.forEach(email => {
            const option = document.createElement('option');
            option.value = email;
            dom.shareEmailDatalist.appendChild(option);
        });
    });
}

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

        // プロジェクトフォルダがあればフォルダごと共有する。
        // フォルダ権限は下方向に継承されるため、スプレッドシート・fulltext・全PDFを
        // 一括で編集可能にできる（PDFは著作権物なので公開リンクは使わずメンバー限定）。
        // フォルダを持たない既存プロジェクトは従来どおりスプレッドシート単体を共有する。
        const folderId = await getProjectDriveFolderId(state.spreadsheetId);
        await addPermission(folderId || state.spreadsheetId, email, 'writer');

        showToast(t('share_added', email));
        dom.shareEmailInput.value = '';

        // suggestion履歴に追加。今追加したメールは候補から消えるよう除外リストに含めて再描画する
        await addShareEmailToHistory(email);
        loadShareSuggestions([email]);

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
 * 招待文をクリップボードへコピー
 *
 * フォルダ共有しても共同研究者は「どこから入るか」が分かりづらいため、
 * インストール先・スプレッドシートURL・操作ガイドをまとめた定型文を生成して
 * クリップボードへコピーする。メール送信は行わない（OAuth不要）。
 */
export async function copyInviteTemplate() {
    const spreadsheetId = state.spreadsheetId;
    if (!spreadsheetId) {
        showToast(t('share_inviteNoProject'));
        return;
    }

    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    const text = t('share_inviteTemplate', url);

    try {
        await navigator.clipboard.writeText(text);
        showToast(t('share_inviteCopied'));
    } catch (error) {
        // クリップボードAPIが使えない環境向けのフォールバック
        try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            showToast(t('share_inviteCopied'));
        } catch (fallbackError) {
            console.error('Copy invite error:', fallbackError);
            showToast(t('share_inviteCopyFailed'));
        }
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
            // 権限リストが取れなかった/空の場合は除外なしで候補を表示
            loadShareSuggestions();
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

        // 権限リストを履歴へ取り込み（自分のメールは除外してから）、共有済みユーザーを除外した候補を表示
        // リンク共有・ドメイン共有の権限オブジェクトには emailAddress が存在しない（undefined）ことがあるため、
        // 型上は string でも実際には undefined が混入し得る。ここで明示的に除外してから後続処理に渡す。
        const permissionEmails = permissions
            .map(p => p.emailAddress)
            .filter((e): e is string => typeof e === 'string' && e.length > 0);
        const selfEmailLower = userEmail.trim().toLowerCase();
        await mergeShareEmailsToHistory(permissionEmails.filter(e => e.trim().toLowerCase() !== selfEmailLower));
        loadShareSuggestions(permissionEmails);

    } catch (error) {
        console.error('Failed to load shared users:', error);
        dom.sharedUsersList.innerHTML = `<div style="font-size:11px;color:#c62828;">${t('share_loadFailed')}</div>`;
        // 予期しないエラー時も除外なしで候補だけは表示しておく
        loadShareSuggestions();
    }
}
