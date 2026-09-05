// drive-recent-files.ts - 最近使用したスプレッドシートとローカル履歴の管理

import { platform } from '../platform';
import { driveFetch } from './drive-shared-drive';

/**
 * 最近使用したスプレッドシート一覧を取得
 */
export interface RecentSpreadsheet {
    id: string;
    name: string;
    modifiedTime: string;
}

export async function getRecentSpreadsheets(maxResults = 10): Promise<RecentSpreadsheet[]> {
    console.log('[getRecentSpreadsheets] Starting...');

    const token = await platform().getAuthToken();
    console.log('[getRecentSpreadsheets] Got token:', token ? 'yes' : 'no');

    const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'");
    const fields = encodeURIComponent('files(id,name,modifiedTime)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=recency&pageSize=${maxResults}&fields=${fields}`;

    console.log('[getRecentSpreadsheets] Fetching:', url);

    const response = await driveFetch(url, {}, { token, kind: 'list' });

    console.log('[getRecentSpreadsheets] Response status:', response.status);

    if (!response.ok) {
        const error = await response.json();
        console.error('[getRecentSpreadsheets] Error:', error);
        throw new Error(`Failed to get recent spreadsheets: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('[getRecentSpreadsheets] Got files:', data.files?.length || 0);

    return (data.files || []).map((file: { id: string; name: string; modifiedTime: string }) => ({
        id: file.id,
        name: file.name,
        modifiedTime: file.modifiedTime,
    }));
}

/**
 * ローカルに記録する「拡張機能で開いたシート」エントリ。
 *
 * OAuth スコープが drive.file のため、URL を貼り付けて開いたシートは Drive API の
 * files.list には現れない。拡張機能内で接続/作成したシートはここに保存しておき、
 * 初期画面のドロップダウンに合流させることで「最近開いた」一覧として再選択できる
 * ようにする。
 */
export interface LocalRecentSheet {
    id: string;
    name: string;
    lastUsedAt: string; // ISO 8601
}

const LOCAL_RECENT_SHEETS_KEY = 'localRecentSheets';
const LOCAL_RECENT_SHEETS_MAX = 30;

export async function getLocalRecentSheets(): Promise<LocalRecentSheet[]> {
    try {
        const result = await platform().storageGet([LOCAL_RECENT_SHEETS_KEY]);
        const raw = result[LOCAL_RECENT_SHEETS_KEY];
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((entry): entry is LocalRecentSheet =>
                entry &&
                typeof entry.id === 'string' &&
                typeof entry.name === 'string' &&
                typeof entry.lastUsedAt === 'string'
            )
            .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    } catch (error) {
        console.error('[getLocalRecentSheets] Failed:', error);
        return [];
    }
}

export async function rememberLocalRecentSheet(id: string, name: string): Promise<void> {
    if (!id || !name) return;
    try {
        const existing = await getLocalRecentSheets();
        const next: LocalRecentSheet[] = [
            { id, name, lastUsedAt: new Date().toISOString() },
            ...existing.filter((entry) => entry.id !== id),
        ].slice(0, LOCAL_RECENT_SHEETS_MAX);
        await platform().storageSet({ [LOCAL_RECENT_SHEETS_KEY]: next });
    } catch (error) {
        console.error('[rememberLocalRecentSheet] Failed:', error);
    }
}
