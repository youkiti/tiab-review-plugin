// Popup スクリプト
import { setPlatform } from '../platform';
import { chromePlatform } from '../platform/chrome';
setPlatform(chromePlatform);

import { localizeHtml } from '../lib/i18n';

document.addEventListener('DOMContentLoaded', () => {
    localizeHtml();
    const loginSection = document.getElementById('login-section') as HTMLElement;
    const userSection = document.getElementById('user-section') as HTMLElement;
    const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
    const userEmail = document.getElementById('user-email') as HTMLSpanElement;
    const openSidepanelBtn = document.getElementById('open-sidepanel-btn') as HTMLButtonElement;

    // ログイン状態をチェック
    checkAuthStatus();

    loginBtn.addEventListener('click', async () => {
        try {
            // ボタンクリック起点なので interactive=true（アカウント選択画面を開く）
            const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN', interactive: true });
            if (response.error) {
                console.error('Auth error:', response.error);
                const { t } = await import('../lib/i18n');
                alert(t('auth_loginFailed', response.error));
            } else {
                checkAuthStatus();
            }
        } catch (error) {
            console.error('Login error:', error);
        }
    });

    openSidepanelBtn.addEventListener('click', async () => {
        // サイドパネルを開く
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
            chrome.sidePanel.open({ tabId: tab.id });
            window.close();
        }
    });

    async function checkAuthStatus() {
        try {
            // GET_USER_INFO（Chromeプロファイルのメール）は使わない。未ログインでも
            // プロファイルにログインしていれば「ログイン済み」と誤表示するバグがあったため、
            // 実際に認可済みのアカウントのみを返す GET_CACHED_EMAIL に置き換えた。
            const response = await chrome.runtime.sendMessage({ type: 'GET_CACHED_EMAIL' });
            if (response.email) {
                loginSection.classList.add('hidden');
                userSection.classList.remove('hidden');
                userEmail.textContent = response.email;
            } else {
                loginSection.classList.remove('hidden');
                userSection.classList.add('hidden');
            }
        } catch (error) {
            console.error('Check auth status error:', error);
        }
    }
});
