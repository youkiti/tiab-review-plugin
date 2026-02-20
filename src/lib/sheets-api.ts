// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, LlmConfig, LlmCriteria, LlmExecution } from './types';
import { t } from './i18n';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// シート名定数
const REFERENCES_SHEET = 'References';
const DECISIONS_SHEET = 'Decisions';
const CONFIG_SHEET = 'Config';
const LLM_EXECUTIONS_SHEET = 'LLM_Executions';

// LLM_Executionsシートのヘッダー
const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',  // Model parameters
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active'
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

// References タブのヘッダー
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file'
];


// Decisions タブのヘッダー
// 互換性のため labels 列は残すが、機能としては使用しない
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
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:R`);

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
    ]);

    await appendRows(spreadsheetId, REFERENCES_SHEET, rows);
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

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    // 自分の判定をマップ化
    const myDecisions = new Map<string, Decision>();
    decisionsData.forEach(({ decision }) => {
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
        return {
            ...ref,
            myDecision,
            status,
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

    const [references, decisionsData, llmExecutions] = await Promise.all([
        getReferences(spreadsheetId),
        getDecisions(spreadsheetId),
        getLlmExecutions(spreadsheetId),
    ]);

    console.log('[getReferencesWithAllDecisions] References:', references.length, 'Decisions:', decisionsData.length);

    const normalizedReviewerEmail = (reviewerEmail || '').trim();
    references.forEach((ref) => {
        const refId = (ref.ref_id || '').trim();
        if (refId && refId !== ref.ref_id) {
            ref.ref_id = refId;
        }
    });

    // デバッグ: ref_idのサンプルを表示
    if (decisionsData.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample decision ref_ids:', decisionsData.slice(0, 3).map(d => d.decision.ref_id));
    }
    if (references.length > 0) {
        console.log('[getReferencesWithAllDecisions] Sample reference ref_ids:', references.slice(0, 3).map(r => r.ref_id));
    }

    // 有効なLLM実行IDのセットを作成
    const validLlmExecutionIds = new Set(
        llmExecutions
            .filter(e => e.status === 'confirmed' && e.is_active)
            .map(e => e.execution_id)
    );

    console.log('[getReferencesWithAllDecisions] llmExecutions:', llmExecutions.map(e => ({
        id: e.execution_id,
        status: e.status,
        is_active: e.is_active
    })));
    console.log('[getReferencesWithAllDecisions] validLlmExecutionIds:', Array.from(validLlmExecutionIds));

    // 全判定をref_id別にグループ化（有効なLLM判定のみを含める）
    const allDecisionsMap = new Map<string, Decision[]>();
    let skippedLlm = 0;
    let addedDecisions = 0;
    let addedHuman = 0;
    let addedLlm = 0;
    decisionsData.forEach(({ decision }) => {
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
        '', // labels: 機能廃止のため常に空文字を保存
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

/**
 * ハイライトキーワードの型
 */
export interface HighlightKeywords {
    include: string[];
    exclude: string[];
}

/**
 * Config タブからハイライトキーワードを取得
 * Config タブは Key-Value 形式（A列=キー、B列=値）を想定
 * 見つからない場合はデフォルト値を返す
 */
export async function getHighlightKeywords(spreadsheetId: string): Promise<HighlightKeywords> {
    let includeKeywords = DEFAULT_INCLUDE_KEYWORDS;
    let excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS;

    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);

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
        }
    } catch (error) {
        console.log('[getHighlightKeywords] Config not found, using defaults:', error);
    }

    return {
        include: includeKeywords,
        exclude: excludeKeywords,
    };
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

// ========== LLM関連の関数 ==========

/**
 * デフォルトのLLM設定
 */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
    llm_enabled: false,
    llm_model: 'gemini-3-flash-preview',
    llm_temperature: 1.0,
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
                    config.llm_model = value;
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
 */
export async function ensureLlmExecutionsSheet(spreadsheetId: string): Promise<void> {
    try {
        await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A1:A1`);
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
 * LLM実行履歴を保存
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
    ];

    await appendRows(spreadsheetId, LLM_EXECUTIONS_SHEET, [row]);
}

/**
 * LLM実行履歴を取得
 */
export async function getLlmExecutions(spreadsheetId: string): Promise<LlmExecution[]> {
    try {
        await ensureLlmExecutionsSheet(spreadsheetId);
        const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:O`);

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
    const values = await getSheetValues(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A:O`);

    console.log('[updateLlmExecution] Sheet rows count:', values.length);

    if (values.length <= 1) {
        throw new Error('Execution not found');
    }

    // execution_idで行を検索
    let rowIndex = -1;
    console.log('[updateLlmExecution] Searching for executionId in column A...');
    for (let i = 1; i < values.length; i++) {
        console.log(`[updateLlmExecution] Row ${i + 1} execution_id:`, values[i][0]);
        if (values[i][0] === executionId) {
            rowIndex = i + 1; // 1-indexed
            break;
        }
    }

    console.log('[updateLlmExecution] Found rowIndex:', rowIndex);

    if (rowIndex === -1) {
        throw new Error(`Execution not found: ${executionId}`);
    }

    const currentRow = values[rowIndex - 1];
    const headers = values[0];

    console.log('[updateLlmExecution] Headers:', headers);
    console.log('[updateLlmExecution] Current row:', currentRow);

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

    console.log('[updateLlmExecution] New row:', newRow);

    await updateRange(spreadsheetId, `${LLM_EXECUTIONS_SHEET}!A${rowIndex}:O${rowIndex}`, [newRow]);
    console.log('[updateLlmExecution] Update completed');
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
        range: `${DECISIONS_SHEET}!A${rowIndex}:J${rowIndex}`,
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
