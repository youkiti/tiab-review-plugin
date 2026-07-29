// デモモード用 fetch モック
//
// globalThis.fetch を丸ごと差し替え、Google Sheets API / Drive API / OAuth userinfo への
// 呼び出しをすべて src/demo/sheet-store.ts（インメモリストア）で処理する。
// chrome-extension:// 宛て（PDF.js のワーカー/CMap取得等）と相対URLは実際の fetch へ
// そのまま素通しし、それ以外の未対応な外部ホスト・エンドポイントは 404 を返して
// console.warn するだけに留め、実ネットワークには一切出ない。

import {
    readRange,
    readRanges,
    writeRange,
    appendRowsTo,
    addSheetToStore,
    listSheets,
    getStoreSpreadsheetTitle,
} from './sheet-store';
import { DEMO_SPREADSHEET_ID, DEMO_SPREADSHEET_TITLE, DEMO_USER_EMAIL, DEMO_SEED_TIMESTAMP } from './constants';

let installed = false;

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * 実APIの「シートが存在しない」エラーメッセージ文言に合わせて 400 を返す。
 * sheets-api.ts 側がこの文言（"Unable to parse range"）を見てシート作成の
 * 再試行フローに分岐するため、文言を変えないこと。
 */
function notFoundRange(range: string): Response {
    return jsonResponse(400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
}

function unknownSpreadsheet(): Response {
    return jsonResponse(404, { error: { code: 404, message: 'Requested entity was not found.' } });
}

function extractUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

function isPassthroughUrl(rawUrl: string): boolean {
    if (rawUrl.startsWith('chrome-extension://')) return true;
    // http(s) 以外（相対パス等）は拡張内リソースの参照とみなし、そのまま実fetchへ流す
    return !/^https?:\/\//i.test(rawUrl);
}

function readJsonBody(init: RequestInit | undefined): any {
    if (!init || init.body === undefined || init.body === null) return undefined;
    try {
        return JSON.parse(init.body as string);
    } catch {
        return undefined;
    }
}

// ============================================================
// Google Sheets API
// ============================================================

function handleSpreadsheetMetadata(spreadsheetId: string): Response {
    if (spreadsheetId !== DEMO_SPREADSHEET_ID) return unknownSpreadsheet();
    return jsonResponse(200, {
        spreadsheetId,
        properties: { title: getStoreSpreadsheetTitle() },
        sheets: listSheets().map(({ title, sheetId }) => ({ properties: { title, sheetId } })),
    });
}

function handleSpreadsheetBatchUpdate(spreadsheetId: string, body: any): Response {
    if (spreadsheetId !== DEMO_SPREADSHEET_ID) return unknownSpreadsheet();
    const requests: any[] = Array.isArray(body?.requests) ? body.requests : [];
    const replies = requests.map((req) => {
        const addTitle = req?.addSheet?.properties?.title;
        if (typeof addTitle === 'string' && addTitle) {
            const sheetId = addSheetToStore(addTitle);
            return { addSheet: { properties: { sheetId, title: addTitle } } };
        }
        // deleteDimension 等、このチャンクでは未対応のリクエスト種別は警告のみで無視する
        console.warn('[demo] spreadsheet batchUpdate: 未対応のリクエスト種別のため無視しました', req);
        return {};
    });
    return jsonResponse(200, { spreadsheetId, replies });
}

function handleValuesGet(range: string): Response {
    const values = readRange(range);
    if (values === null) return notFoundRange(range);
    return jsonResponse(200, { range, majorDimension: 'ROWS', values });
}

function handleValuesUpdate(range: string, body: any): Response {
    const values: string[][] = Array.isArray(body?.values) ? body.values : [];
    if (!writeRange(range, values)) return notFoundRange(range);
    return jsonResponse(200, {
        spreadsheetId: DEMO_SPREADSHEET_ID,
        updatedRange: range,
        updatedRows: values.length,
        updatedColumns: values[0]?.length ?? 0,
        updatedCells: values.reduce((acc, row) => acc + row.length, 0),
    });
}

function handleValuesAppend(sheetName: string, body: any): Response {
    const rows: string[][] = Array.isArray(body?.values) ? body.values : [];
    const result = appendRowsTo(sheetName, rows);
    if (!result) return notFoundRange(sheetName);
    const { firstRowIndex, lastRowIndex } = result;
    return jsonResponse(200, {
        spreadsheetId: DEMO_SPREADSHEET_ID,
        updates: {
            spreadsheetId: DEMO_SPREADSHEET_ID,
            // 列文字は実際の列数と一致していなくても良い（呼び出し側は先頭行番号だけを見る）
            updatedRange: `${sheetName}!A${firstRowIndex}:Z${lastRowIndex}`,
            updatedRows: rows.length,
        },
    });
}

function handleValuesBatchGet(spreadsheetId: string, ranges: string[]): Response {
    if (spreadsheetId !== DEMO_SPREADSHEET_ID) return unknownSpreadsheet();
    const results = readRanges(ranges);
    if (results === null) {
        // 実APIはレンジのいずれかが不正だとリクエスト全体を失敗させる
        return jsonResponse(400, { error: { code: 400, message: `Unable to parse range: ${ranges.join(', ')}` } });
    }
    return jsonResponse(200, {
        spreadsheetId,
        valueRanges: results.map((values, i) => ({ range: ranges[i], majorDimension: 'ROWS', values })),
    });
}

function handleValuesBatchUpdate(spreadsheetId: string, body: any): Response {
    if (spreadsheetId !== DEMO_SPREADSHEET_ID) return unknownSpreadsheet();
    const data: { range: string; values?: string[][] }[] = Array.isArray(body?.data) ? body.data : [];
    for (const item of data) {
        if (!writeRange(item.range, item.values || [])) return notFoundRange(item.range);
    }
    return jsonResponse(200, { spreadsheetId, totalUpdatedRows: data.length });
}

/**
 * `${SHEETS_API_BASE}/{id}(...)` 形式のパスを解釈する。
 * 戻り値 null は「このハンドラの対象外」を意味し、呼び出し側は次のフォールバック
 * （404 + console.warn）に進む。
 */
function routeSheetsApi(pathname: string, url: URL, method: string, body: any): Response | null {
    const prefix = '/v4/spreadsheets/';
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);

    // "{id}:batchUpdate" （スプレッドシート全体への addSheet 等。/values を含まないもの限定）
    if (rest.endsWith(':batchUpdate') && !rest.includes('/values')) {
        if (method !== 'POST') return null;
        return handleSpreadsheetBatchUpdate(rest.slice(0, -':batchUpdate'.length), body);
    }

    const valuesMarker = '/values';
    const valuesIdx = rest.indexOf(valuesMarker);

    if (valuesIdx === -1) {
        // メタデータ取得（fields=properties.title / fields=sheets.properties 等）
        if (method !== 'GET') return null;
        return handleSpreadsheetMetadata(rest);
    }

    const spreadsheetId = rest.slice(0, valuesIdx);
    // '' | ':batchGet' | ':batchUpdate' | '/{range}' | '/{sheetName}:append'
    const tail = rest.slice(valuesIdx + valuesMarker.length);

    if (tail === ':batchGet') {
        if (method !== 'GET') return null;
        const ranges = url.searchParams.getAll('ranges').map((r) => decodeURIComponent(r));
        return handleValuesBatchGet(spreadsheetId, ranges);
    }
    if (tail === ':batchUpdate') {
        if (method !== 'POST') return null;
        return handleValuesBatchUpdate(spreadsheetId, body);
    }
    if (tail.startsWith('/')) {
        if (spreadsheetId !== DEMO_SPREADSHEET_ID) return unknownSpreadsheet();

        // ":append" はエンコード対象外の文字列として付与されているため、
        // decode より前に判定する（レンジ内部の "!"/":" は %21/%3A に潰れておりここに現れない）
        const rawSegment = tail.slice(1);
        if (rawSegment.endsWith(':append')) {
            if (method !== 'POST') return null;
            const sheetName = decodeURIComponent(rawSegment.slice(0, -':append'.length));
            return handleValuesAppend(sheetName, body);
        }

        const range = decodeURIComponent(rawSegment);
        if (method === 'GET') return handleValuesGet(range);
        if (method === 'PUT') return handleValuesUpdate(range, body);
        return null;
    }
    return null;
}

// ============================================================
// Google Drive API / OAuth userinfo
// ============================================================

function routeGoogleApis(pathname: string, method: string): Response | null {
    if (pathname === '/oauth2/v3/userinfo') {
        if (method !== 'GET') return null;
        return jsonResponse(200, {
            sub: 'demo-user-000000000000000000000',
            email: DEMO_USER_EMAIL,
            email_verified: true,
            name: 'デモ 太郎',
        });
    }

    if (pathname === '/drive/v3/files') {
        if (method !== 'GET') return null;
        return jsonResponse(200, {
            files: [{ id: DEMO_SPREADSHEET_ID, name: DEMO_SPREADSHEET_TITLE, modifiedTime: DEMO_SEED_TIMESTAMP }],
        });
    }

    const permMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (permMatch) {
        if (method !== 'GET') return null;
        const fileId = decodeURIComponent(permMatch[1]);
        if (fileId !== DEMO_SPREADSHEET_ID) return jsonResponse(200, { permissions: [] });
        // デモユーザーを owner として返す → isUserAdmin() が管理者判定になる
        return jsonResponse(200, {
            permissions: [
                {
                    id: 'demo-owner-permission',
                    role: 'owner',
                    type: 'user',
                    emailAddress: DEMO_USER_EMAIL,
                    displayName: 'デモ 太郎',
                },
            ],
        });
    }

    const fileMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fileMatch) {
        if (method !== 'GET') return null;
        return jsonResponse(200, { capabilities: { canEdit: true, canShare: true } });
    }

    return null;
}

// ============================================================
// インストール
// ============================================================

export function installDemoFetchMock(): void {
    if (installed) return;
    installed = true;

    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl = extractUrl(input);

        if (isPassthroughUrl(rawUrl)) {
            return originalFetch(input, init);
        }

        try {
            const url = new URL(rawUrl);
            const method = (init?.method || 'GET').toUpperCase();
            const body = readJsonBody(init);

            let response: Response | null = null;
            if (url.hostname === 'sheets.googleapis.com') {
                response = routeSheetsApi(url.pathname, url, method, body);
            } else if (url.hostname === 'www.googleapis.com') {
                response = routeGoogleApis(url.pathname, method);
            }

            if (response) return response;
        } catch (error) {
            console.error('[demo] fetch-mock internal error:', error);
            return jsonResponse(500, { error: { code: 500, message: 'demo fetch-mock internal error' } });
        }

        console.warn(`[demo] 未対応の外部リクエストです（デモモードのため実ネットワークへは出ません）: ${rawUrl}`);
        return jsonResponse(404, { error: { code: 404, message: 'Demo mode: no network access for this endpoint' } });
    }) as typeof fetch;
}
