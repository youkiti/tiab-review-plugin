// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus } from './types';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// シート名定数
const REFERENCES_SHEET = 'References';
const DECISIONS_SHEET = 'Decisions';

// References タブのヘッダー
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key'
];

// Decisions タブのヘッダー
const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url'
];

/**
 * OAuth トークンを取得
 */
export async function getAuthToken(): Promise<string> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (response) => {
            if (response?.error) {
                reject(new Error(response.error));
            } else if (response?.token) {
                resolve(response.token);
            } else {
                reject(new Error('Failed to get auth token'));
            }
        });
    });
}

/**
 * ユーザーのメールアドレスを取得（OAuth userinfo APIを使用）
 */
export async function getUserEmail(): Promise<string> {
    const token = await getAuthToken();

    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
        throw new Error('Failed to get user info');
    }

    const userInfo = await response.json();
    if (!userInfo.email) {
        throw new Error('No email found');
    }

    return userInfo.email;
}

/**
 * トークンをクリアして再認証（スコープ変更時に使用）
 */
export async function forceReauth(): Promise<string> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'FORCE_REAUTH' }, (response) => {
            if (response?.error) {
                reject(new Error(response.error));
            } else if (response?.token) {
                resolve(response.token);
            } else {
                reject(new Error('Failed to reauth'));
            }
        });
    });
}

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

    const token = await getAuthToken();
    console.log('[getRecentSpreadsheets] Got token:', token ? 'yes' : 'no');

    const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet'");
    const fields = encodeURIComponent('files(id,name,modifiedTime)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=recency&pageSize=${maxResults}&fields=${fields}`;

    console.log('[getRecentSpreadsheets] Fetching:', url);

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

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
 * 新しいスプレッドシートを作成
 */
export async function createSpreadsheet(title: string): Promise<string> {
    const token = await getAuthToken();

    const response = await fetch(SHEETS_API_BASE, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: {
                title: title
            },
            sheets: [
                {
                    properties: { title: REFERENCES_SHEET }
                },
                {
                    properties: { title: DECISIONS_SHEET }
                }
            ]
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to create spreadsheet: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const spreadsheetId = data.spreadsheetId;

    // ヘッダー行を追加
    await appendRows(spreadsheetId, REFERENCES_SHEET, [REFERENCES_HEADERS]);
    await appendRows(spreadsheetId, DECISIONS_SHEET, [DECISIONS_HEADERS]);

    return spreadsheetId;
}

/**
 * スプレッドシートの存在確認とタイトル取得
 */
export async function getSpreadsheetInfo(spreadsheetId: string): Promise<{ title: string }> {
    const token = await getAuthToken();

    const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}?fields=properties.title`, {
        headers: {
            'Authorization': `Bearer ${token}`,
        },
    });

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('Spreadsheet not found');
        }
        throw new Error(`Failed to get spreadsheet info: ${response.statusText}`);
    }

    const data = await response.json();
    return { title: data.properties.title };
}

/**
 * シートからデータを取得
 */
async function getSheetValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const token = await getAuthToken();

    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to get sheet values: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.values || [];
}

/**
 * シートに行を追加
 */
async function appendRows(spreadsheetId: string, sheetName: string, rows: (string | number | undefined)[][]): Promise<void> {
    const token = await getAuthToken();

    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                values: rows.map(row => row.map(v => v ?? '')),
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to append rows: ${error.error?.message || response.statusText}`);
    }
}

/**
 * シートの特定範囲を更新
 */
async function updateRange(spreadsheetId: string, range: string, values: (string | number | undefined)[][]): Promise<void> {
    const token = await getAuthToken();

    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                values: values.map(row => row.map(v => v ?? '')),
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to update range: ${error.error?.message || response.statusText}`);
    }
}

/**
 * References タブから文献一覧を取得
 */
export async function getReferences(spreadsheetId: string): Promise<Reference[]> {
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:M`);

    if (values.length <= 1) {
        return []; // ヘッダーのみ or 空
    }

    const headers = values[0];
    const rows = values.slice(1);

    return rows.map(row => {
        const ref: Record<string, string | number | undefined> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            if (header === 'year') {
                ref[header] = value ? parseInt(value, 10) : undefined;
            } else {
                ref[header] = value || undefined;
            }
        });
        return ref as unknown as Reference;
    });
}

/**
 * Decisions タブから判定一覧を取得
 */
export async function getDecisions(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A:J`);

    if (values.length <= 1) {
        return [];
    }

    const headers = values[0];
    const rows = values.slice(1);

    return rows.map((row, idx) => {
        const dec: Record<string, string | string[] | undefined> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            if (header === 'labels') {
                dec[header] = value ? value.split(',').map(s => s.trim()) : undefined;
            } else {
                dec[header] = value || undefined;
            }
        });
        return {
            decision: dec as unknown as Decision,
            rowIndex: idx + 2, // 1-indexed + ヘッダー分
        };
    });
}

/**
 * 文献一覧に判定状態をマージ
 */
export async function getReferencesWithStatus(
    spreadsheetId: string,
    reviewerEmail: string
): Promise<ReferenceWithStatus[]> {
    console.log('[getReferencesWithStatus] Loading with reviewerEmail:', reviewerEmail);

    const [references, decisionsData] = await Promise.all([
        getReferences(spreadsheetId),
        getDecisions(spreadsheetId),
    ]);

    console.log('[getReferencesWithStatus] References:', references.length, 'Decisions:', decisionsData.length);

    // 自分の判定をマップ化
    const myDecisions = new Map<string, Decision>();
    decisionsData.forEach(({ decision }) => {
        console.log('[getReferencesWithStatus] Decision reviewer_id:', decision.reviewer_id);
        if (decision.reviewer_id === reviewerEmail) {
            myDecisions.set(decision.ref_id, decision);
        }
    });

    console.log('[getReferencesWithStatus] My decisions count:', myDecisions.size);

    return references.map(ref => {
        const myDecision = myDecisions.get(ref.ref_id);
        const status: DecisionStatus = myDecision ? myDecision.decision : 'pending';
        return {
            ...ref,
            myDecision,
            status,
        };
    });
}

/**
 * 判定を保存（新規追加 or 更新）
 */
export async function saveDecision(spreadsheetId: string, decision: Decision): Promise<void> {
    // 既存の判定を検索
    const decisionsData = await getDecisions(spreadsheetId);
    const existing = decisionsData.find(
        ({ decision: d }) => d.ref_id === decision.ref_id && d.reviewer_id === decision.reviewer_id
    );

    const row = [
        decision.decision_id,
        decision.ref_id,
        decision.reviewer_id,
        decision.decision,
        decision.reason || '',
        decision.labels?.join(', ') || '',
        decision.note || '',
        decision.decided_at,
        decision.client_version || '',
        decision.source_url || '',
    ];

    if (existing) {
        // 既存行を更新
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${existing.rowIndex}:J${existing.rowIndex}`, [row]);
    } else {
        // 新規追加
        await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
    }
}

/**
 * 文献を追加（RISインポート用）
 */
export async function addReferences(spreadsheetId: string, references: Reference[]): Promise<void> {
    if (references.length === 0) return;

    const rows = references.map(ref => [
        ref.ref_id,
        ref.title,
        ref.abstract || '',
        ref.year?.toString() || '',
        ref.authors || '',
        ref.journal || '',
        ref.doi || '',
        ref.pmid || '',
        ref.url || '',
        ref.source || '',
        ref.imported_at || '',
        ref.imported_by || '',
        ref.dedupe_key || '',
    ]);

    await appendRows(spreadsheetId, REFERENCES_SHEET, rows);
}
