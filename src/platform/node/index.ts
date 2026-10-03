// Node 用のプラットフォームアダプタを組み立てる。
// 認証は注入された処理へ委ね、保存と通知はプロセス内で扱う。

import type { PlatformAdapter } from '../types';
import { resolveMessage, type Messages } from '../web/i18n-core';

export interface NodePlatformDeps {
    getAccessToken(interactive?: boolean): Promise<string>;
    forceReauth(): Promise<string>;
    clearAuth(): Promise<void>;
    messages: Messages;
    fallbackMessages: Messages;
    version: string;
    openExternal?: (url: string) => void;
}

/** CLI の認証と、プロセス内だけの保存・通知を接続する。 */
export function createNodePlatform(deps: NodePlatformDeps): PlatformAdapter {
    const storage = new Map<string, unknown>();
    const listeners: ((message: unknown) => void)[] = [];
    return {
        getAuthToken: interactive => deps.getAccessToken(interactive),
        forceReauth: () => deps.forceReauth(),
        clearAuth: () => deps.clearAuth(),
        storageGet: async keys => Object.fromEntries(
            keys.filter(key => storage.has(key)).map(key => [key, storage.get(key)])),
        storageSet: async items => {
            for (const [key, value] of Object.entries(items)) {
                storage.set(key, value);
            }
        },
        storageRemove: async keys => {
            for (const key of typeof keys === 'string' ? [keys] : keys) {
                storage.delete(key);
            }
        },
        storageClear: async () => {
            storage.clear();
        },
        onMessage: listener => {
            listeners.push(listener);
        },
        emitMessage: message => {
            for (const listener of [...listeners]) {
                listener(message);
            }
        },
        getMessage: (key, substitutions) => resolveMessage(deps.messages, deps.fallbackMessages, key, substitutions),
        openExternal: url => {
            deps.openExternal?.(url);
        },
        getVersionString: () => deps.version,
        capabilities: { llm: false, ml: false, fulltext: false, importExport: true, createProject: true },
    };
}
