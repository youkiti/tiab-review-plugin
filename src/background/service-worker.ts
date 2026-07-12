// Service Worker - バックグラウンドスクリプト
import { getAuthToken, forceReauth, clearAuth, getSignedInEmail } from './auth-flow';

chrome.runtime.onInstalled.addListener(() => {
    console.log('TiAb Review Plugin installed');
});

// アイコンクリックで新しいタブを開く
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
});

// メッセージハンドラー
// addListener 自体は async にしない（sendResponse が使えなくなるため）。非同期処理は
// Promise の then/catch で行い、戻り値 true で「非同期にレスポンスする」ことを示す。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_AUTH_TOKEN') {
        // interactive はメッセージ側で明示させる（呼び出し側の意図を必須にすることで、
        // サイドパネル読み込み時のサイレント試行で認可ウィンドウが開くのを防ぐ）
        getAuthToken(message.interactive === true)
            .then((token) => sendResponse({ token }))
            .catch((error) => sendResponse({ error: (error as Error).message }));
        return true;
    }

    if (message.type === 'FORCE_REAUTH') {
        forceReauth()
            .then((token) => sendResponse({ token }))
            .catch((error) => sendResponse({ error: (error as Error).message }));
        return true;
    }

    if (message.type === 'CLEAR_AUTH') {
        clearAuth()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({ error: (error as Error).message }));
        return true;
    }

    if (message.type === 'GET_CACHED_EMAIL') {
        getSignedInEmail().then((email) => sendResponse({ email }));
        return true;
    }
});

export { };
