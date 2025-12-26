// Service Worker - バックグラウンドスクリプト

chrome.runtime.onInstalled.addListener(() => {
    console.log('TiAb Review Plugin installed');
});

// サイドパネルを有効化
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

// メッセージハンドラー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_AUTH_TOKEN') {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ token });
            }
        });
        return true; // 非同期レスポンスを示す
    }

    if (message.type === 'GET_USER_INFO') {
        chrome.identity.getProfileUserInfo((userInfo) => {
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ email: userInfo.email });
            }
        });
        return true;
    }
});

export { };
