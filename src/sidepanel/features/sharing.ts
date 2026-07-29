/**
 * 共有機能モジュール
 * handleShare, loadSharedUsers
 */

import { dom } from '../dom';
import { state } from '../state';
import { showToast } from '../ui/feedback';
import {
    addPermission,
    deletePermission,
    DrivePermissionError,
    getFilePermissions,
    getProjectDriveFolderId,
    getSpreadsheetPermissions,
    isUserAdmin,
    type SpreadsheetPermission,
} from '../../lib/sheets-api';
import { t } from '../../lib/i18n';
import { addShareEmailToHistory, getShareEmailHistory, mergeShareEmailsToHistory } from '../../lib/share-email-history';
import { buildInviteMessage } from '../../lib/share-invite';
import {
    canRemovePermission,
    classifyPermissionRemovalError,
    findRemovableUserPermission,
    resolveRemovalTargets,
    summarizeRemovalOutcome,
    type PermissionRemovalFailure,
} from '../../lib/share-permissions';

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
 * 共有先（フォルダ優先）の Drive フォルダIDを取得する。
 * `handleShare` と一覧取得・解除処理で同じ規則を使うため切り出している。
 * 取得に失敗した場合は null 扱い（スプレッドシート単体共有にフォールバック）とする。
 */
async function resolveShareFolderId(spreadsheetId: string): Promise<string | null> {
    try {
        return await getProjectDriveFolderId(spreadsheetId);
    } catch (error) {
        console.warn('Failed to resolve project drive folder id:', error);
        return null;
    }
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
        const folderId = await resolveShareFolderId(state.spreadsheetId);

        // フォルダ共有時、Driveの既定通知メールは「フォルダを共有しました」としか表示されず、
        // スプレッドシートURLも拡張のインストール手順も載らない（スプレッドシート単体共有の場合と
        // 違い、共有相手はどこから作業を始めればよいか分からなくなる）。そのため招待文テンプレートを
        // 通知メール本文に載せる。spreadsheetIdが無い場合（想定外だが防御的に）は従来どおり
        // Drive既定の通知文のみとする。
        const message = state.spreadsheetId ? buildInviteMessage(state.spreadsheetId) : undefined;
        await addPermission(folderId || state.spreadsheetId, email, 'writer', message);

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

    const text = buildInviteMessage(spreadsheetId);

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

        // 管理者権限チェック（fallback含む。従来どおりスプレッドシートIDで判定する）
        const isAdmin = await isUserAdmin(spreadsheetId, userEmail);

        // 権限一覧の取得対象は共有先に合わせる（フォルダがあればフォルダ優先。handleShareと同じ規則）。
        // 取得に失敗した場合は従来どおりスプレッドシート単体の一覧にフォールバックする。
        const folderId = await resolveShareFolderId(spreadsheetId);
        const primaryTarget = folderId || spreadsheetId;

        let permissions: SpreadsheetPermission[] = [];
        try {
            permissions = await getFilePermissions(primaryTarget);
        } catch (e) {
            console.warn('Failed to load permissions list from primary target, falling back to spreadsheet:', e);
            try {
                permissions = await getSpreadsheetPermissions(spreadsheetId);
            } catch (fallbackError) {
                console.warn('Failed to load permissions list (likely due to scope):', fallbackError);
            }
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

            if (canRemovePermission(p, { isAdmin, selfEmail: userEmail })) {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'shared-user-remove-btn';
                removeBtn.textContent = '✕';
                removeBtn.title = t('share_removeTitle');
                removeBtn.setAttribute('aria-label', t('share_removeTitle'));
                removeBtn.addEventListener('click', () => {
                    void handleRemoveShare(p.emailAddress);
                });
                div.appendChild(removeBtn);
            }

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

/**
 * 共有相手のアクセス権を解除する。
 *
 * フォルダ共有プロジェクトでは、フォルダ・スプレッドシートの両方に個別の権限が
 * 付与されている場合があるため、resolveRemovalTargets が返す各ターゲットを順に処理する。
 * あるターゲットで一覧取得や削除に失敗しても、他のターゲットの処理は続行する。
 */
export async function handleRemoveShare(email: string): Promise<void> {
    if (!window.confirm(t('share_removeConfirm', email))) return;

    const removeButtons = dom.sharedUsersList.querySelectorAll<HTMLButtonElement>('.shared-user-remove-btn');
    removeButtons.forEach(btn => { btn.disabled = true; });

    try {
        const folderId = await resolveShareFolderId(state.spreadsheetId);
        const targets = resolveRemovalTargets(folderId, state.spreadsheetId);

        let successCount = 0;
        let folderRemovalSucceeded = false;
        const failures: PermissionRemovalFailure[] = [];
        // 「失敗」表示（'unknown'）の引数に使う、最初に発生した失敗のAPI/エラーメッセージ
        let firstUnknownFailureMessage = '';

        for (const target of targets) {
            try {
                const permissions = await getFilePermissions(target);
                const permission = findRemovableUserPermission(permissions, email);
                if (!permission || !permission.id) continue;

                try {
                    await deletePermission(target, permission.id);
                    successCount += 1;
                    if (target === folderId) folderRemovalSucceeded = true;
                } catch (deleteError) {
                    if (deleteError instanceof DrivePermissionError) {
                        const failure = classifyPermissionRemovalError(deleteError.status, deleteError.apiMessage);
                        // フォルダ側の解除が成功していれば、配下のスプレッドシート権限は
                        // フォルダから継承された状態になるため、'inherited' での失敗は成功扱いにする
                        if (folderRemovalSucceeded && failure === 'inherited') continue;
                        if (failure === 'unknown' && !firstUnknownFailureMessage) {
                            firstUnknownFailureMessage = deleteError.apiMessage;
                        }
                        failures.push(failure);
                    } else {
                        console.error('Failed to delete permission:', deleteError);
                        if (!firstUnknownFailureMessage) firstUnknownFailureMessage = (deleteError as Error).message;
                        failures.push('unknown');
                    }
                }
            } catch (listError) {
                // 一覧取得に失敗しても他のターゲットは続行するが、フォルダ側の削除成功だけを
                // もって「成功」と表示すると、このターゲットに残っているかもしれない権限を
                // 見逃してしまうため、失敗としても集計する
                console.warn(`Failed to load permissions for target ${target}:`, listError);
                if (!firstUnknownFailureMessage) firstUnknownFailureMessage = (listError as Error).message;
                failures.push('unknown');
            }
        }

        const summary = summarizeRemovalOutcome(successCount, failures);
        if (summary.arg === 'email') {
            showToast(t(summary.key, email));
        } else if (summary.arg === 'apiMessage') {
            showToast(t(summary.key, firstUnknownFailureMessage));
        } else {
            showToast(t(summary.key));
        }
    } catch (error) {
        console.error('Failed to remove share:', error);
        showToast(t('share_removeErrorUnknown', (error as Error).message));
    } finally {
        // Drive側の権限伝播には数秒かかることがあり、再描画直後は解除したはずの相手が
        // 一覧に残って見える場合がある（Drive側の反映待ち。アプリのバグではない）
        await loadSharedUsers();
    }
}
