// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, FulltextStatus, LlmConfig, LlmCriteria, LlmExecution, LlmRun, AssignmentConfig } from './types';
import { MODEL_ID_MIGRATIONS } from './gemini-api';
import { t } from './i18n';
import { computeConfigHash, isHashable, legacyHash } from './llm-config-hash';
import { parseFulltextPoolRule } from './fulltext-pool';
import type { FulltextPoolRule } from './fulltext-pool';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// シート名定数
const REFERENCES_SHEET = 'References';
const DECISIONS_SHEET = 'Decisions';
const CONFIG_SHEET = 'Config';
const LLM_EXECUTIONS_SHEET = 'LLM_Executions';
const LLM_RUNS_SHEET = 'LLM_Runs';

// LLM_Executionsシートのヘッダー
// run_id は Run/Batch 分離後に追加された列。既存シートに無い場合は ensureLlmExecutionsSheet で末尾に追加される。
const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',  // Model parameters
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active', 'run_id',
    'requested_model', 'model_version', 'response_id'
];

// LLM_Runs シートのヘッダー（Run = config_hash 単位の論理実行）
const LLM_RUNS_HEADERS = [
    'run_id', 'config_hash', 'created_at', 'model',
    'temperature', 'topP', 'thinkingLevel',
    'criteria_snapshot', 'screening_prompt',
    'include_threshold', 'status', 'is_active',
    'requested_model', 'model_version', 'response_id'
];

// デフォルトハイライトキーワード（RCT フィルタリング想定）
export const PRESET_RCT = {
    include: [
        'randomized', 'randomised', 'RCT', 'controlled trial',
        'random allocation', 'randomly assigned', 'randomly allocated', 'placebo'
    ],
    exclude: [
        'animal', 'mice', 'rat', 'in vitro', 'cell line',
        'protocol', 'review', 'meta-analysis', 'case report', 'case series',
        'commentary', 'editorial', 'letter', 'conference'
    ]
};

// システマティックレビュー（SR）用プリセット
export const PRESET_SR = {
    include: [
        'systematic review', 'meta-analysis', 'network meta-analysis', 'pooled analysis',
        'search strategy', 'database search', 'risk of bias', 'quality assessment',
        'eligibility criteria', 'selection criteria'
    ],
    exclude: [
        'case report', 'case series', 'editorial', 'commentary', 'letter',
        'protocol', 'narrative review', 'overview', 'animal', 'mice', 'rat',
        'in vitro', 'cell line'
    ]
};

const DEFAULT_INCLUDE_KEYWORDS = PRESET_RCT.include;
const DEFAULT_EXCLUDE_KEYWORDS = PRESET_RCT.exclude;

const DEFAULT_ASSIGNMENT_CONFIG: AssignmentConfig = {
    status: 'none',
    calibrationSize: 50,
    groupCount: 4,
    reviewerMap: {},
};

// References タブのヘッダー
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status'
];


// Decisions タブのヘッダー
// 互換性のため labels 列は残すが、機能としては使用しない
// screening_phase: 'tiab' | 'fulltext' (省略時は 'tiab' 扱い)
const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase'
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
        const result = await chrome.storage.local.get([LOCAL_RECENT_SHEETS_KEY]);
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
        await chrome.storage.local.set({ [LOCAL_RECENT_SHEETS_KEY]: next });
    } catch (error) {
        console.error('[rememberLocalRecentSheet] Failed:', error);
    }
}

/**
 * シートのヘッダーを確認し、不足があれば更新する
 */
export async function ensureHeaders(spreadsheetId: string): Promise<void> {
    try {
        const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:Z1`);
        if (!values || values.length === 0) return;

        const currentHeaders = values[0];

        // ヘッダーが不足している場合（例: 古いバージョンで作成されたシート）
        if (currentHeaders.length < REFERENCES_HEADERS.length) {
            console.log('[ensureHeaders] Updating headers...', { current: currentHeaders.length, expected: REFERENCES_HEADERS.length });

            // 既存のヘッダーが期待されるヘッダーのプレフィックスと一致するか確認（念のため）
            // 一致しなくても、このアプリで管理する以上は更新して良いとする

            // 行1全体を更新
            await updateRange(spreadsheetId, `${REFERENCES_SHEET}!A1:Z1`, [REFERENCES_HEADERS]);
            console.log('[ensureHeaders] Headers updated');
        }
    } catch (error) {
        console.error('[ensureHeaders] Error:', error);
        // エラーはログ出力のみで、処理は続行させる（接続をブロックしない）
    }

    // Decisions タブも同様に移行する（screening_phase 列などの追加分）
    // ヘッダーが欠けていると getDecisions がヘッダー基準で読むため、
    // K列に保存した fulltext 判定が phase 不明 = tiab 扱いになってしまう
    try {
        const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A1:Z1`);
        if (!values || values.length === 0) return;

        const currentHeaders = values[0];

        if (currentHeaders.length < DECISIONS_HEADERS.length) {
            console.log('[ensureHeaders] Updating Decisions headers...', { current: currentHeaders.length, expected: DECISIONS_HEADERS.length });
            await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A1:K1`, [DECISIONS_HEADERS]);
            console.log('[ensureHeaders] Decisions headers updated');
        }
    } catch (error) {
        console.error('[ensureHeaders] Decisions error:', error);
        // エラーはログ出力のみで、処理は続行させる（接続をブロックしない）
    }
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
                },
                {
                    properties: { title: CONFIG_SHEET }
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
 * スプレッドシートの形式を検証
 * - Referencesタブが存在するか
 * - 最初の3列が ref_id, title, abstract か
 */
export async function validateSpreadsheetFormat(spreadsheetId: string): Promise<{ valid: boolean; error?: string }> {
    try {
        const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:C1`);

        if (!values || values.length === 0) {
            return {
                valid: false,
                error: t('error_unsupportedFormat')
            };
        }

        const headers = values[0];
        const expectedHeaders = ['ref_id', 'title', 'abstract'];

        if (headers.length < 3 ||
            headers[0] !== expectedHeaders[0] ||
            headers[1] !== expectedHeaders[1] ||
            headers[2] !== expectedHeaders[2]) {
            return {
                valid: false,
                error: t('error_unsupportedFormat')
            };
        }

        return { valid: true };
    } catch (error) {
        // Referencesタブが存在しない場合もエラーになる
        return {
            valid: false,
            error: t('error_unsupportedFormat')
        };
    }
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
 * クォータ超過 (429) 用の指数バックオフリトライ。
 * 初回 1s → 2s → 4s → 8s → 16s → 32s（最大）で 5 回までリトライする (AGENTS.md 準拠)。
 * 429 以外のエラーは即座に throw する。
 */
async function fetchGetWithQuotaRetry(url: string, token: string, label: string): Promise<Response> {
    const maxRetries = 5;
    let delayMs = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (response.status !== 429 || attempt === maxRetries) {
            return response;
        }
        console.warn(`[getSheetValues] 429 quota exceeded for ${label}, retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 32000);
    }
    // ループ終端は到達不能（return か throw のいずれか）
    throw new Error('fetchGetWithQuotaRetry: unreachable');
}

async function fetchSheetValuesWithRetry(
    spreadsheetId: string,
    range: string,
    token: string
): Promise<Response> {
    return fetchGetWithQuotaRetry(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        token,
        range
    );
}

/**
 * シートからデータを取得
 */
async function getSheetValues(spreadsheetId: string, range: string): Promise<string[][]> {
    const token = await getAuthToken();

    const response = await fetchSheetValuesWithRetry(spreadsheetId, range, token);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to get sheet values: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.values || [];
}

/**
 * 複数レンジを1リクエストで取得（values:batchGet）
 * クォータは「リクエスト数」でカウントされるため、複数レンジが必要な場面では
 * getSheetValues を並べるよりこちらを使うこと（429対策）。
 * 戻り値は ranges と同じ順序。
 */
async function getSheetValuesBatch(spreadsheetId: string, ranges: string[]): Promise<string[][][]> {
    const token = await getAuthToken();
    const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values:batchGet?${params}`;

    const response = await fetchGetWithQuotaRetry(url, token, ranges.join(', '));

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to batch get sheet values: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const valueRanges = (data.valueRanges ?? []) as { values?: string[][] }[];
    return ranges.map((_, i) => valueRanges[i]?.values ?? []);
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
 * References タブのシート値を Reference[] に変換
 */
function parseReferenceValues(values: string[][]): Reference[] {
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
 * References タブから文献一覧を取得
 */
export async function getReferences(spreadsheetId: string): Promise<Reference[]> {
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:U`);
    return parseReferenceValues(values);
}

// ...

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
        ref.volume || '',
        ref.issue || '',
        ref.pages || '',
        ref.issn || '',
        ref.doi || '',
        ref.pmid || '',
        ref.url || '',
        ref.source || '',
        ref.imported_at || '',
        ref.imported_by || '',
        ref.dedupe_key || '',
        ref.source_file || '',
        ref.screening_set || '',
    ]);

    await appendRows(spreadsheetId, REFERENCES_SHEET, rows);
}

/**
 * 文献の fulltext_url と fulltext_status を更新する（OA URL 解決後に呼び出す）
 *
 * REFERENCES_HEADERS での列位置:
 *   fulltext_url   = 20列目 (T列, 0-indexed: 19)
 *   fulltext_status = 21列目 (U列, 0-indexed: 20)
 */
export async function updateReferenceFulltextUrl(
    spreadsheetId: string,
    refId: string,
    fulltextUrl: string,
    status: FulltextStatus
): Promise<void> {
    await updateReferenceFulltextUrls(spreadsheetId, [{ refId, fulltextUrl, status }]);
}

/**
 * 複数文献の fulltext_url / fulltext_status をまとめて更新する（一括OA検索用）
 * ref_id 列の読み取り1回 + values:batchUpdate 1回で済ませ、APIクォータを節約する。
 */
export async function updateReferenceFulltextUrls(
    spreadsheetId: string,
    updates: Array<{ refId: string; fulltextUrl: string; status: FulltextStatus }>
): Promise<void> {
    if (updates.length === 0) return;

    // ref_id 列 (A列) で行番号を特定
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:A`);
    const rowByRefId = new Map<string, number>();
    values.forEach((row, i) => {
        if (i > 0 && row[0]) rowByRefId.set(row[0], i + 1); // 1-indexed (ヘッダー行=1)
    });

    const data = updates
        .filter(u => rowByRefId.has(u.refId))
        .map(u => ({
            range: `${REFERENCES_SHEET}!T${rowByRefId.get(u.refId)}:U${rowByRefId.get(u.refId)}`,
            values: [[u.fulltextUrl, u.status]],
        }));
    if (data.length === 0) return;

    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ valueInputOption: 'RAW', data }),
        }
    );
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(`Failed to update fulltext urls: ${error?.error?.message || response.statusText}`);
    }
}

/**
 * 特定のソースファイルの文献を削除
 */
export async function deleteReferencesBySourceFile(spreadsheetId: string, sourceFileName: string): Promise<number> {
    // 1. 全文献のソースファイル列（R列）を取得
    // source_fileはindex 17 (0-indexed) = R列
    // Referencesシートのデータは2行目から（1行目はヘッダー）

    // 効率のため、必要な列だけ取得したいが、行番号を知る必要があるため、A:Rを取得するか、
    // まるごと取得してJS側でフィルタする。
    // R列だけ取得して、インデックスをマッピングするのが効率的。
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!R:R`);

    if (values.length <= 1) return 0;

    const rangesToDelete: { startIndex: number; endIndex: number }[] = [];

    // ヘッダー(0)を除外してスキャン
    for (let i = 1; i < values.length; i++) {
        // R列の値が sourceFileName と一致するか
        if (values[i][0] === sourceFileName) {
            // iは配列のインデックス = シートの行番号 (0-indexed API用)
            // シートの行番号は i+1 だが、APIのstartIndexは0-indexedで行番号そのもの。
            // 例: 配列index 1 (2行目) -> startIndex 1

            // 連続する行をまとめる
            const lastRange = rangesToDelete[rangesToDelete.length - 1];
            if (lastRange && lastRange.endIndex === i) {
                lastRange.endIndex = i + 1;
            } else {
                rangesToDelete.push({ startIndex: i, endIndex: i + 1 });
            }
        }
    }

    if (rangesToDelete.length === 0) return 0;

    // 削除リクエストを作成（後ろから順に削除しないとインデックスがずれる可能性があるが、
    // batchUpdateのdeleteDimensionは "The requests are applied in the order they appear in the request."
    // とあるため、インデックスの大きい方（後ろ）から指定するのが定石）
    rangesToDelete.sort((a, b) => b.startIndex - a.startIndex);

    const requests = rangesToDelete.map(range => ({
        deleteDimension: {
            range: {
                sheetId: 0, // ReferencesシートのIDが必要。通常0だが、明示的に取得すべきか？
                // シートIDを取得する処理を入れると安全だが、オーバーヘッドになる。
                // 名前からIDを取得するヘルパーが必要。
                dimension: 'ROWS',
                startIndex: range.startIndex,
                endIndex: range.endIndex
            }
        }
    }));

    // シートIDを取得
    const sheetId = await getSheetIdByName(spreadsheetId, REFERENCES_SHEET);
    if (sheetId === null) throw new Error('References sheet not found');

    // sheetIdをセット
    requests.forEach(req => req.deleteDimension.range.sheetId = sheetId);

    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                requests: requests
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to delete rows: ${error.error?.message || response.statusText}`);
    }

    return rangesToDelete.reduce((acc, range) => acc + (range.endIndex - range.startIndex), 0);
}

/**
 * シート名からシートIDを取得
 */
async function getSheetIdByName(spreadsheetId: string, sheetName: string): Promise<number | null> {
    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}?fields=sheets.properties`,
        {
            headers: { 'Authorization': `Bearer ${token}` }
        }
    );

    if (!response.ok) return null;

    const data = await response.json();
    const sheet = data.sheets.find((s: any) => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : null;
}

/**
 * Decisions タブのシート値を判定一覧に変換
 */
function parseDecisionValues(values: string[][]): { decision: Decision; rowIndex: number }[] {
    if (values.length <= 1) {
        return [];
    }

    const headers = values[0];
    const rows = values.slice(1);

    return rows.map((row, idx) => {
        const dec: Record<string, string | string[] | undefined> = {};
        headers.forEach((header, i) => {
            const value = row[i] || '';
            // labelsフィールドはDecision型から削除されたため、読み込み時は無視する
            if (header !== 'labels') {
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
 * Decisions タブから判定一覧を取得
 */
export async function getDecisions(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A:K`);
    return parseDecisionValues(values);
}

/**
 * 自分のフルテキストフェーズ判定を ref_id 別にマップ化（最新優先）
 * TiAb 画面の集計からは除外されるが、フルテキストタブの状態表示に使う
 */
function buildMyFulltextDecisionMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    normalizedReviewerEmail: string
): Map<string, Decision> {
    const map = new Map<string, Decision>();
    if (!normalizedReviewerEmail) return map;
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId || reviewerId !== normalizedReviewerEmail) return;
        const existing = map.get(refId);
        if (!existing || (decision.decided_at || '') > (existing.decided_at || '')) {
            map.set(refId, decision);
        }
    });
    return map;
}

/**
 * 全レビュアー（および有効な LLM）のフルテキストフェーズ判定を ref_id 別にマップ化する。
 * TiAb の allDecisions と同じ構造で、結果集計（判定者選択・OR合議・不一致検出）に使う。
 * 無効な LLM 判定（active Run 配下でない reviewer_id）は除外する。
 */
function buildAllFulltextDecisionsMap(
    decisionsData: { decision: Decision; rowIndex: number }[],
    activeFulltextAiRound: string | null
): Map<string, Decision[]> {
    const map = new Map<string, Decision[]>();
    decisionsData.forEach(({ decision }) => {
        if ((decision.screening_phase ?? 'tiab') !== 'fulltext') return;
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        if (refId !== decision.ref_id) decision.ref_id = refId;
        const reviewerId = (decision.reviewer_id || '').trim();
        if (reviewerId && reviewerId !== decision.reviewer_id) decision.reviewer_id = reviewerId;
        // フルテキストAI判定(llm:)は「採用ラウンド」のものだけを有効にする。
        // 採用ラウンド未設定、または別ラウンドの判定は集計から除外する。
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!activeFulltextAiRound || decision.reviewer_id !== activeFulltextAiRound) {
                return;
            }
        }
        const list = map.get(refId);
        if (list) list.push(decision);
        else map.set(refId, [decision]);
    });
    return map;
}

/**
 * 文献一覧に判定状態をマージ（キーオープン前）
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

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // 自分の判定をマップ化
    const myDecisions = new Map<string, Decision>();
    // Blind ONでもAI Evidenceハイライトに必要なLLM判定だけ保持する
    const llmDecisionsMap = new Map<string, Decision[]>();
    tiabDecisionsData.forEach(({ decision }) => {
        // console.log('[getReferencesWithStatus] Decision reviewer_id:', decision.reviewer_id);
        const reviewerId = (decision.reviewer_id || '').trim();
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        if (reviewerId && reviewerId !== decision.reviewer_id) {
            decision.reviewer_id = reviewerId;
        } else if (!reviewerId && normalizedReviewerEmail) {
            decision.reviewer_id = normalizedReviewerEmail;
        }
        if (refId !== decision.ref_id) {
            decision.ref_id = refId;
        }
        if (decision.reviewer_id === normalizedReviewerEmail) {
            myDecisions.set(decision.ref_id, decision);
        }
        if (decision.reviewer_id.startsWith('llm:')) {
            if (!llmDecisionsMap.has(decision.ref_id)) {
                llmDecisionsMap.set(decision.ref_id, []);
            }
            llmDecisionsMap.get(decision.ref_id)!.push(decision);
        }
    });

    console.log('[getReferencesWithStatus] My decisions count:', myDecisions.size);

    return references.map(ref => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
        const myDecision = myDecisions.get(ref.ref_id);
        // decision='pending' の場合も未判定として扱う
        const status: DecisionStatus = (myDecision && myDecision.decision !== 'pending') ? myDecision.decision : 'pending';
        const llmDecisions = llmDecisionsMap.get(ref.ref_id) || [];
        return {
            ...ref,
            myDecision,
            status,
            allDecisions: llmDecisions,
            hasAnyLlmDecision: llmDecisions.length > 0,
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
        };
    });
}

/**
 * 文献一覧に全判定状態をマージ（キーオープン後）
 */
export async function getReferencesWithAllDecisions(
    spreadsheetId: string,
    reviewerEmail: string
): Promise<ReferenceWithStatus[]> {
    console.log('[getReferencesWithAllDecisions] Loading with reviewerEmail:', reviewerEmail);

    const [references, decisionsData, llmExecutions, activeFulltextAiRound] = await Promise.all([
        getReferences(spreadsheetId),
        getDecisions(spreadsheetId),
        getLlmExecutions(spreadsheetId),
        getFulltextAiActiveRound(spreadsheetId),
    ]);

    console.log('[getReferencesWithAllDecisions] References:', references.length, 'Decisions:', decisionsData.length);

    // TiAb 画面用の集計のため、fulltext フェーズの判定は除外する（省略時は tiab 扱い）
    const tiabDecisionsData = decisionsData.filter(
        ({ decision }) => (decision.screening_phase ?? 'tiab') === 'tiab'
    );

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    const myFulltextDecisions = buildMyFulltextDecisionMap(decisionsData, normalizedReviewerEmail);

    // デバッグ: ref_idのサンプルを表示
    if (decisionsData.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample decision ref_ids:', decisionsData.slice(0, 3).map(d => d.decision.ref_id));
    }
    if (references.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample reference ref_ids:', references.slice(0, 3).map(r => r.ref_id));
    }

    // 有効な LLM 判定 = active Run 配下の Batch IDs に含まれる reviewer_id のもの
    // Run/Batch 分離後、active 状態は LLM_Runs.is_active が正となる
    const activeBatchIds = await getActiveBatchIdsForActiveRun(spreadsheetId, llmExecutions);
    const validLlmExecutionIds = activeBatchIds;

    // 全レビュアー（+採用ラウンドのAI）のフルテキスト判定マップ（結果集計用）
    const allFulltextDecisionsMap = buildAllFulltextDecisionsMap(decisionsData, activeFulltextAiRound);

    console.log('[getReferencesWithAllDecisions] llmExecutions:', llmExecutions.map(e => ({
        id: e.execution_id,
        status: e.status,
        is_active: e.is_active,
        run_id: e.run_id,
    })));
    console.log('[getReferencesWithAllDecisions] activeBatchIds:', Array.from(validLlmExecutionIds));

    // 全判定をref_id別にグループ化（有効なLLM判定のみを含める）
    const allDecisionsMap = new Map<string, Decision[]>();
    // バッチ再判定の重複を避けるため、status/active を問わず LLM 判定の有無を別途記録
    const refIdsWithAnyLlmDecision = new Set<string>();
    let skippedLlm = 0;
    let addedDecisions = 0;
    let addedHuman = 0;
    let addedLlm = 0;
    tiabDecisionsData.forEach(({ decision }) => {
        const refId = (decision.ref_id || '').trim();
        if (!refId) return;
        const reviewerIdRaw = (decision.reviewer_id || '').trim();
        const reviewerId = reviewerIdRaw || normalizedReviewerEmail;
        if (reviewerId && reviewerId !== decision.reviewer_id) {
            decision.reviewer_id = reviewerId;
        }
        if (refId !== decision.ref_id) {
            decision.ref_id = refId;
        }

        if (decision.reviewer_id.startsWith('llm:')) {
            refIdsWithAnyLlmDecision.add(decision.ref_id);
        }

        // LLMの判定かつ、有効な実行IDに含まれていない場合はスキップ
        if (decision.reviewer_id.startsWith('llm:') && !validLlmExecutionIds.has(decision.reviewer_id)) {
            skippedLlm++;
            return;
        }

        if (!allDecisionsMap.has(decision.ref_id)) {
            allDecisionsMap.set(decision.ref_id, []);
        }
        allDecisionsMap.get(decision.ref_id)!.push(decision);
        addedDecisions++;

        // デバッグ: reviewer_idの種類ごとにカウント
        if (decision.reviewer_id.startsWith('llm:')) {
            addedLlm++;
        } else {
            addedHuman++;
        }
    });

    console.log('[getReferencesWithAllDecisions] allDecisionsMap size:', allDecisionsMap.size, 'addedDecisions:', addedDecisions, 'skippedLlm:', skippedLlm);
    console.log('[getReferencesWithAllDecisions] addedHuman:', addedHuman, 'addedLlm:', addedLlm);

    // デバッグ: ref_idのマッチング状況
    const refIdsInDecisions = new Set(Array.from(allDecisionsMap.keys()));
    const refIdsInReferences = new Set(references.map(r => r.ref_id));
    const matchedRefIds = [...refIdsInDecisions].filter(id => refIdsInReferences.has(id));
    const unmatchedDecisionRefIds = [...refIdsInDecisions].filter(id => !refIdsInReferences.has(id));
    console.log('[getReferencesWithAllDecisions] ref_id matching: matched=', matchedRefIds.length, 'unmatched decisions=', unmatchedDecisionRefIds.length);
    if (unmatchedDecisionRefIds.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample unmatched decision ref_ids:', unmatchedDecisionRefIds.slice(0, 3));
    }

    return references.map(ref => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
        const allDecisions = allDecisionsMap.get(ref.ref_id) || [];
        const myDecision = normalizedReviewerEmail
            ? allDecisions.find(d => d.reviewer_id === normalizedReviewerEmail)
            : undefined;

        // 不一致検出
        const hasConflict = detectConflict(allDecisions);

        // ステータス決定
        let status: DecisionStatus;
        if (hasConflict) {
            status = 'conflict';
        } else if (myDecision && myDecision.decision !== 'pending') {
            // decision='pending' の場合も未判定として扱う
            status = myDecision.decision;
        } else {
            status = 'pending';
        }

        return {
            ...ref,
            myDecision,
            status,
            allDecisions,
            hasConflict,
            hasAnyLlmDecision: refIdsWithAnyLlmDecision.has(ref.ref_id),
            myFulltextDecision: myFulltextDecisions.get(ref.ref_id),
            allFulltextDecisions: allFulltextDecisionsMap.get(ref.ref_id) || [],
        };
    });
}

/**
 * 不一致を検出
 * - 2人以上の判定がある場合、判定内容が異なれば不一致
 * - どちらか一方が未判定（pendingまたは判定なし）の場合も不一致
 */
function detectConflict(decisions: Decision[]): boolean {
    // 判定がない、または1人のみの場合は不一致なし
    if (decisions.length === 0) {
        return false;
    }

    if (decisions.length === 1) {
        // 1人だけ判定済み = もう1人が未判定 = 不一致
        return true;
    }

    // 2人以上の判定がある場合、判定内容をチェック
    const uniqueDecisions = new Set(decisions.map(d => d.decision));
    return uniqueDecisions.size > 1;
}

/**
 * 判定を保存（新規追加 or 更新）
 */
export async function saveDecision(spreadsheetId: string, decision: Decision): Promise<void> {
    // 既存の判定を検索（screening_phase ごとに分離して上書き）
    const decisionsData = await getDecisions(spreadsheetId);
    const targetPhase = decision.screening_phase ?? 'tiab';
    const existing = decisionsData.find(
        ({ decision: d }) =>
            d.ref_id === decision.ref_id &&
            d.reviewer_id === decision.reviewer_id &&
            (d.screening_phase ?? 'tiab') === targetPhase
    );

    const row = [
        decision.decision_id,
        decision.ref_id,
        decision.reviewer_id,
        decision.decision,
        decision.reason || '',
        '', // labels: 機能廃止のため常に空文字を保存
        decision.note || '',
        decision.decided_at,
        decision.client_version || '',
        decision.source_url || '',
        decision.screening_phase || '',
    ];

    if (existing) {
        // 既存行を更新
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${existing.rowIndex}:K${existing.rowIndex}`, [row]);
    } else {
        // 新規追加
        await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
    }
}

/**
 * 文献を追加（RISインポート用）
 */

/**
 * ハイライトキーワードの型
 */
export interface HighlightKeywords {
    include: string[];
    exclude: string[];
}

const ASSIGNMENT_CONFIG_KEYS = [
    'assignment_status',
    'assignment_calibration_size',
    'assignment_group_count',
    'assignment_reviewer_map',
    'assignment_seed',
    'assignment_generated_at',
    'assignment_dismissed_at',
];

export async function getAssignmentConfig(spreadsheetId: string): Promise<AssignmentConfig> {
    const config: AssignmentConfig = { ...DEFAULT_ASSIGNMENT_CONFIG, reviewerMap: {} };

    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);

        for (const row of values) {
            const key = row[0];
            const value = row[1];

            if (!ASSIGNMENT_CONFIG_KEYS.includes(key) || !value) continue;

            switch (key) {
                case 'assignment_status':
                    if (value === 'dismissed' || value === 'configured' || value === 'none') {
                        config.status = value;
                    }
                    break;
                case 'assignment_calibration_size':
                    config.calibrationSize = parseInt(value, 10) || DEFAULT_ASSIGNMENT_CONFIG.calibrationSize;
                    break;
                case 'assignment_group_count':
                    config.groupCount = parseInt(value, 10) || DEFAULT_ASSIGNMENT_CONFIG.groupCount;
                    break;
                case 'assignment_reviewer_map':
                    try {
                        config.reviewerMap = JSON.parse(value) || {};
                    } catch {
                        config.reviewerMap = {};
                    }
                    break;
                case 'assignment_seed':
                    config.seed = value;
                    break;
                case 'assignment_generated_at':
                    config.generatedAt = value;
                    break;
                case 'assignment_dismissed_at':
                    config.dismissedAt = value;
                    break;
            }
        }
    } catch (error) {
        console.log('[getAssignmentConfig] Config not found, using defaults:', error);
    }

    return config;
}

export async function saveAssignmentConfig(spreadsheetId: string, config: AssignmentConfig): Promise<void> {
    try {
        await trySaveAssignmentConfig(spreadsheetId, config);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveAssignmentConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveAssignmentConfig(spreadsheetId, config);
        } else {
            throw error;
        }
    }
}

async function trySaveAssignmentConfig(spreadsheetId: string, config: AssignmentConfig): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    const rowIndices: Record<string, number> = {};

    values.forEach((row, index) => {
        if (ASSIGNMENT_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1;
        }
    });

    const entries: Record<string, string> = {
        assignment_status: config.status,
        assignment_calibration_size: String(config.calibrationSize),
        assignment_group_count: String(config.groupCount),
        assignment_reviewer_map: JSON.stringify(config.reviewerMap || {}),
        assignment_seed: config.seed || '',
        assignment_generated_at: config.generatedAt || '',
        assignment_dismissed_at: config.dismissedAt || '',
    };

    for (const [key, value] of Object.entries(entries)) {
        if (rowIndices[key]) {
            await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndices[key]}`, [[value]]);
        } else {
            await appendRows(spreadsheetId, CONFIG_SHEET, [[key, value]]);
        }
    }
}

function columnNumberToLetter(columnIndex: number): string {
    let result = '';
    let current = columnIndex + 1;

    while (current > 0) {
        const remainder = (current - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        current = Math.floor((current - 1) / 26);
    }

    return result;
}

async function batchUpdateRanges(
    spreadsheetId: string,
    updates: Array<{ range: string; values: string[][] }>
): Promise<void> {
    const token = await getAuthToken();
    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                valueInputOption: 'USER_ENTERED',
                data: updates,
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to batch update ranges: ${error.error?.message || response.statusText}`);
    }
}

export async function updateReferenceScreeningSets(
    spreadsheetId: string,
    assignments: Array<{ refId: string; screeningSet: string }>
): Promise<void> {
    if (assignments.length === 0) return;

    await ensureHeaders(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:S`);
    if (values.length <= 1) return;

    const headers = values[0];
    const refIdIndex = headers.indexOf('ref_id');
    const screeningSetIndex = headers.indexOf('screening_set');

    if (refIdIndex === -1 || screeningSetIndex === -1) {
        throw new Error('screening_set column not found');
    }

    const rowIndexByRefId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const refId = (row[refIdIndex] || '').trim();
        if (refId) {
            rowIndexByRefId.set(refId, index + 2);
        }
    });

    const column = columnNumberToLetter(screeningSetIndex);
    const updates = assignments
        .map(({ refId, screeningSet }) => {
            const rowIndex = rowIndexByRefId.get(refId);
            if (!rowIndex) return null;
            return {
                range: `${REFERENCES_SHEET}!${column}${rowIndex}`,
                values: [[screeningSet]],
            };
        })
        .filter((update): update is { range: string; values: string[][] } => update !== null);

    const batchSize = 500;
    for (let i = 0; i < updates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, updates.slice(i, i + batchSize));
    }
}
/**
 * Config タブの共有設定（キー開封・キーワード・フルテキスト候補ルール）
 */
export interface ProjectConfigBundle {
    keyOpened: boolean;
    keywords: HighlightKeywords;
    fulltextPoolRule: FulltextPoolRule | null;
    // 採用するフルテキストAI判定ラウンド（reviewer_id = `llm:{model}@{timestamp}`）。未設定は null。
    fulltextAiActiveRound: string | null;
    // ブラインド中（AI判断 非開示時）のAI evidence 表示レベル。実験条件（ヒト単独 vs AI支援）の制御に使う。
    fulltextEvidenceDisplay: FulltextEvidenceDisplay;
}

/**
 * ブラインド中のAI evidence（ハイライト・根拠カード）の表示レベル。
 * Config タブのキー `fulltext_evidence_display` で共有設定する。
 * - none:    evidence 自体を表示しない（AI判定なしの文献と見分けが付かない表示にする）
 * - neutral: 単色ハイライト＋「AI注目箇所」ラベルのみ（polarity 非表示。既定値）
 * - full:    ブラインド中でも組入/除外の色分け・ラベルまで表示する
 * AI判断の開示時（keyOpened / 管理者トグル）は設定によらず full 相当で表示する。
 */
export type FulltextEvidenceDisplay = 'none' | 'neutral' | 'full';

function parseFulltextEvidenceDisplay(value: string | undefined): FulltextEvidenceDisplay {
    const v = (value ?? '').trim().toLowerCase();
    return v === 'none' || v === 'neutral' || v === 'full' ? v : 'neutral';
}

const DEFAULT_CONFIG_BUNDLE: ProjectConfigBundle = {
    keyOpened: false,
    keywords: { include: DEFAULT_INCLUDE_KEYWORDS, exclude: DEFAULT_EXCLUDE_KEYWORDS },
    fulltextPoolRule: null,
    fulltextAiActiveRound: null,
    fulltextEvidenceDisplay: 'neutral',
};

/**
 * Config タブ（Key-Value 形式: A列=キー、B列=値）のシート値を共有設定に変換
 */
function parseConfigBundle(values: string[][]): ProjectConfigBundle {
    let includeKeywords = DEFAULT_INCLUDE_KEYWORDS;
    let excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS;
    let keyOpened = false;
    let fulltextPoolRule: FulltextPoolRule | null = null;
    let fulltextAiActiveRound: string | null = null;
    let fulltextEvidenceDisplay: FulltextEvidenceDisplay = 'neutral';

    for (const row of values) {
        if (row[0] === 'include_keywords' && row[1]) {
            const keywords = row[1]
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            if (keywords.length > 0) {
                includeKeywords = keywords;
            }
        }
        if (row[0] === 'exclude_keywords' && row[1]) {
            const keywords = row[1]
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            if (keywords.length > 0) {
                excludeKeywords = keywords;
            }
        }
        if (row[0] === 'key_opened') {
            keyOpened = row[1]?.toLowerCase() === 'true';
        }
        if (row[0] === 'fulltext_pool_rule' && row[1]) {
            fulltextPoolRule = parseFulltextPoolRule(row[1]);
        }
        if (row[0] === 'fulltext_ai_active_round') {
            fulltextAiActiveRound = row[1] ? row[1].trim() || null : null;
        }
        if (row[0] === 'fulltext_evidence_display') {
            fulltextEvidenceDisplay = parseFulltextEvidenceDisplay(row[1]);
        }
    }

    return {
        keyOpened,
        keywords: { include: includeKeywords, exclude: excludeKeywords },
        fulltextPoolRule,
        fulltextAiActiveRound,
        fulltextEvidenceDisplay,
    };
}

/**
 * Config タブの共有設定をまとめて取得（1リクエスト）
 * getKeyOpenedStatus + getHighlightKeywords + getFulltextPoolRule を
 * 個別に呼ぶとConfigを3回読むため、初期ロードではこちらを使うこと（429対策）。
 */
export async function getProjectConfigBundle(spreadsheetId: string): Promise<ProjectConfigBundle> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseConfigBundle(values);
    } catch (error) {
        console.log('[getProjectConfigBundle] Config not found, using defaults:', error);
        return { ...DEFAULT_CONFIG_BUNDLE };
    }
}

/**
 * フルテキストページの初期データをまとめて取得（1リクエスト）
 * References / Decisions / Config を values:batchGet で取得する。
 */
export async function getFulltextPageData(spreadsheetId: string): Promise<{
    references: Reference[];
    decisions: { decision: Decision; rowIndex: number }[];
    config: ProjectConfigBundle;
}> {
    try {
        const [refValues, decValues, configValues] = await getSheetValuesBatch(spreadsheetId, [
            `${REFERENCES_SHEET}!A:U`,
            `${DECISIONS_SHEET}!A:K`,
            `${CONFIG_SHEET}!A:B`,
        ]);
        return {
            references: parseReferenceValues(refValues),
            decisions: parseDecisionValues(decValues),
            config: parseConfigBundle(configValues),
        };
    } catch (error) {
        // Config タブがない旧シートでは batchGet 全体が失敗するため、Config 抜きで再試行
        if ((error as Error).message.includes('Unable to parse range')) {
            console.log('[getFulltextPageData] Config sheet missing, falling back:', error);
            const [refValues, decValues] = await getSheetValuesBatch(spreadsheetId, [
                `${REFERENCES_SHEET}!A:U`,
                `${DECISIONS_SHEET}!A:K`,
            ]);
            return {
                references: parseReferenceValues(refValues),
                decisions: parseDecisionValues(decValues),
                config: { ...DEFAULT_CONFIG_BUNDLE },
            };
        }
        throw error;
    }
}

/**
 * Config タブからハイライトキーワードを取得
 * Config タブは Key-Value 形式（A列=キー、B列=値）を想定
 * 見つからない場合はデフォルト値を返す
 */
export async function getHighlightKeywords(spreadsheetId: string): Promise<HighlightKeywords> {
    const bundle = await getProjectConfigBundle(spreadsheetId);
    return bundle.keywords;
}

/**
 * Config タブのハイライトキーワードを更新
 */
async function addSheet(spreadsheetId: string, title: string): Promise<void> {
    const token = await getAuthToken();
    const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            requests: [
                {
                    addSheet: {
                        properties: {
                            title: title
                        }
                    }
                }
            ]
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to add sheet: ${error.error?.message || response.statusText}`);
    }
}

/**
 * Config タブのハイライトキーワードを更新
 */
export async function updateConfigKeywords(
    spreadsheetId: string,
    keywords: HighlightKeywords
): Promise<void> {
    try {
        await tryUpdateConfig(spreadsheetId, keywords);
    } catch (error) {
        // シートがない場合のエラーハンドリング
        // "Unable to parse range: Config!A:B" のようなエラーが返る
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[updateConfigKeywords] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            // 再試行
            await tryUpdateConfig(spreadsheetId, keywords);
        } else {
            console.error('[updateConfigKeywords] Failed:', error);
            throw error;
        }
    }
}

async function tryUpdateConfig(spreadsheetId: string, keywords: HighlightKeywords) {
    // Config シートの全データを取得
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let includeRowIndex = -1;
    let excludeRowIndex = -1;

    // 既存の行を探す
    values.forEach((row, index) => {
        if (row[0] === 'include_keywords') includeRowIndex = index + 1; // 1-indexed
        if (row[0] === 'exclude_keywords') excludeRowIndex = index + 1;
    });

    // include_keywords 更新
    const includeValue = keywords.include.join(',');
    if (includeRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${includeRowIndex}`, [[includeValue]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['include_keywords', includeValue]]);
    }

    // exclude_keywords 更新
    const excludeValue = keywords.exclude.join(',');
    if (excludeRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${excludeRowIndex}`, [[excludeValue]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['exclude_keywords', excludeValue]]);
    }
}

/**
 * スプレッドシートの権限情報を取得
 */
export interface SpreadsheetPermission {
    role: 'owner' | 'writer' | 'reader';
    emailAddress: string;
}

export async function getSpreadsheetPermissions(spreadsheetId: string): Promise<SpreadsheetPermission[]> {
    const token = await getAuthToken();

    const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?fields=permissions(role,emailAddress)`,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to get permissions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.permissions || [];
}

/**
 * 共有設定を追加（Google Drive API）
 */
export async function addPermission(fileId: string, emailAddress: string, role: 'writer' | 'reader' = 'writer'): Promise<void> {
    const token = await getAuthToken();

    const response = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                role: role,
                type: 'user',
                emailAddress: emailAddress,
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || response.statusText);
    }
}

/**
 * ユーザーが管理者権限（編集権限）を持っているかチェック
 * - Permissions APIがつかえない場合（drive.fileスコープの制限など）は
 *   ファイルのcapabilitiesをチェックする
 */
export async function isUserAdmin(spreadsheetId: string, userEmail: string): Promise<boolean> {
    console.log('[isUserAdmin] Starting check for:', userEmail);
    try {
        // 方法1: Permissions API (既存)
        try {
            console.log('[isUserAdmin] Trying permissions API...');
            const permissions = await getSpreadsheetPermissions(spreadsheetId);
            console.log('[isUserAdmin] Got permissions:', permissions.length);

            const userPermission = permissions.find(p => p.emailAddress === userEmail);
            console.log('[isUserAdmin] User permission:', userPermission);

            if (userPermission) {
                const isAdmin = userPermission.role === 'owner' || userPermission.role === 'writer';
                console.log('[isUserAdmin] Result from permissions:', isAdmin);
                return isAdmin;
            }
        } catch (permError) {
            console.warn('[isUserAdmin] Permissions check failed:', permError);
        }

        // 方法2: Capabilities API (Fallback)
        console.log('[isUserAdmin] Trying capabilities fallback...');
        const token = await getAuthToken();
        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=capabilities(canEdit,canShare)`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            }
        );

        console.log('[isUserAdmin] Capabilities response status:', response.status);
        if (response.ok) {
            const data = await response.json();
            console.log('[isUserAdmin] Capabilities data:', data);
            const canEdit = data.capabilities?.canEdit === true;
            console.log('[isUserAdmin] Result from capabilities:', canEdit);
            return canEdit;
        }

        console.log('[isUserAdmin] All checks failed, returning false');
        return false;
    } catch (error) {
        console.error('[isUserAdmin] Error:', error);
        return false;
    }
}

/**
 * フルテキスト候補ルールを取得（未設定・不正値は null）
 */
export async function getFulltextPoolRule(spreadsheetId: string): Promise<FulltextPoolRule | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'fulltext_pool_rule' && row[1]) {
                return parseFulltextPoolRule(row[1]);
            }
        }
        return null;
    } catch (error) {
        console.log('[getFulltextPoolRule] Config not found, returning null:', error);
        return null;
    }
}

/**
 * フルテキスト候補ルールを保存
 */
export async function saveFulltextPoolRule(spreadsheetId: string, rule: FulltextPoolRule): Promise<void> {
    try {
        await trySaveFulltextPoolRule(spreadsheetId, rule);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveFulltextPoolRule] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveFulltextPoolRule(spreadsheetId, rule);
        } else {
            throw error;
        }
    }
}

async function trySaveFulltextPoolRule(spreadsheetId: string, rule: FulltextPoolRule): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let ruleRowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'fulltext_pool_rule') ruleRowIndex = index + 1;
    });

    const value = JSON.stringify(rule);
    if (ruleRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${ruleRowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['fulltext_pool_rule', value]]);
    }
}

// ---------------------------------------------------------------------------
// フルテキストAI判定の採用ラウンド（reviewer_id = `llm:{model}@{timestamp}`）
// ---------------------------------------------------------------------------

/** 採用中のフルテキストAI判定ラウンド（reviewer_id）を取得。未設定は null。 */
export async function getFulltextAiActiveRound(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'fulltext_ai_active_round') {
                const v = (row[1] || '').trim();
                return v || null;
            }
        }
        return null;
    } catch (error) {
        console.log('[getFulltextAiActiveRound] Config not found:', error);
        return null;
    }
}

/** 採用するフルテキストAI判定ラウンドを設定する（null で採用解除）。 */
export async function setFulltextAiActiveRound(spreadsheetId: string, reviewerId: string | null): Promise<void> {
    try {
        await trySetFulltextAiActiveRound(spreadsheetId, reviewerId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySetFulltextAiActiveRound(spreadsheetId, reviewerId);
        } else {
            throw error;
        }
    }
}

async function trySetFulltextAiActiveRound(spreadsheetId: string, reviewerId: string | null): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;
    values.forEach((row, index) => {
        if (row[0] === 'fulltext_ai_active_round') rowIndex = index + 1;
    });
    const value = reviewerId ?? '';
    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['fulltext_ai_active_round', value]]);
    }
}

/**
 * フルテキストAI判定の1ラウンド（特定 reviewer_id・fulltext フェーズ）の判定行を全削除する。
 * 採用中ラウンドを削除した場合は採用を解除する。
 * @returns 削除した行数
 */
export async function deleteFulltextAiRound(spreadsheetId: string, reviewerId: string): Promise<number> {
    const decisionsData = await getDecisions(spreadsheetId);
    const targetRows = decisionsData
        .filter(({ decision }) =>
            decision.reviewer_id === reviewerId &&
            (decision.screening_phase ?? 'tiab') === 'fulltext'
        )
        .map(({ rowIndex }) => rowIndex); // 1始まりのシート行番号

    if (targetRows.length === 0) return 0;

    const sheetId = await getSheetIdByName(spreadsheetId, DECISIONS_SHEET);
    if (sheetId === null) throw new Error('Decisions sheet not found');

    // deleteDimension は 0-indexed。後ろの行から削除してインデックスのズレを防ぐ。
    const sorted = [...new Set(targetRows)].sort((a, b) => b - a);
    const requests = sorted.map(r => ({
        deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r },
        },
    }));

    const token = await getAuthToken();
    const response = await fetch(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    });
    if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error?.message || response.statusText);
    }

    // 採用中ラウンドを消したら採用解除
    const active = await getFulltextAiActiveRound(spreadsheetId);
    if (active === reviewerId) {
        await setFulltextAiActiveRound(spreadsheetId, null).catch(() => { /* 解除失敗は致命でない */ });
    }

    return targetRows.length;
}

/**
 * キーオープン状態を取得
 */
export async function getKeyOpenedStatus(spreadsheetId: string): Promise<boolean> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'key_opened') {
                return row[1]?.toLowerCase() === 'true';
            }
        }
        return false;
    } catch (error) {
        console.log('[getKeyOpenedStatus] Config not found, returning false:', error);
        return false;
    }
}

/**
 * キーオープン状態を設定
 */
export async function setKeyOpenedStatus(spreadsheetId: string, opened: boolean): Promise<void> {
    try {
        await trySetKeyOpened(spreadsheetId, opened);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[setKeyOpenedStatus] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySetKeyOpened(spreadsheetId, opened);
        } else {
            throw error;
        }
    }
}

async function trySetKeyOpened(spreadsheetId: string, opened: boolean) {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let keyOpenedRowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'key_opened') keyOpenedRowIndex = index + 1;
    });

    const value = opened ? 'true' : 'false';
    if (keyOpenedRowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${keyOpenedRowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['key_opened', value]]);
    }
}

/**
 * フルテキストPDF保存用 Drive フォルダIDを取得（未設定は null）
 */
export async function getFulltextDriveFolderId(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'fulltext_drive_folder' && row[1]) {
                return row[1];
            }
        }
        return null;
    } catch (error) {
        console.log('[getFulltextDriveFolderId] Config not found, returning null:', error);
        return null;
    }
}

/**
 * フルテキストPDF保存用 Drive フォルダIDを保存
 */
export async function saveFulltextDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    try {
        await trySaveFulltextDriveFolderId(spreadsheetId, folderId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveFulltextDriveFolderId] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveFulltextDriveFolderId(spreadsheetId, folderId);
        } else {
            throw error;
        }
    }
}

async function trySaveFulltextDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'fulltext_drive_folder') rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[folderId]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['fulltext_drive_folder', folderId]]);
    }
}

/**
 * プロジェクト用 Drive フォルダIDを取得（未設定は null）
 * このフォルダ配下にスプレッドシート本体と fulltext サブフォルダを格納する。
 */
export async function getProjectDriveFolderId(spreadsheetId: string): Promise<string | null> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        for (const row of values) {
            if (row[0] === 'project_drive_folder' && row[1]) {
                return row[1];
            }
        }
        return null;
    } catch (error) {
        console.log('[getProjectDriveFolderId] Config not found, returning null:', error);
        return null;
    }
}

/**
 * プロジェクト用 Drive フォルダIDを保存
 */
export async function saveProjectDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    try {
        await trySaveProjectDriveFolderId(spreadsheetId, folderId);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveProjectDriveFolderId] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveProjectDriveFolderId(spreadsheetId, folderId);
        } else {
            throw error;
        }
    }
}

async function trySaveProjectDriveFolderId(spreadsheetId: string, folderId: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === 'project_drive_folder') rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[folderId]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [['project_drive_folder', folderId]]);
    }
}

// ========== LLM関連の関数 ==========

/**
 * デフォルトのLLM設定
 */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
    llm_enabled: false,
    llm_model: 'gemini-3.1-flash-lite',
    llm_temperature: 0,
    llm_thinking: 'low',
    llm_protocol_text: '',
    llm_criteria: null,
    llm_screening_prompt: '',
    llm_include_threshold: 0.3,
    llm_max_output_tokens: 2048,
    llm_output_language: 'ja',
};

/**
 * LLM設定キーのリスト
 */
const LLM_CONFIG_KEYS = [
    'llm_enabled',
    'llm_model',
    'llm_temperature',
    'llm_thinking',
    'llm_protocol_text',
    'llm_criteria',
    'llm_screening_prompt',
    'llm_include_threshold',
    'llm_max_output_tokens',
    'llm_output_language',
];

/**
 * ConfigシートからLLM設定を取得
 */
export async function getLlmConfig(spreadsheetId: string): Promise<LlmConfig> {
    const config = { ...DEFAULT_LLM_CONFIG };

    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);

        for (const row of values) {
            const key = row[0];
            const value = row[1];

            if (!LLM_CONFIG_KEYS.includes(key) || !value) continue;

            switch (key) {
                case 'llm_enabled':
                    config.llm_enabled = value.toLowerCase() === 'true';
                    break;
                case 'llm_model':
                    // latest エイリアスを固定バージョン ID へマイグレーション
                    // (2026-05 以降の保存値は固定 ID。既存シートの latest 値はここで透過的に変換)
                    config.llm_model = MODEL_ID_MIGRATIONS[value] || value;
                    break;
                case 'llm_temperature':
                    config.llm_temperature = parseFloat(value) || 0;
                    break;
                case 'llm_thinking':
                    config.llm_thinking = value === 'high' ? 'high' : 'low';
                    break;
                case 'llm_protocol_text':
                    config.llm_protocol_text = value;
                    break;
                case 'llm_criteria':
                    try {
                        config.llm_criteria = JSON.parse(value);
                    } catch {
                        config.llm_criteria = null;
                    }
                    break;
                case 'llm_screening_prompt':
                    config.llm_screening_prompt = value;
                    break;
                case 'llm_include_threshold':
                    config.llm_include_threshold = parseFloat(value) || 0.3;
                    break;
                case 'llm_max_output_tokens':
                    config.llm_max_output_tokens = parseInt(value, 10) || 2048;
                    break;
                case 'llm_output_language':
                    config.llm_output_language = value;
                    break;
            }
        }
    } catch (error) {
        console.log('[getLlmConfig] Config not found, using defaults:', error);
    }

    return config;
}

/**
 * LLM設定を更新
 */
export async function updateLlmConfig(
    spreadsheetId: string,
    updates: Partial<LlmConfig>
): Promise<void> {
    try {
        await tryUpdateLlmConfig(spreadsheetId, updates);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[updateLlmConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await tryUpdateLlmConfig(spreadsheetId, updates);
        } else {
            throw error;
        }
    }
}

async function tryUpdateLlmConfig(spreadsheetId: string, updates: Partial<LlmConfig>): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);

    // 既存行のインデックスをマップ
    const rowIndices: Record<string, number> = {};
    values.forEach((row, index) => {
        if (LLM_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1; // 1-indexed
        }
    });

    // 各キーを更新
    for (const [key, value] of Object.entries(updates)) {
        if (!LLM_CONFIG_KEYS.includes(key)) continue;

        let stringValue: string;
        if (typeof value === 'boolean') {
            stringValue = value ? 'true' : 'false';
        } else if (typeof value === 'object' && value !== null) {
            stringValue = JSON.stringify(value);
        } else if (value === null) {
            stringValue = '';
        } else {
            stringValue = String(value);
        }

        if (rowIndices[key]) {
            await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndices[key]}`, [[stringValue]]);
        } else {
            await appendRows(spreadsheetId, CONFIG_SHEET, [[key, stringValue]]);
        }
    }
}

/**
 * LLM_Executionsシートを初期化（存在しない場合）
 *
 * 既存シートに新規列（run_id 等）が無い場合は、ヘッダー行を拡張する。
 * 既存データ行は影響を受けない（run_id は空文字として読まれる）。
 */
export async function ensureLlmExecutionsSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        // ヘッダー行が空（シートはあるが初期化されていない）
        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [LLM_EXECUTIONS_HEADERS]);
            return;
        }

        // 不足している列を末尾に追加（後方互換マイグレーション）
        const missingHeaders = LLM_EXECUTIONS_HEADERS.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
            const newHeaders = [...existingHeaders, ...missingHeaders];
            const startCol = columnNumberToLetter(existingHeaders.length);
            const endCol = columnNumberToLetter(newHeaders.length - 1);
            await updateRange(
                spreadsheetId,
                `${LLM_EXECUTIONS_SHEET}!${startCol}1:${endCol}1`,
                [missingHeaders]
            );
            console.log(`[ensureLlmExecutionsSheet] Added missing columns: ${missingHeaders.join(', ')}`);
        }
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[ensureLlmExecutionsSheet] Creating LLM_Executions sheet...');
            await addSheet(spreadsheetId, LLM_EXECUTIONS_SHEET);
            await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [LLM_EXECUTIONS_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * LLM_Runs シートを初期化（存在しない場合）
 */
export async function ensureLlmRunsSheet(spreadsheetId: string): Promise<void> {
    try {
        const headerRow = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!1:1`);
        const existingHeaders = headerRow[0] || [];

        if (existingHeaders.length === 0) {
            await appendRows(spreadsheetId, LLM_RUNS_SHEET, [LLM_RUNS_HEADERS]);
            return;
        }

        const missingHeaders = LLM_RUNS_HEADERS.filter(h => !existingHeaders.includes(h));
        if (missingHeaders.length > 0) {
            const newHeaders = [...existingHeaders, ...missingHeaders];
            const startCol = columnNumberToLetter(existingHeaders.length);
            const endCol = columnNumberToLetter(newHeaders.length - 1);
            await updateRange(
                spreadsheetId,
                `${LLM_RUNS_SHEET}!${startCol}1:${endCol}1`,
                [missingHeaders]
            );
            console.log(`[ensureLlmRunsSheet] Added missing columns: ${missingHeaders.join(', ')}`);
        }
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[ensureLlmRunsSheet] Creating LLM_Runs sheet...');
            await addSheet(spreadsheetId, LLM_RUNS_SHEET);
            await appendRows(spreadsheetId, LLM_RUNS_SHEET, [LLM_RUNS_HEADERS]);
        } else {
            throw error;
        }
    }
}

/**
 * LLM実行履歴を保存
 *
 * run_id は呼び出し側で設定済みであることを期待する。
 * 未設定の場合は空欄で保存され、次回 getLlmRuns 時の Lazy 移行で自動的に埋まる。
 */
export async function saveLlmExecution(spreadsheetId: string, execution: LlmExecution): Promise<void> {
    await ensureLlmExecutionsSheet(spreadsheetId);

    const row = [
        execution.execution_id,
        execution.execution_type,
        execution.timestamp,
        execution.model,
        execution.temperature?.toString() ?? '',
        execution.topP?.toString() ?? '',
        execution.thinkingLevel ?? '',
        execution.criteria_snapshot ? JSON.stringify(execution.criteria_snapshot) : '',
        execution.screening_prompt,
        execution.include_threshold.toString(),
        execution.target_count.toString(),
        execution.include_count.toString(),
        execution.exclude_count.toString(),
        execution.status,
        execution.is_active ? 'true' : 'false',
        execution.run_id ?? '',
        execution.requested_model ?? execution.model,
        execution.model_version ?? '',
        execution.response_id ?? '',
    ];

    await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [row]);
}

/**
 * LLM実行履歴を取得
 *
 * 動的にヘッダーから列範囲を決めるため、シートに後から追加された列にも追従する。
 */
export async function getLlmExecutions(spreadsheetId: string): Promise<LlmExecution[]> {
    try {
        await ensureLlmExecutionsSheet(spreadsheetId);
        const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
        const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);

        if (values.length <= 1) {
            return [];
        }

        const headers = values[0];
        const rows = values.slice(1);

        return rows.map(row => {
            const execution: Record<string, unknown> = {};
            headers.forEach((header, i) => {
                const value = row[i] || '';
                switch (header) {
                    case 'include_threshold':
                        execution[header] = parseFloat(value) || 0;
                        break;
                    case 'target_count':
                    case 'include_count':
                    case 'exclude_count':
                        execution[header] = parseInt(value, 10) || 0;
                        break;
                    case 'criteria_snapshot':
                        try {
                            execution[header] = value ? JSON.parse(value) : null;
                        } catch {
                            execution[header] = null;
                        }
                        break;
                    case 'is_active':
                        execution[header] = value.toLowerCase() === 'true';
                        break;
                    case 'status':
                        execution[header] = value === 'pending' ? 'pending' : 'confirmed';
                        break;
                    case 'run_id':
                        execution[header] = value || undefined;
                        break;
                    default:
                        execution[header] = value || '';
                }
            });
            return execution as unknown as LlmExecution;
        });
    } catch (error) {
        console.error('[getLlmExecutions] Error:', error);
        return [];
    }
}

/**
 * LLM実行履歴を更新
 */
export async function updateLlmExecution(
    spreadsheetId: string,
    executionId: string,
    updates: Partial<LlmExecution>
): Promise<void> {
    console.log('[updateLlmExecution] Starting with executionId:', executionId);
    console.log('[updateLlmExecution] Updates:', updates);

    await ensureLlmExecutionsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);

    console.log('[updateLlmExecution] Sheet rows count:', values.length);

    if (values.length <= 1) {
        throw new Error('Execution not found');
    }

    // execution_idで行を検索
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
        if (values[i][0] === executionId) {
            rowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Execution not found: ${executionId}`);
    }

    const currentRow = values[rowIndex - 1];
    const headers = values[0];

    // 更新行を構築
    const newRow = headers.map((header, i) => {
        if (updates[header as keyof LlmExecution] !== undefined) {
            const value = updates[header as keyof LlmExecution];
            if (header === 'criteria_snapshot') {
                return value ? JSON.stringify(value) : '';
            } else if (header === 'is_active') {
                return value ? 'true' : 'false';
            } else if (typeof value === 'number') {
                return value.toString();
            } else {
                return String(value);
            }
        }
        return currentRow[i] || '';
    });

    await updateRange(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A${rowIndex}:${endCol}${rowIndex}`, [newRow]);
}

// ============================================================
// LLM_Runs シート I/O (Run = config_hash 単位の論理実行)
// ============================================================

/**
 * 行配列を LlmRun に変換
 */
function parseLlmRunRow(row: string[], headers: string[]): LlmRun {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, i) => {
        const value = row[i] || '';
        switch (header) {
            case 'include_threshold':
                obj[header] = parseFloat(value) || 0;
                break;
            case 'temperature':
            case 'topP':
                obj[header] = value ? parseFloat(value) : undefined;
                break;
            case 'criteria_snapshot':
                try {
                    obj[header] = value ? JSON.parse(value) : null;
                } catch {
                    obj[header] = null;
                }
                break;
            case 'is_active':
                obj[header] = value.toLowerCase() === 'true';
                break;
            case 'status':
                obj[header] = value === 'pending' ? 'pending' : 'confirmed';
                break;
            case 'thinkingLevel':
                obj[header] = value || undefined;
                break;
            default:
                obj[header] = value || '';
        }
    });
    return obj as unknown as LlmRun;
}

/**
 * LlmRun を行配列にシリアライズ（LLM_RUNS_HEADERS の順序に従う）
 */
function serializeLlmRunRow(run: LlmRun): string[] {
    return LLM_RUNS_HEADERS.map(header => {
        const value = (run as unknown as Record<string, unknown>)[header];
        if (value === undefined || value === null) return '';
        if (header === 'criteria_snapshot') {
            return value ? JSON.stringify(value) : '';
        }
        if (header === 'is_active') {
            return value ? 'true' : 'false';
        }
        if (typeof value === 'number') {
            return value.toString();
        }
        return String(value);
    });
}

/**
 * LLM_Runs シートの全 Run 行を生データのまま取得（移行を起こさない内部関数）
 */
async function getLlmRunsRaw(spreadsheetId: string): Promise<LlmRun[]> {
    await ensureLlmRunsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_RUNS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!A:${endCol}`);
    if (values.length <= 1) return [];
    const headers = values[0];
    return values.slice(1).map(row => parseLlmRunRow(row, headers));
}

/**
 * LLM_Runs に新規 Run を追加
 */
export async function saveLlmRun(spreadsheetId: string, run: LlmRun): Promise<void> {
    await ensureLlmRunsSheet(spreadsheetId);
    await appendRows(spreadsheetId, LLM_RUNS_SHEET, [serializeLlmRunRow(run)]);
}

/**
 * LLM_Runs の Run を更新
 */
export async function updateLlmRun(
    spreadsheetId: string,
    runId: string,
    updates: Partial<LlmRun>
): Promise<void> {
    await ensureLlmRunsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_RUNS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_RUNS_SHEET}!A:${endCol}`);

    if (values.length <= 1) {
        throw new Error('Run not found');
    }

    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
        if (values[i][0] === runId) {
            rowIndex = i + 1;
            break;
        }
    }

    if (rowIndex === -1) {
        throw new Error(`Run not found: ${runId}`);
    }

    const headers = values[0];
    const currentRow = values[rowIndex - 1];

    const newRow = headers.map((header, i) => {
        if (updates[header as keyof LlmRun] !== undefined) {
            const value = updates[header as keyof LlmRun];
            if (header === 'criteria_snapshot') {
                return value ? JSON.stringify(value) : '';
            }
            if (header === 'is_active') {
                return value ? 'true' : 'false';
            }
            if (typeof value === 'number') {
                return value.toString();
            }
            return String(value);
        }
        return currentRow[i] || '';
    });

    await updateRange(spreadsheetId, `${LLM_RUNS_SHEET}!A${rowIndex}:${endCol}${rowIndex}`, [newRow]);
}

/**
 * 複数 Batch row の run_id を一括更新（移行用）
 */
async function updateExecutionRunIds(
    spreadsheetId: string,
    assignments: Array<{ executionId: string; runId: string }>
): Promise<void> {
    if (assignments.length === 0) return;

    await ensureLlmExecutionsSheet(spreadsheetId);
    const endCol = columnNumberToLetter(LLM_EXECUTIONS_HEADERS.length - 1);
    const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:${endCol}`);
    if (values.length <= 1) return;

    const headers = values[0];
    const runIdColIndex = headers.indexOf('run_id');
    if (runIdColIndex === -1) {
        throw new Error('run_id column not found in LLM_Executions');
    }

    const rowIndexByExecutionId = new Map<string, number>();
    values.slice(1).forEach((row, idx) => {
        const id = (row[0] || '').trim();
        if (id) rowIndexByExecutionId.set(id, idx + 2);
    });

    const runIdCol = columnNumberToLetter(runIdColIndex);
    const updates = assignments
        .map(({ executionId, runId }) => {
            const rowIndex = rowIndexByExecutionId.get(executionId);
            if (!rowIndex) return null;
            return {
                range: `${LLM_EXECUTIONS_SHEET}!${runIdCol}${rowIndex}`,
                values: [[runId]],
            };
        })
        .filter((u): u is { range: string; values: string[][] } => u !== null);

    const batchSize = 500;
    for (let i = 0; i < updates.length; i += batchSize) {
        await batchUpdateRanges(spreadsheetId, updates.slice(i, i + batchSize));
    }
}

/**
 * 既存 LLM_Executions の Batch row のうち run_id が空のものを Run に集約する。
 *
 * 集約方針:
 * - execution_type='batch_screening' のみを対象
 * - config_hash でグループ化（criteria/prompt 欠損 row は legacy:<execution_id> で孤立）
 * - 既存 LLM_Runs に同 config_hash がある → run_id 再利用
 * - 無い → 新規 Run 作成。属性は配下バッチから優先順位で決定:
 *     1. is_active=true かつ confirmed
 *     2. 最新 confirmed
 *     3. 最新 row（pending 扱い）
 *
 * 冪等性: run_id 空の row のみを処理するため、複数回呼んでも安全。
 */
async function migrateLegacyExecutionsToRuns(
    spreadsheetId: string,
    existingRuns: LlmRun[],
    allBatches: LlmExecution[]
): Promise<{ runs: LlmRun[]; newRuns: LlmRun[]; assignments: Array<{ executionId: string; runId: string }> }> {
    const targets = allBatches.filter(
        b => b.execution_type === 'batch_screening' && !b.run_id
    );

    if (targets.length === 0) {
        return { runs: existingRuns, newRuns: [], assignments: [] };
    }

    // 各 Batch のハッシュを計算
    const targetHashes = await Promise.all(
        targets.map(async batch => {
            if (!isHashable(batch)) {
                return { batch, hash: legacyHash(batch.execution_id) };
            }
            const hash = await computeConfigHash({
                model: batch.model,
                temperature: batch.temperature,
                topP: batch.topP,
                thinkingLevel: batch.thinkingLevel,
                criteria_snapshot: batch.criteria_snapshot,
                screening_prompt: batch.screening_prompt,
            });
            return { batch, hash };
        })
    );

    // config_hash ごとにグループ化
    const groups = new Map<string, LlmExecution[]>();
    for (const { batch, hash } of targetHashes) {
        const list = groups.get(hash) ?? [];
        list.push(batch);
        groups.set(hash, list);
    }

    const runByHash = new Map<string, LlmRun>();
    for (const run of existingRuns) {
        runByHash.set(run.config_hash, run);
    }

    const newRuns: LlmRun[] = [];
    const assignments: Array<{ executionId: string; runId: string }> = [];

    for (const [hash, batches] of groups.entries()) {
        let run = runByHash.get(hash);

        if (!run) {
            // 新規 Run を作成
            const sorted = [...batches].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );
            const oldest = sorted[0];

            // 属性決定: active confirmed > 最新 confirmed > 最新 row
            const activeConfirmed = batches.find(b => b.is_active && b.status === 'confirmed');
            const confirmedSorted = batches
                .filter(b => b.status === 'confirmed')
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const latestSorted = [...batches].sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );

            const sourceForAttrs = activeConfirmed ?? confirmedSorted[0] ?? latestSorted[0];

            run = {
                run_id: crypto.randomUUID(),
                config_hash: hash,
                created_at: oldest.timestamp,
                model: sourceForAttrs.model,
                requested_model: sourceForAttrs.requested_model ?? sourceForAttrs.model,
                model_version: sourceForAttrs.model_version,
                response_id: sourceForAttrs.response_id,
                temperature: sourceForAttrs.temperature,
                topP: sourceForAttrs.topP,
                thinkingLevel: sourceForAttrs.thinkingLevel,
                criteria_snapshot: sourceForAttrs.criteria_snapshot,
                screening_prompt: sourceForAttrs.screening_prompt,
                include_threshold: sourceForAttrs.include_threshold,
                status: sourceForAttrs.status,
                is_active: Boolean(activeConfirmed),
            };
            newRuns.push(run);
            runByHash.set(hash, run);
        }

        for (const batch of batches) {
            assignments.push({ executionId: batch.execution_id, runId: run.run_id });
        }
    }

    // 永続化
    if (newRuns.length > 0) {
        const rows = newRuns.map(serializeLlmRunRow);
        await appendRows(spreadsheetId, LLM_RUNS_SHEET, rows);
    }
    if (assignments.length > 0) {
        await updateExecutionRunIds(spreadsheetId, assignments);
    }

    return {
        runs: [...existingRuns, ...newRuns],
        newRuns,
        assignments,
    };
}

/**
 * LLM_Runs シートの全 Run を取得する。
 *
 * 呼び出し時に Lazy 移行を実行:
 * - LLM_Executions に run_id 列が無ければ追加
 * - run_id 空の Batch row を config_hash で集約して Run を生成
 */
export async function getLlmRuns(spreadsheetId: string): Promise<LlmRun[]> {
    try {
        await ensureLlmRunsSheet(spreadsheetId);
        await ensureLlmExecutionsSheet(spreadsheetId);

        const [existingRuns, allBatches] = await Promise.all([
            getLlmRunsRaw(spreadsheetId),
            getLlmExecutions(spreadsheetId),
        ]);

        const { runs } = await migrateLegacyExecutionsToRuns(
            spreadsheetId,
            existingRuns,
            allBatches
        );

        return runs;
    } catch (error) {
        console.error('[getLlmRuns] Error:', error);
        return [];
    }
}

// ============================================================
// Run/Batch 結合・active 解決ヘルパー
// ============================================================

/**
 * config_hash で Run を検索する。
 * 複数ヒット時の優先順位: active confirmed > 最新 confirmed > 最新 created_at
 */
export async function findRunByConfigHash(
    spreadsheetId: string,
    configHash: string
): Promise<LlmRun | null> {
    const runs = await getLlmRuns(spreadsheetId);
    const matched = runs.filter(r => r.config_hash === configHash);
    if (matched.length === 0) return null;

    const activeConfirmed = matched.find(r => r.is_active && r.status === 'confirmed');
    if (activeConfirmed) return activeConfirmed;

    const confirmed = matched
        .filter(r => r.status === 'confirmed')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (confirmed.length > 0) return confirmed[0];

    return matched.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
}

/**
 * 現在の active Run（is_active=true かつ confirmed）を1件返す。
 * 複数候補があれば created_at が新しい方を採用。
 */
export async function getActiveLlmRun(spreadsheetId: string): Promise<LlmRun | null> {
    const runs = await getLlmRuns(spreadsheetId);
    const candidates = runs
        .filter(r => r.is_active && r.status === 'confirmed')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return candidates[0] ?? null;
}

/**
 * Batch ID から所属する Run を逆引きする。
 */
export async function getRunForBatchId(
    spreadsheetId: string,
    batchId: string
): Promise<LlmRun | null> {
    const [runs, batches] = await Promise.all([
        getLlmRuns(spreadsheetId),
        getLlmExecutions(spreadsheetId),
    ]);
    const batch = batches.find(b => b.execution_id === batchId);
    if (!batch || !batch.run_id) return null;
    return runs.find(r => r.run_id === batch.run_id) ?? null;
}

/**
 * 指定 Run に属する全 Batch ID（execution_id）を返す。
 */
export async function getBatchIdsForRun(
    spreadsheetId: string,
    runId: string,
    batches?: LlmExecution[]
): Promise<Set<string>> {
    const all = batches ?? await getLlmExecutions(spreadsheetId);
    return new Set(
        all
            .filter(b => b.execution_type === 'batch_screening' && b.run_id === runId)
            .map(b => b.execution_id)
    );
}

/**
 * active Run 配下の全 Batch IDs を返す。Decisions の絞り込みに使う。
 * batches を渡せば再フェッチを省略する。
 */
export async function getActiveBatchIdsForActiveRun(
    spreadsheetId: string,
    batches?: LlmExecution[]
): Promise<Set<string>> {
    const activeRun = await getActiveLlmRun(spreadsheetId);
    if (!activeRun) return new Set();
    return getBatchIdsForRun(spreadsheetId, activeRun.run_id, batches);
}

/**
 * 指定 Run のみを active=true にし、他の Run は false に切り替える。
 * 同一 spreadsheet 内で active な Run は常に高々1つの不変条件を保つ。
 */
export async function setSingleActiveRun(spreadsheetId: string, runId: string): Promise<void> {
    const runs = await getLlmRuns(spreadsheetId);
    for (const run of runs) {
        const shouldBeActive = run.run_id === runId;
        if (run.is_active !== shouldBeActive) {
            await updateLlmRun(spreadsheetId, run.run_id, { is_active: shouldBeActive });
        }
    }
}

/**
 * 複数のDecisionを一括追加（LLMバッチ用）
 */
export async function appendDecisions(spreadsheetId: string, decisions: Decision[]): Promise<void> {
    if (decisions.length === 0) return;

    const rows = decisions.map(decision => [
        decision.decision_id,
        decision.ref_id,
        decision.reviewer_id,
        decision.decision,
        decision.reason || '',
        '', // labels: 機能廃止のため空
        decision.note || '',
        decision.decided_at,
        decision.client_version || '',
        decision.source_url || '',
        decision.screening_phase || '',
    ]);

    await appendRows(spreadsheetId, DECISIONS_SHEET, rows);
}

/**
 * 特定のreviewer_idの既存Decisionsを取得
 */
export async function getDecisionsByReviewerId(
    spreadsheetId: string,
    reviewerId: string
): Promise<{ decision: Decision; rowIndex: number }[]> {
    const allDecisions = await getDecisions(spreadsheetId);
    return allDecisions.filter(({ decision }) => decision.reviewer_id === reviewerId);
}

/**
 * 複数のDecisionを一括更新（閾値確定用）
 */
export async function updateDecisionsBatch(
    spreadsheetId: string,
    updates: { rowIndex: number; decision: Decision }[]
): Promise<void> {
    // 効率的なバッチ更新のためにbatchUpdateを使用
    const token = await getAuthToken();

    const requests = updates.map(({ rowIndex, decision }) => ({
        range: `${DECISIONS_SHEET}!A${rowIndex}:K${rowIndex}`,
        values: [[
            decision.decision_id,
            decision.ref_id,
            decision.reviewer_id,
            decision.decision,
            decision.reason || '',
            '', // labels
            decision.note || '',
            decision.decided_at,
            decision.client_version || '',
            decision.source_url || '',
            decision.screening_phase || '',
        ]],
    }));

    const response = await fetch(
        `${SHEETS_API_BASE}/${spreadsheetId}/values:batchUpdate`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                valueInputOption: 'USER_ENTERED',
                data: requests,
            }),
        }
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to batch update decisions: ${error.error?.message || response.statusText}`);
    }
}

/**
 * LLM判定（pending状態）の文献を取得
 */
export async function getLlmPendingDecisions(
    spreadsheetId: string,
    executionId: string
): Promise<{ decision: Decision; rowIndex: number }[]> {
    const allDecisions = await getDecisions(spreadsheetId);
    return allDecisions.filter(({ decision }) =>
        decision.reviewer_id === executionId && decision.decision === 'pending'
    );
}




