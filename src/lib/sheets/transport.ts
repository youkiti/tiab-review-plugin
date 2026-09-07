// transport.ts - Google Sheets API との通信層（fetch ラッパー・リトライ・認可エラー判定）
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。シート定義は ./schema、行変換は ./codecs を参照。

import { platform } from '../../platform';

export const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';


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

export async function readSheetsErrorMessage(response: Response): Promise<string> {
    try {
        const error = await response.json();
        return error.error?.message || response.statusText;
    } catch {
        return response.statusText;
    }
}

/**
 * OAuth トークンを取得。
 * interactive=true のときのみユーザー操作起点の認可（Web版はポップアップ）を許可する。
 * ログインボタン等の操作起点からの呼び出しでのみ true を渡すこと。
 */
export async function getAuthToken(interactive = false): Promise<string> {
    return platform().getAuthToken(interactive);
}

const defaultQuotaRetrySleep = (delayMs: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, delayMs));
let quotaRetrySleep = defaultQuotaRetrySleep;

/** テスト専用の待機差し替え。本番コードから呼ばないこと。引数省略で既定の待機へ戻す。 */
export function setQuotaRetrySleepForTest(sleep = defaultQuotaRetrySleep): void {
    quotaRetrySleep = sleep;
}

/**
 * 読み取り・書き込み共通のクォータ超過 (429) 用指数バックオフリトライ。
 * 待機は 1s → 2s → 4s → 8s → 16s の最大5回。遅延の更新上限は32s。
 * 429 以外、およびリトライ上限の Response はそのまま返し、エラー処理は呼び出し元に任せる。
 */
export async function fetchWithQuotaRetry(
    url: string,
    init: RequestInit,
    label: string,
    caller: string
): Promise<Response> {
    const maxRetries = 5;
    let delayMs = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(url, init);
        if (response.status !== 429 || attempt === maxRetries) {
            return response;
        }
        console.warn(`[${caller}] 429 quota exceeded for ${label}, retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
        await quotaRetrySleep(delayMs);
        delayMs = Math.min(delayMs * 2, 32000);
    }
    // ループ終端は到達不能（return か throw のいずれか）
    throw new Error('fetchWithQuotaRetry: unreachable');
}

export async function fetchSheetValuesWithRetry(
    spreadsheetId: string,
    range: string,
    token: string
): Promise<Response> {
    return fetchWithQuotaRetry(
        `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
        { headers: { 'Authorization': `Bearer ${token}` } },
        range,
        'getSheetValues'
    );
}

/**
 * シートからデータを取得
 */
export async function getSheetValues(spreadsheetId: string, range: string): Promise<string[][]> {
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
export async function getSheetValuesBatch(spreadsheetId: string, ranges: string[]): Promise<string[][][]> {
    const token = await getAuthToken();
    const params = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values:batchGet?${params}`;

    const response = await fetchWithQuotaRetry(
        url,
        { headers: { 'Authorization': `Bearer ${token}` } },
        ranges.join(', '),
        'getSheetValues'
    );

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
export function parseFirstRowIndexFromUpdatedRange(updatedRange: string | undefined): number | null {
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
 * Issue #194: 追記も429時はリトライする。429はクォータ判定による受理前の拒否であり、
 * 追記済みで429が返る可能性は低く、重複行は生まれにくい。
 * 万一Decisionsに重複しても、追記専用契約に沿って collapseToLatestDecisions() が
 * 同一 (ref_id, reviewer_id, screening_phase) の最新1行へ畳み込むため、表示・集計は壊れない。
 * 即時失敗でユーザーの判定が失われるより、まれな重複行の方が害が小さいと判断する。
 */
export async function appendRows(
    spreadsheetId: string,
    sheetName: string,
    rows: (string | number | undefined)[][]
): Promise<{ firstRowIndex: number | null }> {
    const token = await getAuthToken();

    const response = await fetchWithQuotaRetry(
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
        },
        sheetName,
        'appendRows'
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
export async function updateRange(spreadsheetId: string, range: string, values: (string | number | undefined)[][]): Promise<void> {
    const token = await getAuthToken();

    const response = await fetchWithQuotaRetry(
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
        },
        range,
        'updateRange'
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to update range: ${error.error?.message || response.statusText}`);
    }
}

/**
 * シート名からシートIDを取得
 */
export async function getSheetIdByName(spreadsheetId: string, sheetName: string): Promise<number | null> {
    const token = await getAuthToken();
    const response = await fetchWithQuotaRetry(
        `${SHEETS_API_BASE}/${spreadsheetId}?fields=sheets.properties`,
        {
            headers: { 'Authorization': `Bearer ${token}` }
        },
        sheetName,
        'getSheetIdByName'
    );

    if (!response.ok) return null;

    const data = await response.json();
    const sheet = data.sheets.find((s: any) => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : null;
}

export async function batchUpdateRanges(
    spreadsheetId: string,
    updates: Array<{ range: string; values: string[][] }>
): Promise<void> {
    const token = await getAuthToken();
    const response = await fetchWithQuotaRetry(
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
        },
        updates.map(update => update.range).join(', '),
        'batchUpdateRanges'
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to batch update ranges: ${error.error?.message || response.statusText}`);
    }
}

export async function addSheet(spreadsheetId: string, title: string): Promise<void> {
    const token = await getAuthToken();
    const response = await fetchWithQuotaRetry(`${SHEETS_API_BASE}/${spreadsheetId}:batchUpdate`, {
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
    }, title, 'addSheet');

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Failed to add sheet: ${error.error?.message || response.statusText}`);
    }
}

/**
 * 対象タブ自体が存在しない（＝本当に未設定・未作成）ことを示すエラーかを判定する。
 * getSheetValues が投げる「Unable to parse range」等のメッセージ文言で判定する
 * （saveFulltextDriveFolderId 等が Config シート新規作成のトリガーに使っている判定と同じ。
 * Config タブに限らず、getDuplicateCandidates() 等シート欠落時に ensure して読み直す
 * 他の経路からも共通で使う。PR #161 レビュー指摘対応で `isConfigSheetMissingError` から改名）。
 * SheetsAccessDeniedError（403/404）のデフォルトメッセージにも "not found" を含みうるため、
 * ここでは常に false 扱いにして呼び出し側へ再送出させる（アクセス拒否を「未設定」に潰さないため）。
 */
export function isSheetMissingError(error: unknown): boolean {
    if (error instanceof SheetsAccessDeniedError) return false;
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Unable to parse range') || message.includes('not found');
}
