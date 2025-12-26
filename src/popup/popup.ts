// Popup スクリプト

document.addEventListener('DOMContentLoaded', () => {
    const loginSection = document.getElementById('login-section') as HTMLElement;
    const userSection = document.getElementById('user-section') as HTMLElement;
    const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
    const userEmail = document.getElementById('user-email') as HTMLSpanElement;
    const openSidepanelBtn = document.getElementById('open-sidepanel-btn') as HTMLButtonElement;

    // ログイン状態をチェック
    checkAuthStatus();

    loginBtn.addEventListener('click', async () => {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' });
            if (response.error) {
                console.error('Auth error:', response.error);
                alert('ログインに失敗しました: ' + response.error);
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
            const response = await chrome.runtime.sendMessage({ type: 'GET_USER_INFO' });
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
