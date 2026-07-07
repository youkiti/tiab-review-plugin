/**
 * Chrome 拡張機能版プラットフォームアダプタ。
 * 既存コードにあったロジックをそのまま移設したものであり、新しい挙動は加えない。
 */
import type { PlatformAdapter } from '../types';

/**
 * service-worker 経由で OAuth トークンを取得する。
 * （sheets-api.ts の getAuthToken / forceReauth から移設）
 */
function requestToken(type: 'GET_AUTH_TOKEN' | 'FORCE_REAUTH'): Promise<string> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type }, (response) => {
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
    getAuthToken: () => requestToken('GET_AUTH_TOKEN'),
    forceReauth: () => requestToken('FORCE_REAUTH'),

    async clearAuth(): Promise<void> {
        // 認証トークンのクリア（auth.ts:93-100 から移設）。
        // storage のクリアは storageClear() 側で行うため、ここではトークンのみ破棄する。
        const token = await requestToken('GET_AUTH_TOKEN');
        await new Promise<void>((resolve) => {
            chrome.identity.removeCachedAuthToken({ token }, () => {
                chrome.identity.clearAllCachedAuthTokens(() => resolve());
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
