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
        // accountStatus: 'ANY' は Chrome 84+ で必要
        chrome.identity.getProfileUserInfo(
            { accountStatus: chrome.identity.AccountStatus.ANY },
            (userInfo) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ error: chrome.runtime.lastError.message });
                } else if (userInfo.email) {
                    sendResponse({ email: userInfo.email });
                } else {
                    sendResponse({ error: 'No email found' });
                }
            }
        );
        return true;
    }

    // トークンをクリアして再認証
    if (message.type === 'FORCE_REAUTH') {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (token) {
                // 既存トークンを削除
                chrome.identity.removeCachedAuthToken({ token }, () => {
                    // 新しいトークンを取得
                    chrome.identity.getAuthToken({ interactive: true }, (newToken) => {
                        if (chrome.runtime.lastError) {
                            sendResponse({ error: chrome.runtime.lastError.message });
                        } else {
                            sendResponse({ token: newToken });
                        }
                    });
                });
            } else {
                // トークンがなければ普通に取得
                chrome.identity.getAuthToken({ interactive: true }, (newToken) => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ error: chrome.runtime.lastError.message });
                    } else {
                        sendResponse({ token: newToken });
                    }
                });
            }
        });
        return true;
    }
});

export { };
