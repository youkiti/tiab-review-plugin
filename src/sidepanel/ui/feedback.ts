/**
 * UI フィードバックユーティリティ
 * ローディング表示、ステータスメッセージ、トースト通知
 */

import { dom } from '../dom';
import { showToast as showToastStore } from '../store/compat';
import { dispatch } from '../store';
import { t } from '../../lib/i18n';

/**
 * ローディング表示を切り替え
 */
export function showLoading(show: boolean) {
    if (show) {
        dom.loadingDiv.classList.remove('hidden');
        dom.connectBtn.disabled = true;
        dom.createBtn.disabled = true;
    } else {
        dom.loadingDiv.classList.add('hidden');
        dom.connectBtn.disabled = false;
        dom.createBtn.disabled = false;
    }
}

/**
 * ステータスメッセージを表示
 */
export function showStatus(message: string, type: 'success' | 'error' | 'info' = 'info') {
    dom.statusMessage.textContent = message;
    dom.statusMessage.className = `status-message ${type}`;
    dom.statusMessage.classList.remove('hidden');
}

/**
 * ステータスメッセージを非表示
 */
export function hideStatus() {
    dom.statusMessage.classList.add('hidden');
}

/**
 * トースト通知を表示
 */
export function showToast(message: string, duration = 2000) {
    // Store経由でも状態を更新（将来のReact等への移行用）
    try {
        showToastStore(message, duration);
    } catch {
        // Store未初期化時は無視
    }

    // DOMトーストを直接表示（確実に表示するため）
    dom.toast.textContent = message;
    dom.toast.classList.add('show');
    setTimeout(() => {
        dom.toast.classList.remove('show');
    }, duration);
}

/**
 * トースト通知を非表示
 */
export function hideToast() {
    try {
        dispatch({ type: 'ui/hideToast' });
        return;
    } catch {
        // Store未初期化時は従来のDOMトーストを非表示
    }

    dom.toast.classList.remove('show');
}

/**
 * 保存ステータス表示を更新
 */
export function updateSaveStatus(state: 'default' | 'saving' | 'saved' | 'error') {
    switch (state) {
        case 'default':
            dom.saveStatus.textContent = '';
            dom.saveStatus.className = 'save-status';
            break;
        case 'saving':
            dom.saveStatus.textContent = t('common_saving');
            dom.saveStatus.className = 'save-status saving';
            break;
        case 'saved':
            dom.saveStatus.textContent = t('common_saved');
            dom.saveStatus.className = 'save-status saved';
            // 3秒後にデフォルトに戻す
            setTimeout(() => {
                dom.saveStatus.textContent = '';
                dom.saveStatus.className = 'save-status';
            }, 3000);
            break;
        case 'error':
            dom.saveStatus.textContent = t('common_saveFailed');
            dom.saveStatus.className = 'save-status error';
            break;
    }
}
