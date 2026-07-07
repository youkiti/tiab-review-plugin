/**
 * Web 版プラットフォームアダプタ本体。
 * chrome.* API に依存せず、GIS 認証・localStorage・EventTarget・バンドル i18n で構成する。
 * capabilities は拡張専用機能（LLM/ML/フルテキスト/インポートエクスポート）を
 * false にし、共有 UI 側で非表示にする。
 * 新規プロジェクト作成（createProject）は spreadsheets.create のみで実現でき、
 * Web の GIS トークンも spreadsheets / drive.file スコープを持つため有効化する。
 */
import type { PlatformAdapter } from '../types';
import * as auth from './auth';
import * as storage from './storage';
import * as messaging from './messaging';
import { getMessage } from './i18n';

// webpack DefinePlugin によりビルド時に文字列リテラルへ置換されるグローバル定数
declare const __APP_VERSION__: string;

export const webPlatform: PlatformAdapter = {
    getAuthToken: auth.getAuthToken,
    forceReauth: auth.forceReauth,
    clearAuth: auth.clearAuth,

    storageGet: storage.storageGet,
    storageSet: storage.storageSet,
    storageRemove: storage.storageRemove,
    storageClear: storage.storageClear,

    onMessage: messaging.onMessage,
    emitMessage: messaging.emitMessage,

    getMessage,

    openExternal: (url) => { window.open(url, '_blank', 'noopener'); },

    getVersionString: () => `web-${__APP_VERSION__}`,

    capabilities: {
        llm: false, ml: false, fulltext: false, importExport: false, createProject: true,
    },
};
