// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, LlmConfig, LlmCriteria, LlmExecution, LlmRun, AssignmentConfig } from './types';
import { t } from './i18n';
import { computeConfigHash, isHashable, legacyHash } from './llm-config-hash';

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
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set'
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
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:S`);

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
        ref.screening_set || '',
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
    // Blind ONでもAI Evidenceハイライトに必要なLLM判定だけ保持する
    const llmDecisionsMap = new Map<string, Decision[]>();
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

    // 有効な LLM 判定 = active Run 配下の Batch IDs に含まれる reviewer_id のもの
    // Run/Batch 分離後、active 状態は LLM_Runs.is_active が正となる
    const activeBatchIds = await getActiveBatchIdsForActiveRun(spreadsheetId, llmExecutions);
    const validLlmExecutionIds = activeBatchIds;

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
    llm_model: 'gemini-flash-latest',
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




