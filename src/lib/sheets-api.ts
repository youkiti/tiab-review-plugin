// Google Sheets API ラッパー

import type { Reference, Decision, ReferenceWithStatus, DecisionStatus, FulltextStatus, LlmConfig, LlmCriteria, LlmExecution, LlmRun, AssignmentConfig, ImportStatsMap } from './types';
import { MODEL_ID_MIGRATIONS } from './model-migrations';
import { t } from './i18n';
import { platform } from '../platform';
import { computeConfigHash, isHashable, legacyHash } from './llm-config-hash';
import { pickRunByConfigHash, pickLegacyRunByConfigHash, collectJudgedRefIds } from './llm-batch-target';
import { parseLlmTargetMode, parseTargetRefIds, serializeTargetRefIds } from './llm-target-selection';
import { parseFulltextPoolRule } from './fulltext-pool';
import type { FulltextPoolRule } from './fulltext-pool';
import { parseReviewCriteria, serializeReviewCriteria } from './review-criteria';
import type { ReviewCriteria } from './review-criteria';
import { parseExcludeReasonConfig, serializeExcludeReasonConfig } from './exclude-reason-config';
import type { ExcludeReasonConfig } from './exclude-reason-config';
import { DEFAULT_FULLTEXT_ASSIGNMENT, normalizeFulltextReviewerMap } from './fulltext-assignment';
import { driveFetch } from './drive-shared-drive';
import type { FulltextAssignmentConfig } from './fulltext-assignment';
import { isHumanDecision, isConfirmedMlDecision } from './client-version';
import { buildFulltextUrlUpdateData, validateFulltextDriveHeaders } from './fulltext-drive-write';
import type { FulltextUrlUpdateEntry } from './fulltext-drive-write';
import { AUDIT_LOG_HEADERS, buildAuditEventRow } from './audit-log';
import type { AuditLogEvent } from './audit-log';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';


export class SheetsAccessDeniedError extends Error {
    constructor(
        public readonly spreadsheetId: string,
        public readonly status: number,
        message = 'Spreadsheet access is not granted or the spreadsheet was not found'
    ) {
        super(message);
        this.name = 'SheetsAccessDeniedError';
    }
}

export function isSheetsAccessDeniedStatus(status: number): boolean {
    return status === 403 || status === 404;
}

/**
 * エラーが Sheets/Google API のクォータ超過によるものかを判定する。
 * 429 レスポンスのメッセージには "Quota exceeded for quota metric ..." が、
 * gRPC系のエラーには "RESOURCE_EXHAUSTED" が含まれるため、どちらかを含むかで判定する。
 * UI 側で「アクセスが集中しています」という専用メッセージに差し替える際に使う。
 */
export function isQuotaExceededError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Quota exceeded') || message.includes('RESOURCE_EXHAUSTED');
}

async function readSheetsErrorMessage(response: Response): Promise<string> {
    try {
        const error = await response.json();
        return error.error?.message || response.statusText;
    } catch {
        return response.statusText;
    }
}


// シート名定数
const REFERENCES_SHEET = 'References';
const DECISIONS_SHEET = 'Decisions';
const CONFIG_SHEET = 'Config';
const LLM_EXECUTIONS_SHEET = 'LLM_Executions';
const LLM_RUNS_SHEET = 'LLM_Runs';
const AUDIT_LOG_SHEET = 'Audit_Log';

// LLM_Executionsシートのヘッダー
// run_id は Run/Batch 分離後に追加された列。既存シートに無い場合は ensureLlmExecutionsSheet で末尾に追加される。
//
// 【重要】新しい列は必ず末尾に追加すること。saveLlmExecution() は row 配列を位置ベースで
// 組み立てており、既存シートのヘッダは「元の並び + ensureLlmExecutionsSheet が末尾へ追記した
// 不足列」という形にしかならない。途中挿入すると既存プロジェクトのシートで列がずれる。
const LLM_EXECUTIONS_HEADERS = [
    'execution_id', 'execution_type', 'timestamp', 'model',
    'temperature', 'topP', 'thinkingLevel',  // Model parameters
    'criteria_snapshot', 'screening_prompt', 'include_threshold',
    'target_count', 'include_count', 'exclude_count',
    'status', 'is_active', 'run_id',
    'requested_model', 'model_version', 'response_id',
    'target_mode', 'target_sets', 'target_selected_count',
    // フルテキストAI一括判定の実行履歴用（Issue #62）。ここより前には絶対に挿入しないこと。
    'executed_by', 'maybe_count', 'failed_count', 'failure_breakdown',
    // フルテキストAI判定時点の除外理由リストのスナップショット（PR #110）。末尾に追加。
    'exclude_reasons_snapshot'
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
// 【重要】新しい列は必ず末尾に追加すること。途中挿入すると既存プロジェクトのシートで列がずれる。
// fulltext_drive_source_id（W列）/ fulltext_drive_copy_id（X列）は Issue #73 Phase 2 で追加した、
// Drive直接取り込みの冪等性判定用の列（詳細は updateReferenceFulltextUrls の JSDoc を参照）。
const REFERENCES_HEADERS = [
    'ref_id', 'title', 'abstract', 'year', 'authors',
    'journal', 'volume', 'issue', 'pages', 'issn',
    'doi', 'pmid', 'url', 'source',
    'imported_at', 'imported_by', 'dedupe_key', 'source_file', 'screening_set',
    'fulltext_url', 'fulltext_status', 'fulltext_set',
    'fulltext_drive_source_id', 'fulltext_drive_copy_id'
];


// Decisions タブのヘッダー
// 互換性のため labels 列は残すが、機能としては使用しない
// screening_phase: 'tiab' | 'fulltext' (省略時は 'tiab' 扱い)
// context_json: 判定時点のAI暴露状況を記録するJSON（DecisionContextV1）。書くだけの列で
// 読み取り側の挙動は変えない（AGENTS.md「Decisions タブ」参照）。新しい列は必ず末尾に追加すること
// （LLM_EXECUTIONS_HEADERS と同じ理由。saveDecisionInner 等が row 配列を位置ベースで組み立てるため）。
const DECISIONS_HEADERS = [
    'decision_id', 'ref_id', 'reviewer_id', 'decision', 'reason',
    'labels', 'note', 'decided_at', 'client_version', 'source_url', 'screening_phase',
    'context_json'
];

/**
 * 1始まりの列番号を A1 形式の列名（A, B, ..., Z, AA, ...）に変換する。
 * ヘッダー配列の長さから終端列を導出するために使う。Decisions のように列が末尾追記で
 * 増えていくシートでは、`A1:K1` のように終端列をハードコードすると、列追加のたびに
 * 直し忘れた箇所だけ新しい列が反映されない事故が起きる（実際に踏んだ落とし穴）ため、
 * 必ずこのヘルパーでヘッダー数から導出すること。
 */
function columnLetter(index: number): string {
    let n = index;
    let letters = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        letters = String.fromCharCode(65 + rem) + letters;
        n = Math.floor((n - 1) / 26);
    }
    return letters;
}

// Decisions タブの終端列（A1形式）。DECISIONS_HEADERS の長さから動的に導出する。
// 以前は 'K'（11列時代）をシート操作の各所に直書きしていたが、context_json 追加で
// 12列目（L列）になったため、以後は列数変更に自動追従するこの定数を使うこと。
const DECISIONS_LAST_COLUMN = columnLetter(DECISIONS_HEADERS.length);

/**
 * OAuth トークンを取得。
 * interactive=true のときのみユーザー操作起点の認可（Web版はポップアップ）を許可する。
 * ログインボタン等の操作起点からの呼び出しでのみ true を渡すこと。
 */
export async function getAuthToken(interactive = false): Promise<string> {
    return platform().getAuthToken(interactive);
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
    return platform().forceReauth();
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
            // W/X列（fulltext_drive_source_id/fulltext_drive_copy_id）をユーザーが既に
            // 独自ヘッダー名で使っていないか、上書きする前に検証する。
            // getSheetValues は末尾の空セルを省いて返す仕様のため、currentHeaders.length >= 23
            // は「W1が非空」であることと同値。23列だけ足した最もありがちな構成では
            // この検証をしないと W1 のユーザー独自名を fulltext_drive_source_id に無警告で
            // 改名してしまい、直後の書き込みで W 列のデータごと上書きしてしまう（実測で再現済み）。
            const driveHeaderCheck = validateFulltextDriveHeaders(currentHeaders);
            if (!driveHeaderCheck.ok) {
                console.warn(
                    '[ensureHeaders] Skipping References header expansion: W/X columns conflict with user-defined headers',
                    { actualW: driveHeaderCheck.actualW, actualX: driveHeaderCheck.actualX }
                );
            } else {
                console.log('[ensureHeaders] Updating headers...', { current: currentHeaders.length, expected: REFERENCES_HEADERS.length });

                // 既存のヘッダーが期待されるヘッダーのプレフィックスと一致するか確認（念のため）
                // A〜V列は一致しなくても、このアプリで管理する以上は更新して良いとする。
                // W/X列（fulltext_drive_source_id/fulltext_drive_copy_id）だけは例外で、
                // 一致しない場合はこの else に入らず（上の driveHeaderCheck.ok により）更新しない

                // 行1全体を更新
                await updateRange(spreadsheetId, `${REFERENCES_SHEET}!A1:Z1`, [REFERENCES_HEADERS]);
                console.log('[ensureHeaders] Headers updated');
            }
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
            await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A1:${DECISIONS_LAST_COLUMN}1`, [DECISIONS_HEADERS]);
            console.log('[ensureHeaders] Decisions headers updated');
        }
    } catch (error) {
        console.error('[ensureHeaders] Decisions error:', error);
        // エラーはログ出力のみで、処理は続行させる（接続をブロックしない）
    }
}

/** ensureFulltextDriveColumnsOnce() の判定結果。usable=false のとき actualW/actualX に実際のヘッダー名が入る */
interface FulltextDriveColumnsStatus {
    usable: boolean;
    actualW: string;
    actualX: string;
}

// spreadsheetId → ensureFulltextDriveColumnsOnce() の実行結果 Promise。
// セッション内で同一スプレッドシートへの2回目以降の書き込みが Sheets を読み直さないための memo。
const fulltextDriveColumnsReadyBySpreadsheetId = new Map<string, Promise<FulltextDriveColumnsStatus>>();

/**
 * References!W/X（fulltext_drive_source_id/fulltext_drive_copy_id）が書き込み可能かどうかを、
 * 書き込み前に一度だけ判定する。
 *
 * 1. ensureHeaders() で列不足（旧22列シート等）を24列へ拡張する
 * 2. 拡張後もW/Xのヘッダーが期待名と一致しない場合（ユーザーが独自の23列目以降を追加していた等）は
 *    usable=false を返す。呼び出し側（updateReferenceFulltextUrls）はこれを見て、
 *    Drive直接取り込み（driveSource が非null）を伴う場合のみ fail-fast でエラーにし、
 *    それ以外（OA検索・手動アップロード等、driveSource=null）は W/X を書かずに T:U だけ書く
 *    （この関数自体は throw しない。書き込み可否の判定だけに専念する）。
 *
 * fulltext ページ（src/fulltext/fulltext.ts）はサイドパネル接続時の ensureHeaders() を経由しないため、
 * この関数がW/X列を保証する唯一の経路になる。書き込みのたびに Sheets を読み直さないよう
 * spreadsheetId 単位でメモ化するが、**メモ化するのは usable=true（正常）の結果だけ**。
 * usable=false（ユーザー独自列と衝突）をキャッシュしてしまうと、エラーメッセージの指示どおり
 * ユーザーがシートの列名を直しても、拡張機能を再読み込みするまで反映されない。衝突している
 * 間は呼び出しのたびに ensureHeaders() + ヘッダー読み取りが走ることになるが、稀なケースなので
 * 許容する。読み取り自体が失敗した場合も同様にメモを残さず、次回呼び出しで再試行できるようにする。
 */
function ensureFulltextDriveColumnsOnce(spreadsheetId: string): Promise<FulltextDriveColumnsStatus> {
    const cached = fulltextDriveColumnsReadyBySpreadsheetId.get(spreadsheetId);
    if (cached) return cached;

    const promise = (async (): Promise<FulltextDriveColumnsStatus> => {
        await ensureHeaders(spreadsheetId);
        const headerValues = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A1:X1`);
        const check = validateFulltextDriveHeaders(headerValues[0] ?? []);
        return { usable: check.ok, actualW: check.actualW, actualX: check.actualX };
    })().then((result) => {
        if (!result.usable) {
            // 衝突が解消されたかもしれないため、次回呼び出しで再判定できるようキャッシュに残さない
            fulltextDriveColumnsReadyBySpreadsheetId.delete(spreadsheetId);
        }
        return result;
    }).catch((error) => {
        fulltextDriveColumnsReadyBySpreadsheetId.delete(spreadsheetId);
        throw error;
    });

    fulltextDriveColumnsReadyBySpreadsheetId.set(spreadsheetId, promise);
    return promise;
}

/** テスト用: ensureFulltextDriveColumnsOnce() のメモ化キャッシュを破棄する */
export function invalidateFulltextDriveColumnsMemo(): void {
    fulltextDriveColumnsReadyBySpreadsheetId.clear();
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
        const message = await readSheetsErrorMessage(response);
        if (isSheetsAccessDeniedStatus(response.status)) {
            throw new SheetsAccessDeniedError(spreadsheetId, response.status, message);
        }
        throw new Error(`Failed to get spreadsheet info: ${message}`);
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
        const message = await readSheetsErrorMessage(response);
        if (isSheetsAccessDeniedStatus(response.status)) {
            throw new SheetsAccessDeniedError(spreadsheetId, response.status, message);
        }
        throw new Error(`Failed to get sheet values: ${message}`);
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
        const message = await readSheetsErrorMessage(response);
        if (isSheetsAccessDeniedStatus(response.status)) {
            throw new SheetsAccessDeniedError(spreadsheetId, response.status, message);
        }
        throw new Error(`Failed to batch get sheet values: ${message}`);
    }

    const data = await response.json();
    const valueRanges = (data.valueRanges ?? []) as { values?: string[][] }[];
    return ranges.map((_, i) => valueRanges[i]?.values ?? []);
}

/**
 * values:append レスポンスの updates.updatedRange（例: `Decisions!A123:K123`、
 * シート名に空白を含む場合は `'My Sheet'!A123:K123`）から先頭行番号を取り出す。
 * シート名部分にも `!` が含まれ得るため、範囲の区切りは「最後の `!`」を基準にする。
 * パースに失敗した場合は null を返す（呼び出し側はキャッシュを無効化すること）。
 */
function parseFirstRowIndexFromUpdatedRange(updatedRange: string | undefined): number | null {
    if (!updatedRange) return null;
    const bangIndex = updatedRange.lastIndexOf('!');
    if (bangIndex === -1) return null;
    const rangePart = updatedRange.slice(bangIndex + 1);
    const match = rangePart.match(/^[A-Za-z]+(\d+)/);
    if (!match) return null;
    const rowIndex = parseInt(match[1], 10);
    return Number.isFinite(rowIndex) ? rowIndex : null;
}

/**
 * シートに行を追加
 * 戻り値の firstRowIndex は追記した最初の行のシート行番号（1始まり）。
 * Decisions への保存で「読み取りなしで新規行の行番号をキャッシュへ登録する」ために使う。
 * 既存の呼び出し元の大半は戻り値を使わない（await するだけ）ため、そのまま動作する。
 */
async function appendRows(
    spreadsheetId: string,
    sheetName: string,
    rows: (string | number | undefined)[][]
): Promise<{ firstRowIndex: number | null }> {
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

    const data = await response.json().catch(() => null);
    const firstRowIndex = parseFirstRowIndexFromUpdatedRange(data?.updates?.updatedRange);
    return { firstRowIndex };
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
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:X`);
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
 * 文献の fulltext_url / fulltext_status と、Drive直接取り込みの冪等性の真値
 * （fulltext_drive_source_id / fulltext_drive_copy_id）を更新する（OA URL 解決後・
 * Drive直接取り込み後に呼び出す）。
 *
 * REFERENCES_HEADERS での列位置:
 *   fulltext_url             = 20列目 (T列, 0-indexed: 19)
 *   fulltext_status          = 21列目 (U列, 0-indexed: 20)
 *   fulltext_set             = 22列目 (V列, 0-indexed: 21) ※ここでは触れない
 *   fulltext_drive_source_id = 23列目 (W列, 0-indexed: 22)
 *   fulltext_drive_copy_id   = 24列目 (X列, 0-indexed: 23)
 *
 * driveSource は Driveへ直接置かれたPDFの取り込み（fulltext-drive-import.ts）でのみ値を持つ。
 * それ以外の経路は必ず null を渡し、W/X 列を空文字でクリアする（省略ではなくクリア。
 * 詳細は FulltextUrlUpdateEntry の JSDoc を参照）。
 */
export async function updateReferenceFulltextUrl(
    spreadsheetId: string,
    refId: string,
    fulltextUrl: string,
    status: FulltextStatus,
    driveSource: FulltextUrlUpdateEntry['driveSource']
): Promise<void> {
    await updateReferenceFulltextUrls(spreadsheetId, [{ refId, fulltextUrl, status, driveSource }]);
}

/**
 * 複数文献の fulltext_url / fulltext_status / fulltext_drive_source_id / fulltext_drive_copy_id を
 * まとめて更新する（一括OA検索・Drive直接取り込み等で使用）。
 * ref_id 列の読み取り1回 + values:batchUpdate 1回（T:U と、可能な場合は W:X の2つの非連続レンジ×件数）
 * で済ませ、APIクォータを節約する。V列（fulltext_set）は触れない。
 *
 * W/X 列が書き込み可能かどうかは ensureFulltextDriveColumnsOnce() で判定する
 * （fulltext ページは ensureHeaders() を経由しないため、ここが唯一の保証経路になる）。
 * ヘッダーがユーザー独自の別用途と衝突している場合（usable=false）の扱いは2通り:
 *   - 今回の updates に driveSource が非null のエントリ（Drive直接取り込み）が1件でもあれば、
 *     クレームを記録できず機能が成立しないため fail-fast でエラーを投げ、何も書き込まない
 *   - driveSource が全件 null（OA検索・手動アップロード等）なら、T:U だけを書き W:X はスキップする。
 *     ヘッダー不一致時の W/X は「我々のクレームが元から存在しない」状態なので、書かないことが
 *     安全側（クリアし忘れによる誤判定は起こり得ず、逆に空文字を書くとユーザーの独自データを破壊する）
 */
export async function updateReferenceFulltextUrls(
    spreadsheetId: string,
    updates: FulltextUrlUpdateEntry[]
): Promise<void> {
    if (updates.length === 0) return;

    const columnsStatus = await ensureFulltextDriveColumnsOnce(spreadsheetId);
    let includeDriveColumns = columnsStatus.usable;
    if (!columnsStatus.usable) {
        if (updates.some(u => u.driveSource !== null)) {
            throw new Error(t('fulltext_driveColumnsConflict', [columnsStatus.actualW, columnsStatus.actualX]));
        }
        console.warn(
            '[updateReferenceFulltextUrls] References の W/X 列がユーザー独自列と衝突しているため、' +
            'Drive取り込み列（fulltext_drive_source_id/fulltext_drive_copy_id）の更新をスキップしました:',
            { actualW: columnsStatus.actualW, actualX: columnsStatus.actualX }
        );
        includeDriveColumns = false;
    }

    // ref_id 列 (A列) で行番号を特定
    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:A`);
    const rowByRefId = new Map<string, number>();
    values.forEach((row, i) => {
        if (i > 0 && row[0]) rowByRefId.set(row[0], i + 1); // 1-indexed (ヘッダー行=1)
    });

    const data = buildFulltextUrlUpdateData(updates, rowByRefId, REFERENCES_SHEET, includeDriveColumns);
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

/** 対象文献のフルテキスト状態（Drive直接取り込みの取り込み元/コピーIDを含む） */
export interface ReferenceFulltextRowState {
    status: FulltextStatus;
    url: string;
    sourceFileId: string;
    copyFileId: string;
}

/** ある source PDF（fulltext_drive_source_id）を取り込み元として持つ、1文献分のクレーム */
export interface FulltextSourceClaim {
    refId: string;
    copyId: string;
    status: FulltextStatus;
    url: string;
}

/**
 * source ID・ref_id の両方から引ける、全行分のフルテキスト取り込みスナップショット。
 * classifyDriveImportState（drive-import-classify.ts）の入力に使う。
 */
export interface FulltextClaimsSnapshot {
    /**
     * source ID（fulltext_drive_source_id）→ その source を取り込み元とする全文献のクレーム配列。
     * W列（fulltext_drive_source_id）が空の行は含まれない（クレームが無い行のため）。
     *
     * 1対1マップにせず配列で持つ理由は、**無効なクレームに紛れた有効なクレームを取りこぼさない
     * ため**である（同一sourceを指す行が複数あるとき、片方が旧版クライアントのT:U単独書き込みで
     * 失効していることがある。`isFulltextClaimValid` を通して有効な1件を選ぶ必要がある）。
     * 実行フェーズの `resolveImportAction` が別文献への `copy-and-update` を許容している以上、
     * 同一sourceの重複行はデータとして成立しうる。
     * ただし**表示フェーズは「有効なクレームが1件でもあれば取り込み済み」**として扱い、
     * 2件目の文献への対応付けは行わない（`drive-import-classify.ts` の冒頭コメント参照）。
     */
    bySourceId: Map<string, FulltextSourceClaim[]>;
    /**
     * ref_id → その行の現在のフルテキスト状態。W/X列の有無に関わらず**全行**を含む
     * （bySourceId と違い、W列が空の行も含む）。「Driveコピーは見えているがクレームが
     * 無い（＝本Issue修正前に取り込まれた既存ファイル）」行の現在URLを引くために必要。
     */
    byRefId: Map<string, ReferenceFulltextRowState>;
}

/**
 * getReferenceFulltextState / getFulltextClaimsSnapshot の共通実装。
 * References!A:A（ref_id列）と References!T:X（fulltext_url/status/set/source_id/copy_id）を
 * values:batchGet で1リクエストにまとめて読み、全行を横断した状態を組み立てる。
 * V列（fulltext_set）は読み込むが無視する（フルテキスト担当割り振りはここでは扱わない）。
 * 巨大な abstract 列等を含む References!A:X 全体を毎回読むより軽量。
 *
 * targetRefId を渡した場合のみ、その ref_id の行状態（target）もあわせて拾う
 * （target は byRefId.get(targetRefId) と同じ値になるが、既存の戻り値契約
 * （行が見つからなければ undefined）を壊さないための専用フィールドとして残す）。
 * byRefId は常に全行ぶん構築する（行スキャン自体は既に全行を回っているため、
 * マップを1つ増やすだけで追加のAPI呼び出しは発生しない。ロジックの二重実装を避けるため、
 * 行スキャンはこの1関数に集約する）。
 *
 * buildBySourceId=false（既定 true）を渡すと、「source ID → クレーム配列」の逆引きマップ
 * （bySourceId）を組み立てない。getReferenceFulltextState は target（対象1行の状態）しか
 * 使わないため、呼ばれるたびに全行分の bySourceId を組み立てては捨てていた無駄を避ける。
 */
async function scanFulltextRows(
    spreadsheetId: string,
    targetRefId?: string,
    buildBySourceId: boolean = true
): Promise<{
    target: ReferenceFulltextRowState | undefined;
    bySourceId: Map<string, FulltextSourceClaim[]>;
    byRefId: Map<string, ReferenceFulltextRowState>;
}> {
    const [idColumn, twxValues] = await getSheetValuesBatch(spreadsheetId, [
        `${REFERENCES_SHEET}!A:A`,
        `${REFERENCES_SHEET}!T:X`,
    ]);

    let target: ReferenceFulltextRowState | undefined;
    const bySourceId = new Map<string, FulltextSourceClaim[]>();
    const byRefId = new Map<string, ReferenceFulltextRowState>();

    for (let i = 1; i < idColumn.length; i++) {
        const rowRefId = idColumn[i][0];
        if (!rowRefId) continue;

        // Sheets は末尾の空セルを省いて返すため、A列より短い場合がある
        const row = twxValues[i] ?? [];
        const url = row[0] || '';
        const status = (row[1] || 'not_retrieved') as FulltextStatus;
        // row[2] = fulltext_set（V列）は無視する
        const sourceFileId = row[3] || '';
        const copyFileId = row[4] || '';
        const rowState: ReferenceFulltextRowState = { status, url, sourceFileId, copyFileId };

        byRefId.set(rowRefId, rowState);
        if (targetRefId !== undefined && rowRefId === targetRefId) {
            target = rowState;
        }
        if (buildBySourceId && sourceFileId) {
            const claims = bySourceId.get(sourceFileId) ?? [];
            claims.push({ refId: rowRefId, copyId: copyFileId, status, url });
            bySourceId.set(sourceFileId, claims);
        }
    }

    return { target, bySourceId, byRefId };
}

/**
 * 対象文献の fulltext_status / fulltext_url / Drive取り込み元・コピーIDを最新値で読み直す。
 * Driveへ直接置かれたPDFの取り込み実行時、files.copy 成功後・シート書き込み前に
 * 「他のユーザーが自分より先に同じ文献へ取り込み済みでないか」を確認するために使う
 * （楽観ロック相当。競合していれば呼び出し側は上書きせずコピーをゴミ箱へ戻す。
 * URLまで返すのは、cached済みのURLが自分がこれから書こうとしているコピーと同一かどうか
 * ＝「応答喪失後の再試行」かどうかを呼び出し側で判定するために必要なため）。
 *
 * 対象行が見つからない場合は undefined を返す（呼び出し側はエラー扱いにすること。従来の
 * 戻り値契約を維持）。全行を横断した逆引きマップ（bySourceId/byRefId）が必要な場合は
 * getFulltextClaimsSnapshot を使うこと（唯一の呼び出し側 fulltext-drive-import.ts は
 * 対象1行の状態しか使わないため、ここでは組み立てない）。
 */
export async function getReferenceFulltextState(
    spreadsheetId: string,
    refId: string
): Promise<ReferenceFulltextRowState | undefined> {
    const { target } = await scanFulltextRows(spreadsheetId, refId, false);
    return target;
}

/**
 * 「source ID → 取り込みクレーム配列」と「ref_id → 行状態」の両方の逆引きマップを取得する。
 * Driveへ直接置かれたPDFの取り込みで、Picker選択直後（実行前の表示フェーズ）に
 * クレームマップを鮮度よく取り直すために使う（fulltext-drive-import.ts）。
 * ファイルごとに取り直すとN+1になるため、選択確定後に1回だけ呼ぶこと。
 * getReferenceFulltextState と行スキャンのロジックは共通化しており（scanFulltextRows）、
 * 二重実装にはなっていない。
 *
 * byRefId は classifyDriveImportState の判定順2（Driveコピーのみ見えている場合の
 * フォールバック）で使う。bySourceId だけでは W/X が空の行（本Issue修正前に取り込まれた
 * 既存ファイル）の現在状態を引けず、「実は取り込み済みなのに未完了と誤表示される」退行に
 * なるため、byRefId（全行対象）を別途用意している。
 */
export async function getFulltextClaimsSnapshot(spreadsheetId: string): Promise<FulltextClaimsSnapshot> {
    const { bySourceId, byRefId } = await scanFulltextRows(spreadsheetId);
    return { bySourceId, byRefId };
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
 * Decisions タブから生の全行を取得する（畳み込みなし）。
 * 追記専用化（human / ML手動確認の判定は append のみ）により同一キーの行が複数残るため、
 * 判定イベントの履歴そのものが必要な箇所（deleteFulltextAiRound など）だけがこれを使うこと。
 * 通常の読み取りは getDecisions() の畳み込み結果を使う。外部へは export しない。
 */
async function getDecisionsRaw(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const values = await getSheetValues(spreadsheetId, `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`);
    return parseDecisionValues(values);
}

/**
 * Decisions タブから判定一覧を取得。
 * 追記専用化により同一 (ref_id, reviewer_id, screening_phase) の行が複数存在しうるため、
 * ここで各キーの最新1行へ畳み込んでから返す（下流のUI・集計は従来どおり最新判定のみを見る）。
 */
export async function getDecisions(spreadsheetId: string): Promise<{ decision: Decision; rowIndex: number }[]> {
    const rawData = await getDecisionsRaw(spreadsheetId);
    const decisionsData = collapseToLatestDecisions(rawData);
    // 全件読み取ったタイミングで行番号キャッシュ・保存内容スナップショットを温める（saveDecision の読み取り/重複防止用）
    primeDecisionRowCache(spreadsheetId, decisionsData);
    return decisionsData;
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
            llmBatchIds: llmDecisions.map(d => d.reviewer_id),
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
    // バッチ対象を Run 単位で決めるため、status/active を問わず
    // 「どの LLM バッチがこの文献を判定したか」を別途記録する
    const llmBatchIdsByRefId = new Map<string, string[]>();
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
            const ids = llmBatchIdsByRefId.get(decision.ref_id) ?? [];
            ids.push(decision.reviewer_id);
            llmBatchIdsByRefId.set(decision.ref_id, ids);
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
            llmBatchIds: llmBatchIdsByRefId.get(ref.ref_id) ?? [],
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

// ---------------------------------------------------------------------------
// Decisions 行番号キャッシュ（判定保存のクォータ削減用）
//
// saveDecision() が判定1件ごとに Decisions!A:K を全件読み取ると、読み取りクォータ
// （60回/分/ユーザー）を連打時に即座に超過してしまう。getDecisions() 等で読んだ内容から
// 「key(ref_id+reviewer_id+phase) -> シート行番号」のキャッシュを作っておき、
// saveDecision() では原則キャッシュだけで既存行の有無を判定する（読み取り0回で保存する）。
// ---------------------------------------------------------------------------

/**
 * キャッシュの有効期限。他ユーザーがDecisionsの行を削除した場合、行番号がずれて
 * 古いキャッシュのまま上書きすると他人の判定を破壊しかねない。その巻き添えの窓を
 * このTTLの範囲に限定するための安全弁であり、省略してはならない。
 */
const DECISION_ROW_CACHE_TTL_MS = 60_000;

let decisionRowCache: {
    spreadsheetId: string;
    builtAt: number;
    rows: Map<string, number>; // key -> シート行番号（1始まり）
} | null = null;

/**
 * 追記対象（human / ML手動確認）の判定保存内容。同一内容の連続保存をスキップする判定に使う。
 * context_json は意図的に含めない: AIハイライト表示やキー開閉状態などUI状態が変わっただけで
 * decision/reason/note が同一の再保存まで「別内容」と判定してしまうと、UI操作のたびに
 * 同一判定が別行として積まれてしまう（追記専用化の重複防止という目的に反する）。
 */
interface DecisionContentSnapshot {
    decision: string;
    reason: string;
    note: string;
}

/**
 * decisionRowCache と同じライフサイクル（同一 spreadsheetId スコープ + TTL +
 * invalidateDecisionRowCache() での破棄）で保持する、直近保存内容のスナップショットキャッシュ。
 * decisionRowCache.rows は「absent = 全件読み取り済みでキーが存在しないことが確定」という
 * 意味を持つため、ここへ部分的な書き込みを混ぜると ML/LLM側の hit/absent/cold 判定を
 * 汚染しかねない。意味が異なるため別オブジェクトとして分離する。
 */
let decisionContentCache: {
    spreadsheetId: string;
    builtAt: number;
    latest: Map<string, DecisionContentSnapshot>; // key -> 直近保存内容
} | null = null;

/** Decision から比較用のスナップショットを作る（undefined と '' を同一視するため ?? '' で正規化） */
function contentSnapshotOf(decision: Decision): DecisionContentSnapshot {
    return {
        decision: decision.decision ?? '',
        reason: decision.reason ?? '',
        note: decision.note ?? '',
    };
}

function isSameDecisionContent(a: DecisionContentSnapshot, b: DecisionContentSnapshot): boolean {
    return a.decision === b.decision && a.reason === b.reason && a.note === b.note;
}

/** Decisions 行番号キャッシュのキーを組み立てる（ref_id/reviewer_id は trim、phase 省略時は 'tiab'） */
function decisionRowKey(refId: string, reviewerId: string, phase: string | undefined): string {
    return `${(refId || '').trim()}\u0000${(reviewerId || '').trim()}\u0000${phase ?? 'tiab'}`;
}

/**
 * a が b より新しい判定行かどうかを判定する。
 * decided_at はISO 8601文字列のため辞書順比較で時系列順になる。同値の場合はシート上で
 * 後にある行（rowIndex が大きい行）を新しいとみなす（同一 decided_at での追記順を優先）。
 */
function isNewerDecisionRow(
    a: { decision: Decision; rowIndex: number },
    b: { decision: Decision; rowIndex: number }
): boolean {
    const aTime = a.decision.decided_at || '';
    const bTime = b.decision.decided_at || '';
    if (aTime !== bTime) return aTime > bTime;
    return a.rowIndex > b.rowIndex;
}

/**
 * Decisions の生行を (ref_id, reviewer_id, screening_phase) ごとに最新1行へ畳み込む。
 * 追記専用化により同一キーの行が複数残るようになったため、UI・集計を含む下流の挙動を
 * 従来（最新判定のみが有効）どおりに保つには、読み取りの入口でここを通す必要がある。
 * 出力の並び順は入力の行順（rowIndex 昇順）を維持する。
 */
function collapseToLatestDecisions(
    rows: { decision: Decision; rowIndex: number }[]
): { decision: Decision; rowIndex: number }[] {
    const latestByKey = new Map<string, { decision: Decision; rowIndex: number }>();
    for (const row of rows) {
        const key = decisionRowKey(row.decision.ref_id, row.decision.reviewer_id, row.decision.screening_phase);
        const current = latestByKey.get(key);
        if (!current || isNewerDecisionRow(row, current)) {
            latestByKey.set(key, row);
        }
    }
    const winners = new Set(latestByKey.values());
    return rows.filter(row => winners.has(row));
}

/**
 * decisionRowCache の参照結果。
 * ヒット/ミスの2値にすると「キャッシュはあるが未知のキー＝新規行」と
 * 「キャッシュ自体が無効」を区別できず、初回判定のたびに読み取りが発生して
 * 効果が半減してしまう。必ず3値で返すこと。
 */
type DecisionRowLookup =
    | { state: 'cold' }                   // キャッシュ無効/期限切れ/別シート → 従来どおり読む
    | { state: 'hit'; rowIndex: number }  // 既存行あり → updateRange
    | { state: 'absent' };                // キャッシュは有効だがキー無し = 新規行 → 読まずに append

function getCachedDecisionRow(spreadsheetId: string, key: string): DecisionRowLookup {
    if (!decisionRowCache) return { state: 'cold' };
    if (decisionRowCache.spreadsheetId !== spreadsheetId) return { state: 'cold' };
    if (Date.now() - decisionRowCache.builtAt > DECISION_ROW_CACHE_TTL_MS) return { state: 'cold' };
    const rowIndex = decisionRowCache.rows.get(key);
    return rowIndex !== undefined ? { state: 'hit', rowIndex } : { state: 'absent' };
}

/**
 * getDecisions() / getFulltextPageData() など、Decisions を rowIndex 付きで全件取得した
 * 直後に必ず呼び、キャッシュを温める。呼び出し側は畳み込み後（各キーの最新1行）のデータを
 * 渡すこと。生データを渡すと古い rowIndex や内容がキャッシュに乗る危険がある。
 * 併せて、同キーの直近保存内容スナップショット（decisionContentCache）も同時に構築する。
 */
function primeDecisionRowCache(
    spreadsheetId: string,
    decisionsData: { decision: Decision; rowIndex: number }[]
): void {
    const rows = new Map<string, number>();
    const latestContent = new Map<string, DecisionContentSnapshot>();
    for (const { decision, rowIndex } of decisionsData) {
        const key = decisionRowKey(decision.ref_id, decision.reviewer_id, decision.screening_phase);
        if (!rows.has(key)) {
            rows.set(key, rowIndex);
        }
        latestContent.set(key, contentSnapshotOf(decision));
    }
    decisionRowCache = { spreadsheetId, builtAt: Date.now(), rows };
    decisionContentCache = { spreadsheetId, builtAt: Date.now(), latest: latestContent };
}

/**
 * 直近に把握している保存内容のスナップショットを返す。
 * キャッシュ無効/期限切れ/別シートの場合は null（＝把握していない）を返し、
 * 呼び出し側はスキップ判定をせず通常どおり保存する。
 */
function getCachedDecisionContent(spreadsheetId: string, key: string): DecisionContentSnapshot | null {
    if (!decisionContentCache) return null;
    if (decisionContentCache.spreadsheetId !== spreadsheetId) return null;
    if (Date.now() - decisionContentCache.builtAt > DECISION_ROW_CACHE_TTL_MS) return null;
    return decisionContentCache.latest.get(key) ?? null;
}

/**
 * 追記（append）に成功した判定の内容をスナップショットへ記録する。
 * キャッシュが未構築/別シートの場合はここで新規に作る（次回以降のスキップ判定に使うため）。
 */
function rememberDecisionContent(spreadsheetId: string, key: string, decision: Decision): void {
    if (!decisionContentCache || decisionContentCache.spreadsheetId !== spreadsheetId) {
        decisionContentCache = { spreadsheetId, builtAt: Date.now(), latest: new Map() };
    }
    decisionContentCache.latest.set(key, contentSnapshotOf(decision));
}

/**
 * 新規追加した判定の行番号をキャッシュへ登録する。
 * 行番号が特定できなかった場合（appendRows のレスポンス解析失敗）は、誤ったキャッシュで
 * 他人の判定を上書きするリスクを避けるため、登録せずキャッシュ自体を無効化する。
 */
function registerDecisionRowInCache(spreadsheetId: string, key: string, rowIndex: number | null): void {
    if (rowIndex === null) {
        invalidateDecisionRowCache();
        return;
    }
    if (!decisionRowCache || decisionRowCache.spreadsheetId !== spreadsheetId) return;
    decisionRowCache.rows.set(key, rowIndex);
}

/**
 * Decisions 行番号キャッシュ（保存内容スナップショット含む）を無効化する。
 * 行削除など行番号がずれる操作の後や、新規キーの把握ができない一括追加の後に呼ぶこと。
 */
export function invalidateDecisionRowCache(): void {
    decisionRowCache = null;
    decisionContentCache = null;
}

/**
 * saveDecision の直列化用 Promise チェーン。
 * 同一文献への保存が並行すると、両方が「既存行なし」と誤判定して重複行が2行できてしまう
 * （連打時に実際に発生していたバグ）。モジュールスコープの Promise チェーンで直列化して防ぐ。
 * 前段が失敗しても後続の保存を止めないよう、チェーン自体は常に resolve させておく。
 */
let saveDecisionChain: Promise<void> = Promise.resolve();

/**
 * 判定を保存する。
 * - human判定 / ML手動確認判定: 常に追記（append-only）。判定変更の履歴を行として残し、
 *   後日 Cohen's kappa を合議前後で算出できるようにするため、既存行の検索・更新は行わない。
 * - それ以外（ML自動判定・LLM判定）: 従来どおりの upsert（行番号キャッシュがヒットする限り
 *   読み取りリクエストを発行しない。キャッシュが無効な場合のみ全件読み取ってから判定する）。
 */
export async function saveDecision(spreadsheetId: string, decision: Decision): Promise<void> {
    const run = saveDecisionChain.then(() => saveDecisionInner(spreadsheetId, decision));
    saveDecisionChain = run.catch(() => { /* 前段の失敗で後続を止めない */ });
    return run;
}

async function saveDecisionInner(spreadsheetId: string, decision: Decision): Promise<void> {
    const targetPhase = decision.screening_phase ?? 'tiab';
    const key = decisionRowKey(decision.ref_id, decision.reviewer_id, decision.screening_phase);

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
        decision.context_json || '',
    ];

    if (isHumanDecision(decision.client_version) || isConfirmedMlDecision(decision.client_version)) {
        // 追記専用（append-only）: 既存行の検索・読み取りは一切行わず、常に新しい行として積む。
        // ただし直前に把握している内容と完全一致する場合は、誤タップ・連打・再描画による
        // 無意味な重複行を防ぐため保存自体をスキップする。
        const cachedContent = getCachedDecisionContent(spreadsheetId, key);
        if (cachedContent && isSameDecisionContent(cachedContent, contentSnapshotOf(decision))) {
            return;
        }
        await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    // それ以外（ML自動判定・LLM判定）は従来どおりの upsert ロジックを維持する
    // （LLMのpending→confirm行更新や deleteFulltextAiRound を壊さないため）
    const lookup = getCachedDecisionRow(spreadsheetId, key);

    if (lookup.state === 'hit') {
        // 既存行を更新（読み取り0回）
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${lookup.rowIndex}:${DECISIONS_LAST_COLUMN}${lookup.rowIndex}`, [row]);
        // decisionContentCache は「このキーへ最後に自分が書き込んだ内容」を指し続ける不変条件を保つ
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    if (lookup.state === 'absent') {
        // キャッシュ済みで未知のキー = 新規行（読み取り0回）
        const { firstRowIndex } = await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        registerDecisionRowInCache(spreadsheetId, key, firstRowIndex);
        rememberDecisionContent(spreadsheetId, key, decision);
        return;
    }

    // cold: キャッシュ無効時のみ従来どおり全件読み取る（getDecisions が内部でキャッシュを温める）
    const decisionsData = await getDecisions(spreadsheetId);
    const existing = decisionsData.find(
        ({ decision: d }) =>
            d.ref_id === decision.ref_id &&
            d.reviewer_id === decision.reviewer_id &&
            (d.screening_phase ?? 'tiab') === targetPhase
    );

    if (existing) {
        // 既存行を更新
        await updateRange(spreadsheetId, `${DECISIONS_SHEET}!A${existing.rowIndex}:${DECISIONS_LAST_COLUMN}${existing.rowIndex}`, [row]);
    } else {
        // 新規追加
        const { firstRowIndex } = await appendRows(spreadsheetId, DECISIONS_SHEET, [row]);
        registerDecisionRowInCache(spreadsheetId, key, firstRowIndex);
    }
    // decisionContentCache は「このキーへ最後に自分が書き込んだ内容」を指し続ける不変条件を保つ
    rememberDecisionContent(spreadsheetId, key, decision);
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

// ---------------------------------------------------------------------------
// フルテキスト担当割り振り（Config シート fulltext_assignment_* キー）
// ---------------------------------------------------------------------------

const FT_ASSIGNMENT_CONFIG_KEYS = [
    'fulltext_assignment_status',
    'fulltext_assignment_group_count',
    'fulltext_assignment_reviewer_map',
    'fulltext_assignment_seed',
    'fulltext_assignment_generated_at',
];

/** Config タブの A:B 行列から FulltextAssignmentConfig を組み立てる */
function parseFulltextAssignmentRows(values: string[][]): FulltextAssignmentConfig {
    const config: FulltextAssignmentConfig = { ...DEFAULT_FULLTEXT_ASSIGNMENT, reviewerMap: {} };

    for (const row of values) {
        const key = row[0];
        const value = row[1];
        if (!FT_ASSIGNMENT_CONFIG_KEYS.includes(key) || !value) continue;

        switch (key) {
            case 'fulltext_assignment_status':
                if (value === 'configured' || value === 'none') {
                    config.status = value;
                }
                break;
            case 'fulltext_assignment_group_count':
                config.groupCount = parseInt(value, 10) || DEFAULT_FULLTEXT_ASSIGNMENT.groupCount;
                break;
            case 'fulltext_assignment_reviewer_map':
                try {
                    config.reviewerMap = normalizeFulltextReviewerMap(JSON.parse(value) || {});
                } catch {
                    config.reviewerMap = {};
                }
                break;
            case 'fulltext_assignment_seed':
                config.seed = value;
                break;
            case 'fulltext_assignment_generated_at':
                config.generatedAt = value;
                break;
        }
    }

    return config;
}

export async function getFulltextAssignmentConfig(spreadsheetId: string): Promise<FulltextAssignmentConfig> {
    try {
        const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
        return parseFulltextAssignmentRows(values);
    } catch (error) {
        console.log('[getFulltextAssignmentConfig] Config not found, using defaults:', error);
        return { ...DEFAULT_FULLTEXT_ASSIGNMENT, reviewerMap: {} };
    }
}

export async function saveFulltextAssignmentConfig(
    spreadsheetId: string,
    config: FulltextAssignmentConfig
): Promise<void> {
    try {
        await trySaveFulltextAssignmentConfig(spreadsheetId, config);
    } catch (error) {
        if ((error as Error).message.includes('Unable to parse range') || (error as Error).message.includes('not found')) {
            console.log('[saveFulltextAssignmentConfig] Config sheet missing, creating...');
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveFulltextAssignmentConfig(spreadsheetId, config);
        } else {
            throw error;
        }
    }
}

async function trySaveFulltextAssignmentConfig(
    spreadsheetId: string,
    config: FulltextAssignmentConfig
): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    const rowIndices: Record<string, number> = {};

    values.forEach((row, index) => {
        if (FT_ASSIGNMENT_CONFIG_KEYS.includes(row[0])) {
            rowIndices[row[0]] = index + 1;
        }
    });

    const entries: Record<string, string> = {
        fulltext_assignment_status: config.status,
        fulltext_assignment_group_count: String(config.groupCount),
        fulltext_assignment_reviewer_map: JSON.stringify(config.reviewerMap || {}),
        fulltext_assignment_seed: config.seed || '',
        fulltext_assignment_generated_at: config.generatedAt || '',
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
    await updateReferenceColumnByRefId(
        spreadsheetId,
        'screening_set',
        assignments.map(({ refId, screeningSet }) => ({ refId, value: screeningSet }))
    );
}

/**
 * References タブの fulltext_set 列（フルテキスト担当セット）を一括更新する
 */
export async function updateReferenceFulltextSets(
    spreadsheetId: string,
    assignments: Array<{ refId: string; fulltextSet: string }>
): Promise<void> {
    await updateReferenceColumnByRefId(
        spreadsheetId,
        'fulltext_set',
        assignments.map(({ refId, fulltextSet }) => ({ refId, value: fulltextSet }))
    );
}

/**
 * References タブの任意の1列を ref_id をキーに一括更新する共通処理
 */
async function updateReferenceColumnByRefId(
    spreadsheetId: string,
    columnName: string,
    entries: Array<{ refId: string; value: string }>
): Promise<void> {
    if (entries.length === 0) return;

    await ensureHeaders(spreadsheetId);

    const values = await getSheetValues(spreadsheetId, `${REFERENCES_SHEET}!A:X`);
    if (values.length <= 1) return;

    const headers = values[0];
    const refIdIndex = headers.indexOf('ref_id');
    const columnIndex = headers.indexOf(columnName);

    if (refIdIndex === -1 || columnIndex === -1) {
        throw new Error(`${columnName} column not found`);
    }

    const rowIndexByRefId = new Map<string, number>();
    values.slice(1).forEach((row, index) => {
        const refId = (row[refIdIndex] || '').trim();
        if (refId) {
            rowIndexByRefId.set(refId, index + 2);
        }
    });

    const column = columnNumberToLetter(columnIndex);
    const updates = entries
        .map(({ refId, value }) => {
            const rowIndex = rowIndexByRefId.get(refId);
            if (!rowIndex) return null;
            return {
                range: `${REFERENCES_SHEET}!${column}${rowIndex}`,
                values: [[value]],
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
    // インポート統計（PRISMA識別件数・重複除去数の自動記入用）
    importStats: ImportStatsMap;
    // フルテキスト担当割り振り（未設定は status 'none' = 全員が全候補）
    fulltextAssignment: FulltextAssignmentConfig;
    // レビュー基準（人間レビュアー向けの表示用。AI 判定用の llm_criteria とは別物）
    reviewCriteria: ReviewCriteria | null;
    // フルテキスト除外理由リスト（未設定は null = 既定のPICO7区分）
    excludeReasonConfig: ExcludeReasonConfig | null;
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
    importStats: {},
    fulltextAssignment: { ...DEFAULT_FULLTEXT_ASSIGNMENT },
    reviewCriteria: null,
    excludeReasonConfig: null,
};

/**
 * Config タブの import_stats 値（JSON）をパースする。不正値は空として扱う。
 */
function parseImportStats(value: string | undefined): ImportStatsMap {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const stats: ImportStatsMap = {};
        for (const [file, raw] of Object.entries(parsed as Record<string, unknown>)) {
            if (!raw || typeof raw !== 'object') continue;
            const entry = raw as Record<string, unknown>;
            const identified = Number(entry.identified);
            const duplicates = Number(entry.duplicates);
            if (!Number.isFinite(identified) || !Number.isFinite(duplicates)) continue;
            stats[file] = {
                identified,
                duplicates,
                imported_at: typeof entry.imported_at === 'string' ? entry.imported_at : undefined,
            };
        }
        return stats;
    } catch {
        return {};
    }
}

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
    let importStats: ImportStatsMap = {};
    let reviewCriteria: ReviewCriteria | null = null;
    let excludeReasonConfig: ExcludeReasonConfig | null = null;

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
        if (row[0] === 'import_stats' && row[1]) {
            importStats = parseImportStats(row[1]);
        }
        if (row[0] === 'review_criteria') {
            reviewCriteria = parseReviewCriteria(row[1]);
        }
        if (row[0] === 'fulltext_exclude_reasons') {
            excludeReasonConfig = parseExcludeReasonConfig(row[1]);
        }
    }

    return {
        keyOpened,
        keywords: { include: includeKeywords, exclude: excludeKeywords },
        fulltextPoolRule,
        fulltextAiActiveRound,
        fulltextEvidenceDisplay,
        importStats,
        fulltextAssignment: parseFulltextAssignmentRows(values),
        reviewCriteria,
        excludeReasonConfig,
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
 * Blind中（keyOpened=false）の全文閲覧ウィンドウ向けに Decisions を絞り込む。
 * サイドパネルの Blind ロード（getReferencesWithStatus）と同じポリシー:
 * 自分の判定（reviewer_id が userEmail と一致）＋ LLM判定（reviewer_id が 'llm:' で始まる）のみ返す。
 * 他レビュアーの人間票・ML票はBlind中は一切クライアントへ渡さない。
 */
function filterDecisionsForBlind(
    decisions: { decision: Decision; rowIndex: number }[],
    keyOpened: boolean,
    userEmail: string
): { decision: Decision; rowIndex: number }[] {
    if (keyOpened) return decisions;
    const normalizedEmail = (userEmail || '').trim();
    return decisions.filter(({ decision }) => {
        const reviewerId = (decision.reviewer_id || '').trim();
        return reviewerId === normalizedEmail || reviewerId.startsWith('llm:');
    });
}

/**
 * フルテキストページの初期データをまとめて取得（1リクエスト）
 * References / Decisions / Config を values:batchGet で取得する。
 * 追記専用化により Decisions には同一キーの履歴行が複数残りうるため、返す前に
 * 各キーの最新1行へ畳み込む（下流のUI・集計を getDecisions() と同じ挙動に保つため）。
 *
 * keyOpened=false（Blind中）のときは、返す decisions を filterDecisionsForBlind() で
 * 自分の判定＋LLM判定に絞り込む（サイドパネルの Blind ロードと同じポリシー）。
 * primeDecisionRowCache() は絞り込み前の全件で温める（行番号キャッシュの整合性のため）。
 */
export async function getFulltextPageData(spreadsheetId: string, userEmail: string): Promise<{
    references: Reference[];
    decisions: { decision: Decision; rowIndex: number }[];
    config: ProjectConfigBundle;
}> {
    try {
        const [refValues, decValues, configValues] = await getSheetValuesBatch(spreadsheetId, [
            `${REFERENCES_SHEET}!A:X`,
            `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`,
            `${CONFIG_SHEET}!A:B`,
        ]);
        const decisions = collapseToLatestDecisions(parseDecisionValues(decValues));
        // ここでも Decisions を rowIndex 付きで全件取得しているため、行番号キャッシュを温める
        primeDecisionRowCache(spreadsheetId, decisions);
        const config = parseConfigBundle(configValues);
        return {
            references: parseReferenceValues(refValues),
            decisions: filterDecisionsForBlind(decisions, config.keyOpened, userEmail),
            config,
        };
    } catch (error) {
        // Config タブがない旧シートでは batchGet 全体が失敗するため、Config 抜きで再試行
        if ((error as Error).message.includes('Unable to parse range')) {
            console.log('[getFulltextPageData] Config sheet missing, falling back:', error);
            const [refValues, decValues] = await getSheetValuesBatch(spreadsheetId, [
                `${REFERENCES_SHEET}!A:X`,
                `${DECISIONS_SHEET}!A:${DECISIONS_LAST_COLUMN}`,
            ]);
            const decisions = collapseToLatestDecisions(parseDecisionValues(decValues));
            primeDecisionRowCache(spreadsheetId, decisions);
            const config = { ...DEFAULT_CONFIG_BUNDLE };
            return {
                references: parseReferenceValues(refValues),
                decisions: filterDecisionsForBlind(decisions, config.keyOpened, userEmail),
                config,
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
 * key開閉などの監査イベントを Audit_Log タブへ1行追記する（AGENTS.md「Audit_Log タブ」参照）。
 * タブが無いプロジェクトでは addSheet → ヘッダ行 append → 本体行 append の順でリトライする
 * （trySaveConfigValue と同じ「Config タブ欠落時の自動作成」パターンを踏襲）。
 *
 * 監査ログはベストエフォート: この関数は絶対に throw を外へ漏らさない。失敗しても
 * console.warn するだけで、呼び出し元の本体操作（key開閉そのもの）を壊してはならない。
 */
export async function logAuditEvent(
    spreadsheetId: string,
    event: Omit<AuditLogEvent, 'event_id'>
): Promise<void> {
    try {
        const row = buildAuditEventRow({ event_id: crypto.randomUUID(), ...event });
        try {
            await appendRows(spreadsheetId, AUDIT_LOG_SHEET, [row]);
        } catch (error) {
            const message = String((error as { message?: unknown } | undefined)?.message ?? error);
            if (message.includes('Unable to parse range') || message.includes('not found')) {
                console.log('[logAuditEvent] Audit_Log sheet missing, creating...');
                await addSheet(spreadsheetId, AUDIT_LOG_SHEET);
                await appendRows(spreadsheetId, AUDIT_LOG_SHEET, [AUDIT_LOG_HEADERS]);
                await appendRows(spreadsheetId, AUDIT_LOG_SHEET, [row]);
            } else {
                throw error;
            }
        }
    } catch (error) {
        // ベストエフォート: 監査ログの失敗で本体操作（key開閉）を失敗させない
        console.warn('[logAuditEvent] Failed to record audit event (best-effort, ignored):', error);
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
    /** 権限ID（permissions.delete に必要。取得できない場合がある） */
    id?: string;
    /** 'user' / 'group' / 'domain' / 'anyone' 等（リンク共有等の判別に使う） */
    type?: string;
    displayName?: string;
}

/**
 * 指定ファイル（スプレッドシート/フォルダ問わず）の権限一覧を取得する。
 * 解除処理で権限IDが必要なため、role/emailAddress に加えて id/type/displayName も取得する。
 */
export async function getFilePermissions(fileId: string): Promise<SpreadsheetPermission[]> {
    const token = await getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,role,type,emailAddress,displayName)`,
        {},
        { token }
    );

    if (!response.ok) {
        throw new Error(`Failed to get permissions: ${response.statusText}`);
    }

    const data = await response.json();
    return data.permissions || [];
}

/**
 * スプレッドシートの権限情報を取得（getFilePermissions への委譲）
 * 呼び出し元（isUserAdmin / project.ts / fulltext.ts 等）への影響を避けるため、
 * シグネチャ・外部挙動は変更しない。
 */
export async function getSpreadsheetPermissions(spreadsheetId: string): Promise<SpreadsheetPermission[]> {
    return getFilePermissions(spreadsheetId);
}

/**
 * Drive Permissions API のエラーレスポンス（ステータスコード・エラーメッセージ）を保持する例外。
 * 呼び出し元で classifyPermissionRemovalError に渡し、権限不足/継承権限などを判別する。
 */
export class DrivePermissionError extends Error {
    status: number;
    apiMessage: string;

    constructor(status: number, apiMessage: string) {
        super(apiMessage);
        this.name = 'DrivePermissionError';
        this.status = status;
        this.apiMessage = apiMessage;
    }
}

/**
 * 指定ファイル（スプレッドシート/フォルダ）から権限を1件削除する。
 *
 * **注意**: フォルダ共有プロジェクトでは、フォルダ側の権限を削除しないと
 * 配下のスプレッドシート/フルテキストPDFへのアクセスが（フォルダからの継承として）
 * 残り続けてしまう。呼び出し側は「共有先（フォルダがあればフォルダ優先）」の各対象に
 * 対して本関数を呼ぶこと。
 */
export async function deletePermission(fileId: string, permissionId: string): Promise<void> {
    const token = await getAuthToken();

    const response = await driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
        { method: 'DELETE' },
        { token }
    );

    if (!response.ok) {
        const error = await response.json().catch(() => null);
        const apiMessage = error?.error?.message || response.statusText;
        throw new DrivePermissionError(response.status, apiMessage);
    }
}

/**
 * emailMessage クエリパラメータの、encodeURIComponent 後の長さの上限バジェット。
 * Drive REST API の URL 全体には概ね8KB程度の実用上の制限があるため、その半分程度を
 * emailMessage 用に確保する。日本語1文字は encodeURIComponent で最大9文字
 * （UTF-8 3バイト → "%XX%XX%XX"）に膨らむため、元の文字数ではなくエンコード後の
 * 長さを基準に切り詰める。招待文テンプレート（日本語で約300文字）はエンコード後でも
 * 十分このバジェット内に収まるため、実運用で切り詰めが発生することはまず無い。
 */
const EMAIL_MESSAGE_ENCODED_BUDGET = 4000;

/** truncateEmailMessageForQuery が1回のループで末尾から削るコードポイント数 */
const TRUNCATE_CHUNK_SIZE = 50;

/**
 * emailMessage を、encodeURIComponent 後の長さが budget 以内に収まるまで末尾から削る。
 * サロゲートペア（絵文字等）を途中で分断しないよう Array.from でコードポイント単位に
 * 分割してから操作する。ループのたびに配列が必ず短くなるため無限ループにはならない。
 */
function truncateEmailMessageForQuery(message: string, budget: number): string {
    if (encodeURIComponent(message).length <= budget) return message;
    const chars = Array.from(message);
    while (chars.length > 0 && encodeURIComponent(chars.join('')).length > budget) {
        chars.splice(-TRUNCATE_CHUNK_SIZE);
    }
    return chars.join('');
}

/**
 * addPermission のオプション引数（後方互換のため第5引数のオプションオブジェクトとして追加）。
 */
export interface AddPermissionOptions {
    /**
     * Driveの共有通知メールを送るかどうか。省略時はDriveの既定挙動
     * （emailMessage指定時は通知あり、未指定時はDriveの既定＝type=userなら通知あり）に従う。
     * false を明示すると、emailMessage の有無にかかわらず sendNotificationEmail=false を
     * クエリへ付ける（emailMessageを載せていても通知自体を送らないなら本文は届かないため、
     * 明示指定を優先する）。共有先を複数回に分けて呼ぶフロー（例: スプレッドシートに
     * 招待文つきで共有した後、同じ相手へフォルダもベストエフォートで共有する）で、
     * 通知メールが2通届くのを防ぐ用途。
     */
    sendNotificationEmail?: boolean;
}

/**
 * 共有設定を追加（Google Drive API）
 *
 * @param fileId 共有対象のファイル/フォルダID
 * @param emailAddress 共有相手のメールアドレス
 * @param role 付与する権限（既定: writer）
 * @param emailMessage Driveの共有通知メールに載せる本文（省略時はDrive既定の通知文のみ）。
 *   **注意**: Drive API v3 permissions.create の仕様上、emailMessage は
 *   リクエストボディではなく **URLのクエリパラメータ** で渡す
 *   （https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create）。
 *   Permission リソース（ボディ）のスキーマに emailMessage フィールドは存在せず、
 *   ボディに入れても Drive 側は無視する（＝通知メール本文が変わらない）ので注意すること。
 *   emailMessage 指定時は sendNotificationEmail=true も明示的にクエリへ付ける
 *   （type=user 時は本来既定で true だが、本文を載せる以上メール送信自体を必須要件として
 *   明示する）。emailMessage 未指定時はクエリを一切付けず、従来と同一のリクエストにする。
 *   URL長制限に配慮し、エンコード後の長さが EMAIL_MESSAGE_ENCODED_BUDGET を超える場合は
 *   末尾を切り詰める。
 * @param options 通知抑制など追加オプション（省略時は既存呼び出しと同一挙動。後方互換）。
 *   詳細は {@link AddPermissionOptions} を参照。
 */
export async function addPermission(
    fileId: string,
    emailAddress: string,
    role: 'writer' | 'reader' = 'writer',
    emailMessage?: string,
    options?: AddPermissionOptions
): Promise<void> {
    const token = await getAuthToken();

    const body = {
        role: role,
        type: 'user',
        emailAddress: emailAddress,
    };

    // クエリ文字列は URLSearchParams ではなく encodeURIComponent を自前で使って組み立てる。
    // URLSearchParams.toString() は application/x-www-form-urlencoded 形式のため、
    // 空白を %20 ではなく + にエンコードしてしまう。招待文には「TiAb Review Plugin」
    // 「Google Chrome」など空白を含む文字列が多数あり、Google側が + をリテラルの
    // プラス記号として解釈した場合、共有相手に届くメール本文が「TiAb+Review+Plugin」の
    // ように壊れて見えるリスクがある。%20（RFC 3986）はどちらの解釈でも確実に空白になる
    // ため、こちらに寄せている。「URLSearchParamsの方が綺麗」という理由で戻さないこと。
    let queryString = '';
    if (emailMessage) {
        const truncated = truncateEmailMessageForQuery(emailMessage, EMAIL_MESSAGE_ENCODED_BUDGET);
        const sendNotificationEmail = options?.sendNotificationEmail === false ? 'false' : 'true';
        queryString = `?emailMessage=${encodeURIComponent(truncated)}&sendNotificationEmail=${sendNotificationEmail}`;
    } else if (options?.sendNotificationEmail === false) {
        // emailMessage が無い場合のみ、明示的な通知抑制指定を反映する。
        // 未指定（options自体が無い、または sendNotificationEmail が無い）ときは
        // 従来どおりクエリを一切付けない（Drive既定の通知ありの挙動を変えない）。
        queryString = '?sendNotificationEmail=false';
    }
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions${queryString}`;

    const response = await driveFetch(
        url,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        { token }
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
        const response = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=capabilities(canEdit,canShare)`,
            {},
            { token }
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
 * Config タブへ key=value の1行を保存する（既存なら B列を上書き、無ければ末尾に追記）。
 * fulltext_pool_rule / review_criteria / fulltext_exclude_reasons / import_stats など、
 * Config タブに「1キー1行」で保存する値はすべてこれを経由する
 * （旧実装ではキー名とシリアライザ以外ほぼ同一の関数が4つ並んでいたのを集約した）。
 * Config シート自体が無いプロジェクトでは自動作成してから1回だけリトライする。
 */
async function saveConfigValue(spreadsheetId: string, key: string, value: string): Promise<void> {
    try {
        await trySaveConfigValue(spreadsheetId, key, value);
    } catch (error) {
        // reject の中身が Error とは限らない（Promise.reject(文字列) 等）ため、
        // .message への安全なアクセスに寄せる。
        const message = String((error as { message?: unknown } | undefined)?.message ?? error);
        if (message.includes('Unable to parse range') || message.includes('not found')) {
            console.log(`[saveConfigValue] Config sheet missing, creating... (key=${key})`);
            await addSheet(spreadsheetId, CONFIG_SHEET);
            await trySaveConfigValue(spreadsheetId, key, value);
        } else {
            throw error;
        }
    }
}

async function trySaveConfigValue(spreadsheetId: string, key: string, value: string): Promise<void> {
    const values = await getSheetValues(spreadsheetId, `${CONFIG_SHEET}!A:B`);
    let rowIndex = -1;

    values.forEach((row, index) => {
        if (row[0] === key) rowIndex = index + 1;
    });

    if (rowIndex !== -1) {
        await updateRange(spreadsheetId, `${CONFIG_SHEET}!B${rowIndex}`, [[value]]);
    } else {
        await appendRows(spreadsheetId, CONFIG_SHEET, [[key, value]]);
    }
}

/**
 * フルテキスト候補ルールを保存
 */
export async function saveFulltextPoolRule(spreadsheetId: string, rule: FulltextPoolRule): Promise<void> {
    await saveConfigValue(spreadsheetId, 'fulltext_pool_rule', JSON.stringify(rule));
}

/**
 * レビュー基準（組入・除外基準）を保存
 */
export async function saveReviewCriteria(spreadsheetId: string, criteria: ReviewCriteria): Promise<void> {
    await saveConfigValue(spreadsheetId, 'review_criteria', serializeReviewCriteria(criteria));
}

/**
 * フルテキスト除外理由リストを Config タブの fulltext_exclude_reasons キーへ保存する
 */
export async function saveExcludeReasonConfig(spreadsheetId: string, config: ExcludeReasonConfig): Promise<void> {
    await saveConfigValue(spreadsheetId, 'fulltext_exclude_reasons', serializeExcludeReasonConfig(config));
}

/**
 * インポート統計を Config タブの import_stats キーへ保存する
 */
export async function saveImportStats(spreadsheetId: string, stats: ImportStatsMap): Promise<void> {
    await saveConfigValue(spreadsheetId, 'import_stats', JSON.stringify(stats));
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
 * ラウンドの履歴行を1行残らず消す必要があるため、畳み込み後ではなく生の全行を使う。
 * @returns 削除した行数
 */
export async function deleteFulltextAiRound(spreadsheetId: string, reviewerId: string): Promise<number> {
    const decisionsData = await getDecisionsRaw(spreadsheetId);
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

    // 削除により Decisions の行番号がずれるため、行番号キャッシュを必ず無効化する
    invalidateDecisionRowCache();

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
 * Config タブ自体が存在しない（＝本当に未設定）ことを示すエラーかを判定する。
 * getSheetValues が投げる「Unable to parse range」等のメッセージ文言で判定する
 * （saveFulltextDriveFolderId 等が Config シート新規作成のトリガーに使っている判定と同じ）。
 * SheetsAccessDeniedError（403/404）のデフォルトメッセージにも "not found" を含みうるため、
 * ここでは常に false 扱いにして呼び出し側へ再送出させる（アクセス拒否を「未設定」に潰さないため）。
 */
function isConfigSheetMissingError(error: unknown): boolean {
    if (error instanceof SheetsAccessDeniedError) return false;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Unable to parse range') || message.includes('not found');
}

/**
 * フルテキストPDF保存用 Drive フォルダIDを取得（未設定は null）。
 * Config タブが本当に無い場合だけ null を返す。アクセス拒否・一時エラーは
 * 「未設定」に見せず throw する（呼び出し元の ensureFulltextFolder が誤ってフォルダを
 * 作り直さないようにするため。詳細は drive-api.ts の resolveFolderState 参照）。
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
        if (isConfigSheetMissingError(error)) {
            console.log('[getFulltextDriveFolderId] Config not found, returning null:', error);
            return null;
        }
        throw error;
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
 * Config タブが本当に無い場合だけ null を返す。アクセス拒否・一時エラーは
 * 「未設定」に見せず throw する（isConfigSheetMissingError のコメント参照）。
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
        if (isConfigSheetMissingError(error)) {
            console.log('[getProjectDriveFolderId] Config not found, returning null:', error);
            return null;
        }
        throw error;
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
    llm_target_mode: 'all',
    llm_target_ref_ids: '',
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
    'llm_target_mode',
    'llm_target_ref_ids',
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
                case 'llm_target_mode':
                    config.llm_target_mode = parseLlmTargetMode(value);
                    break;
                case 'llm_target_ref_ids':
                    // シート直編集で混じる改行・重複・空白をここで正規化する
                    config.llm_target_ref_ids = serializeTargetRefIds(parseTargetRefIds(value));
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
        execution.target_mode ?? '',
        execution.target_sets ?? '',
        execution.target_selected_count?.toString() ?? '',
        execution.executed_by ?? '',
        execution.maybe_count?.toString() ?? '',
        execution.failed_count?.toString() ?? '',
        execution.failure_breakdown ?? '',
        execution.exclude_reasons_snapshot ?? '',
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
                    case 'target_selected_count':
                    case 'maybe_count':
                    case 'failed_count':
                        // 0 と未設定を区別したいので `|| 0` にはしない
                        execution[header] = value ? parseInt(value, 10) : undefined;
                        break;
                    case 'target_mode':
                        execution[header] = value ? parseLlmTargetMode(value) : undefined;
                        break;
                    case 'exclude_reasons_snapshot':
                        // フルテキスト以外の実行では null（JSON文字列そのままで保持し、
                        // 中身の配列としての解釈は呼び出し側に委ねる。criteria_snapshot と違い
                        // ここではパースしない＝型は string | null のまま）
                        execution[header] = value || null;
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
 *
 * newRow の組み立ては下の headers.map(...) がヘッダ駆動で行っており、
 * criteria_snapshot / is_active 以外の値は「数値なら toString()、それ以外は String()」
 * という一般則で素通しする。failure_breakdown を LlmExecution 側で string 型
 * （JSON文字列）にしているのはこの一般則にそのまま乗せるためで、オブジェクト型にすると
 * criteria_snapshot のような特別扱いの分岐をここに追加する必要が出てしまう。
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

    // 同一 config_hash の Run が複数ある（＝「新規にやり直す」を使った）場合、
    // legacy バッチはやり直しより前の実行なので最も古い Run に属させる
    const runByHash = new Map<string, LlmRun>();
    for (const run of existingRuns) {
        if (runByHash.has(run.config_hash)) continue;
        const picked = pickLegacyRunByConfigHash(existingRuns, run.config_hash);
        if (picked) runByHash.set(run.config_hash, picked);
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
 * 「新規にやり直す」により同一 config_hash の Run が複数存在しうるため、
 * 優先順位は最新 created_at（同時刻なら active confirmed > confirmed > pending）。
 */
export async function findRunByConfigHash(
    spreadsheetId: string,
    configHash: string
): Promise<LlmRun | null> {
    const runs = await getLlmRuns(spreadsheetId);
    return pickRunByConfigHash(runs, configHash);
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
 * 指定した Batch ID 群が既に判定した ref_id の集合を Sheets から取得する。
 *
 * バッチ実行直前の対象確定に使う。state.references[].llmBatchIds は画面ロード時の
 * スナップショットなので、他レビュアーが直前に判定した分を取りこぼす。同一 Run に
 * 同じ文献の LLM 票が二重に入るのを防ぐため、実行時だけはサーバーの真値を読み直す。
 *
 * getSheetValues はキャッシュしないので、この呼び出しは必ず最新を返す（読み取り1リクエスト）。
 */
export async function getJudgedRefIdsForBatches(
    spreadsheetId: string,
    batchIds: ReadonlySet<string>
): Promise<Set<string>> {
    if (batchIds.size === 0) return new Set();

    // 抽出ロジック（Run 単位の絞り込み・trim 正規化）は collectJudgedRefIds に集約しテスト対象にしている。
    // ここは Sheets から読み取って渡すだけの薄いラッパー。
    const decisionsData = await getDecisions(spreadsheetId);
    return collectJudgedRefIds(decisionsData.map(({ decision }) => decision), batchIds);
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
    // 行番号はずれないが、新規に追加したキーを行番号キャッシュが把握できておらず
    // absent 判定を誤る（＝存在するのに新規行として追記してしまう）ため無効化する
    invalidateDecisionRowCache();
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
        range: `${DECISIONS_SHEET}!A${rowIndex}:${DECISIONS_LAST_COLUMN}${rowIndex}`,
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




