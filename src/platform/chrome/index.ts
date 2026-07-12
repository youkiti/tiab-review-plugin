/**
 * Chrome 拡張機能版プラットフォームアダプタ。
 * OAuth 系は service-worker（src/background/auth-flow.ts）にメッセージングで委譲する。
 */
import type { PlatformAdapter } from '../types';

/**
 * service-worker 経由で OAuth トークンを取得する。
 */
function requestToken(type: 'GET_AUTH_TOKEN' | 'FORCE_REAUTH', interactive?: boolean): Promise<string> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, interactive }, (response) => {
            if (response?.error) {
                reject(new Error(response.error));
            } else if (response?.token) {
                resolve(response.token);
            } else {
                reject(new Error(type === 'GET_AUTH_TOKEN' ? 'Failed to get auth token' : 'Failed to reauth'));
            }
        });
    });
}

export const chromePlatform: PlatformAdapter = {
    getAuthToken: (interactive = false) => requestToken('GET_AUTH_TOKEN', interactive),
    forceReauth: () => requestToken('FORCE_REAUTH'),

    async clearAuth(): Promise<void> {
        // service-worker 側でトークン破棄・revoke を行う。ここで GET_AUTH_TOKEN を呼ぶと
        // 未ログイン時にログインプロンプトを開いてしまうため、CLEAR_AUTH 専用メッセージにする。
        await new Promise<void>((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'CLEAR_AUTH' }, (response) => {
                if (response?.error) {
                    reject(new Error(response.error));
                } else {
                    resolve();
                }
            });
        });
    },

    async storageGet(keys: string[]): Promise<Record<string, unknown>> {
        return chrome.storage.local.get(keys);
    },
    async storageSet(items: Record<string, unknown>): Promise<void> {
        await chrome.storage.local.set(items);
    },
    async storageRemove(keys: string | string[]): Promise<void> {
        await chrome.storage.local.remove(keys);
    },
    async storageClear(): Promise<void> {
        await chrome.storage.local.clear();
    },

    onMessage(listener: (message: unknown) => void): void {
        chrome.runtime.onMessage.addListener((message) => {
            listener(message);
        });
    },
    emitMessage(message: unknown): void {
        // fire-and-forget（応答は使わない）。受信側が居ない場合の lastError は無視する。
        try {
            chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
        } catch {
            /* 受信側不在時の "Receiving end does not exist" を無視 */
        }
    },

    getMessage(key: string, substitutions?: string[]): string {
        return chrome.i18n.getMessage(key, substitutions);
    },

    openExternal(url: string): void {
        chrome.tabs.create({ url });
    },

    getVersionString(): string {
        return chrome.runtime.getManifest().version;
    },

    capabilities: {
        llm: true,
        ml: true,
        fulltext: true,
        importExport: true,
        createProject: true,
    },
};
