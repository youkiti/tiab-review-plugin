// デモモード用 fetch モック
//
// globalThis.fetch を丸ごと差し替え、Google Sheets API / Drive API / Gemini API /
// OAuth userinfo への呼び出しをすべてインメモリで処理する。
// chrome-extension:// 宛て（PDF.js のワーカー/CMap取得・同梱PDFフィクスチャ取得等）と
// 相対URLは実際の fetch へそのまま素通しし、それ以外の未対応な外部ホスト・エンドポイントは
// 404 を返して console.warn するだけに留め、実ネットワークには一切出ない。
//
// Issue #151（#150 工程0）チャンク2: 通信待ち・CPU処理・描画・保存の時間を切り分けて
// 計測できるよう、モックが処理した各リクエストのエンドポイント種別ごとの回数・応答バイト数を
// 集計し（globalThis.__tiabDemoNet）、?netDelay=<ms> で googleapis 宛の応答だけを
// 人為的に遅延できるようにする。詳細は下記「ネットワーク計測」セクション参照。

import {
    readRange,
    readRanges,
    writeRange,
    appendRowsTo,
    addSheetToStore,
    listSheets,
    getStoreSpreadsheetTitle,
} from './sheet-store';
import { buildDemoModelsListBody, buildStreamGenerateContentResponseText, buildDemoBatchProbeErrorBody } from './gemini-fixtures';
import {
    DEMO_SPREADSHEET_ID,
    DEMO_SPREADSHEET_TITLE,
    DEMO_USER_EMAIL,
    DEMO_COLLEAGUE_EMAIL,
    DEMO_SEED_TIMESTAMP,
    DEMO_FULLTEXT_DRIVE_FILE_ID,
    DEMO_FULLTEXT_PDF_RESOURCE_PATH,
} from './constants';

let installed = false;

/**
 * 保存失敗モード（Issue #151（#150 工程0）チャンク3a、Playwright計測シナリオ7
 * 「オフライン保存と再送」用）。
 * Playwright の context.setOffline(true) は使えない（デモモードは全 fetch を横取りするため、
 * 実ネットワークへ出ていく前にこのモックが応答を返してしまい、オフラインが再現できない）。
 * そのため保存失敗の再現はモック自身に切り替え口を持たせる。既定は 'none' で、既存のデモ・
 * 録画・スクリーンショットの挙動には一切影響しない。
 */
export type DemoNetFailureMode = 'none' | 'save';
let failureMode: DemoNetFailureMode = 'none';

/**
 * 応答バイト数を計測用に一時的に運ぶための内部専用ヘッダー名。
 * 実際の呼び出し元（src/lib/sheets/transport.ts 等）へ返す直前に必ず finalizeDemoResponse() で
 * 取り除く（呼び出し元からは今までどおり見えない）。
 * Response.clone().arrayBuffer() で読む案もあったが、それだと計測のためだけに
 * 追加の Promise を挟むことになり、応答本文の構築元（jsonResponse 等）で同期的に
 * バイト数が分かっているものをわざわざ非同期に読み直すことになるため採らなかった。
 */
const NET_BYTES_HEADER = 'X-Tiab-Demo-Bytes';

function jsonResponse(status: number, body: unknown): Response {
    const text = JSON.stringify(body);
    return new Response(text, {
        status,
        headers: {
            'Content-Type': 'application/json',
            [NET_BYTES_HEADER]: String(new TextEncoder().encode(text).length),
        },
    });
}

/**
 * 実APIの「シートが存在しない」エラーメッセージ文言に合わせて 400 を返す。
 * src/lib/sheets/ 側（transport.ts の isSheetMissingError() と各タブの ensure）がこの文言（"Unable to parse range"）を見てシート作成の
 * 再試行フローに分岐するため、文言を変えないこと。
 */
function notFoundRange(range: string): Response {
    return jsonResponse(400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
}

function unknownSpreadsheet(): Response {
    return jsonResponse(404, { error: { code: 404, message: 'Requested entity was not found.' } });
}

/**
 * 保存失敗モード（'save'）中に Sheets の書き込み系エンドポイント
 * （values:append / values:update / values:batchUpdate）が返す応答。
 * メッセージ文言は src/lib/save-failure.ts の AUTH_ERROR_PATTERN（401/unauthorized/
 * credentials/token 等）に一致する語を含めないこと。一致すると「認証エラー」に誤分類され、
 * 再ログイン導線（ensureInteractiveAuth）に乗ってからキューへ退避する余計な一往復が発生する。
 */
function demoServiceUnavailable(): Response {
    return jsonResponse(503, { error: { code: 503, message: 'Demo mode: simulated save failure (values write)' } });
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
    if (failureMode === 'save') return demoServiceUnavailable();
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
    if (failureMode === 'save') return demoServiceUnavailable();
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
    if (failureMode === 'save') return demoServiceUnavailable();
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

/** 共有ダイアログ用の共有権限（インメモリ）。resetDemoDrivePermissions() でシードし直す */
interface DemoPermission {
    id: string;
    role: 'owner' | 'writer' | 'reader';
    type: 'user';
    emailAddress: string;
    displayName: string;
}

let demoPermissions: DemoPermission[] = [];
let nextDemoPermissionId = 1;

/**
 * 共有ダイアログのデモ用に、デモユーザー(owner) + 同僚(writer) の2件で初期化する。
 * install 時に1回だけ呼ぶ（installDemoFetchMock は多重インストールされない前提）。
 */
function resetDemoDrivePermissions(): void {
    demoPermissions = [
        {
            id: 'demo-owner-permission',
            role: 'owner',
            type: 'user',
            emailAddress: DEMO_USER_EMAIL,
            displayName: 'デモ 太郎',
        },
        {
            id: 'demo-colleague-permission',
            role: 'writer',
            type: 'user',
            emailAddress: DEMO_COLLEAGUE_EMAIL,
            displayName: '同僚 花子',
        },
    ];
    nextDemoPermissionId = 1;
}

/** 拡張バンドル同梱のデモPDFをバイト列で取得する（chrome-extension:// URLはisPassthroughUrlで実fetchへ流れる） */
async function fetchBundledDemoPdfBytes(): Promise<ArrayBuffer> {
    const resourceUrl = chrome.runtime.getURL(DEMO_FULLTEXT_PDF_RESOURCE_PATH);
    const response = await fetch(resourceUrl);
    return response.arrayBuffer();
}

/** Drive files.get?alt=media（PDFバイナリ取得）の応答を組み立てる */
async function handleDriveMediaDownload(fileId: string): Promise<Response> {
    if (fileId !== DEMO_FULLTEXT_DRIVE_FILE_ID) {
        return jsonResponse(404, { error: { code: 404, message: 'File not found' } });
    }
    try {
        const bytes = await fetchBundledDemoPdfBytes();
        return new Response(bytes, {
            status: 200,
            headers: {
                'Content-Type': 'application/pdf',
                [NET_BYTES_HEADER]: String(bytes.byteLength),
            },
        });
    } catch (error) {
        console.error('[demo] デモPDFフィクスチャの読み込みに失敗しました:', error);
        return jsonResponse(500, { error: { code: 500, message: 'demo pdf fixture load failed' } });
    }
}

/** Drive permissions.create（共有追加）の応答を組み立てる */
function handleAddPermission(fileId: string, body: any): Response {
    if (fileId !== DEMO_SPREADSHEET_ID) return jsonResponse(404, { error: { code: 404, message: 'File not found' } });
    const emailAddress: string = typeof body?.emailAddress === 'string' ? body.emailAddress : '';
    const role: DemoPermission['role'] = body?.role === 'reader' ? 'reader' : 'writer';
    const id = `demo-permission-${nextDemoPermissionId}`;
    nextDemoPermissionId += 1;
    demoPermissions.push({ id, role, type: 'user', emailAddress, displayName: emailAddress });
    return jsonResponse(200, { id, role, type: 'user', emailAddress });
}

/** Drive permissions.delete（共有解除）の応答を組み立てる */
function handleDeletePermission(fileId: string, permissionId: string): Response {
    if (fileId !== DEMO_SPREADSHEET_ID) return jsonResponse(404, { error: { code: 404, message: 'File not found' } });
    demoPermissions = demoPermissions.filter((p) => p.id !== permissionId);
    return jsonResponse(200, {});
}

function routeGoogleApis(pathname: string, url: URL, method: string, body: any): Response | null | Promise<Response | null> {
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
        const fileId = decodeURIComponent(permMatch[1]);
        if (method === 'GET') {
            if (fileId !== DEMO_SPREADSHEET_ID) return jsonResponse(200, { permissions: [] });
            // sendNotificationEmail / emailMessage クエリは通知メール送信の指示なので、
            // デモ（実ネットワークに出ない）では単に無視する。
            return jsonResponse(200, { permissions: demoPermissions });
        }
        if (method === 'POST') return handleAddPermission(fileId, body);
        return null;
    }

    const permDeleteMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/);
    if (permDeleteMatch) {
        if (method !== 'DELETE') return null;
        return handleDeletePermission(decodeURIComponent(permDeleteMatch[1]), decodeURIComponent(permDeleteMatch[2]));
    }

    const fileMatch = pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fileMatch) {
        if (method !== 'GET') return null;
        const fileId = decodeURIComponent(fileMatch[1]);
        if (url.searchParams.get('alt') === 'media') {
            return handleDriveMediaDownload(fileId);
        }
        return jsonResponse(200, { capabilities: { canEdit: true, canShare: true } });
    }

    return null;
}

// ============================================================
// Gemini API（generativelanguage.googleapis.com）
// ============================================================

/**
 * `/v1beta/models`、`/v1beta/models/{model}:streamGenerateContent`、
 * `/v1beta/models/{model}:batchGenerateContent`（tier プローブ）に対応する。
 * APIキーの値そのものは一切検証しない（デモでは何を入力しても通す）。
 */
function routeGeminiApi(pathname: string, method: string, body: any): Response | null {
    if (pathname === '/v1beta/models') {
        if (method !== 'GET') return null;
        return jsonResponse(200, buildDemoModelsListBody());
    }

    const streamMatch = pathname.match(/^\/v1beta\/models\/([^:]+):streamGenerateContent$/);
    if (streamMatch) {
        if (method !== 'POST') return null;
        const modelId = decodeURIComponent(streamMatch[1]);
        const responseText = buildStreamGenerateContentResponseText(body, modelId);
        return new Response(responseText, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                [NET_BYTES_HEADER]: String(new TextEncoder().encode(responseText).length),
            },
        });
    }

    // gemini-api.ts の detectTierByBatchProbe() が投げる tier 判定プローブ。
    // 常に「有料キー」の実測シグネチャを返す（デモを低速モードに落とさないため）。
    const batchMatch = pathname.match(/^\/v1beta\/models\/([^:]+):batchGenerateContent$/);
    if (batchMatch) {
        if (method !== 'POST') return null;
        return jsonResponse(400, buildDemoBatchProbeErrorBody());
    }

    return null;
}

// ============================================================
// ネットワーク計測（Issue #151（#150 工程0）チャンク2）
// ============================================================
//
// 工程0の完了条件「通信待ち・CPU処理・描画・保存の時間を区別できること」と、親Issue #150の
// 「API回数・転送量」の計測に使う。モックが処理した（=実際にルーティングされた、または
// 未対応で404を返した）各リクエストについて、エンドポイント種別ごとの回数・応答バイト数を
// 集計する。chrome-extension:// 宛て・相対URLの素通し経路（isPassthroughUrl）はモックが
// 処理したリクエストではないため集計に含めない。

interface NetEndpointStat {
    count: number;
    bytes: number;
}

let netTotalRequests = 0;
let netTotalResponseBytes = 0;
const netByEndpoint = new Map<string, NetEndpointStat>();

function resetNetStats(): void {
    netTotalRequests = 0;
    netTotalResponseBytes = 0;
    netByEndpoint.clear();
}

function recordNetSample(label: string, bytes: number): void {
    netTotalRequests += 1;
    netTotalResponseBytes += bytes;
    const existing = netByEndpoint.get(label);
    if (existing) {
        existing.count += 1;
        existing.bytes += bytes;
    } else {
        netByEndpoint.set(label, { count: 1, bytes });
    }
}

interface TiabDemoNetSnapshot {
    totalRequests: number;
    totalResponseBytes: number;
    byEndpoint: Record<string, NetEndpointStat>;
}

function netSnapshot(): TiabDemoNetSnapshot {
    const byEndpoint: Record<string, NetEndpointStat> = {};
    netByEndpoint.forEach((stat, label) => {
        byEndpoint[label] = { count: stat.count, bytes: stat.bytes };
    });
    return {
        totalRequests: netTotalRequests,
        totalResponseBytes: netTotalResponseBytes,
        byEndpoint,
    };
}

interface TiabDemoNetInterface {
    snapshot: () => TiabDemoNetSnapshot;
    reset: () => void;
    /**
     * Issue #151（#150 工程0）チャンク3a: 保存失敗モードの切り替え（既定 'none'）。
     * 'save' の間は Sheets の書き込み系エンドポイント（values:append / values:update /
     * values:batchUpdate）だけが 503 を返す。読み取り・Drive・Gemini は通常どおり。
     */
    setFailureMode: (mode: DemoNetFailureMode) => void;
    /** 現在の保存失敗モードを返す（テスト・診断用）。 */
    getFailureMode: () => DemoNetFailureMode;
}

declare global {
    // Playwright/DevTools からベンチマーク集計を読み出すための最小限のグローバル公開口。
    // eslint-disable-next-line no-var
    var __tiabDemoNet: TiabDemoNetInterface | undefined;
}

/**
 * "References!A1:AA1" -> "References" のように、レンジ文字列からシート名だけを取り出す。
 * クォート付きシート名（'Sheet Name'!A1）は先頭・末尾の「'」を落とす。
 */
function sheetNameFromRangeSegment(segment: string): string {
    const bangIdx = segment.indexOf('!');
    const sheetPart = bangIdx === -1 ? segment : segment.slice(0, bangIdx);
    return sheetPart.replace(/^'|'$/g, '');
}

/**
 * リクエストURLをそのままキーにもログにも出さない（URLにはAPIキーやトークンが載りうるため。
 * 本番コード（バッチ処理のURLをログに出さない方針）と同じ流儀をデモモックでも踏襲する）。
 * メソッド＋API種別＋（sheets.values系のみ）対象シート名までに削ったラベルだけを持つ。
 * 行番号・列指定（A1:AA1 等）は落とし、シート名だけ残す。
 */
function classifyDemoRequest(url: URL, method: string): string {
    if (url.hostname === 'sheets.googleapis.com') {
        const prefix = '/v4/spreadsheets/';
        if (!url.pathname.startsWith(prefix)) return `${method} sheets.unknown`;
        const rest = url.pathname.slice(prefix.length);

        if (rest.endsWith(':batchUpdate') && !rest.includes('/values')) {
            return `${method} sheets.batchUpdate`;
        }

        const valuesMarker = '/values';
        const valuesIdx = rest.indexOf(valuesMarker);
        if (valuesIdx === -1) return `${method} sheets.metadata`;

        const tail = rest.slice(valuesIdx + valuesMarker.length);
        if (tail === ':batchGet') return `${method} sheets.values.batchGet`;
        if (tail === ':batchUpdate') return `${method} sheets.values.batchUpdate`;
        if (tail.startsWith('/')) {
            const rawSegment = decodeURIComponent(tail.slice(1));
            if (rawSegment.endsWith(':append')) {
                const sheetName = sheetNameFromRangeSegment(rawSegment.slice(0, -':append'.length));
                return `${method} sheets.values.append:${sheetName}`;
            }
            const sheetName = sheetNameFromRangeSegment(rawSegment);
            return `${method} sheets.values:${sheetName}`;
        }
        return `${method} sheets.unknown`;
    }

    if (url.hostname === 'www.googleapis.com') {
        if (url.pathname === '/oauth2/v3/userinfo') return `${method} oauth2.userinfo`;
        if (url.pathname === '/drive/v3/files') return `${method} drive.files.list`;
        if (/^\/drive\/v3\/files\/[^/]+\/permissions/.test(url.pathname)) return `${method} drive.permissions`;
        if (/^\/drive\/v3\/files\/[^/]+$/.test(url.pathname)) {
            return url.searchParams.get('alt') === 'media' ? `${method} drive.files.media` : `${method} drive.files.get`;
        }
        return `${method} drive.unknown`;
    }

    if (url.hostname === 'generativelanguage.googleapis.com') {
        if (url.pathname === '/v1beta/models') return `${method} gemini.models.list`;
        if (/:streamGenerateContent$/.test(url.pathname)) return `${method} gemini.streamGenerateContent`;
        if (/:batchGenerateContent$/.test(url.pathname)) return `${method} gemini.batchGenerateContent`;
        return `${method} gemini.unknown`;
    }

    return `${method} unmatched`;
}

/** ?netDelay=<ms>（既定 0）。数値として解釈できない値・0以下は 0（遅延なし）扱い。 */
function resolveNetDelayMs(): number {
    if (typeof location === 'undefined') return 0;
    const raw = new URLSearchParams(location.search).get('netDelay');
    if (raw === null) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * 返却直前の共通処理: 計測用ヘッダーを読んで記録・除去し、必要なら googleapis 宛の応答だけ
 * 人為的に遅延させる。netDelayMs===0（既定）のときは Promise を新たに作らず response を
 * そのまま同期的に返す（既存のデモ・録画・スクリーンショットの挙動を変えないため）。
 */
function finalizeDemoResponse(url: URL, method: string, response: Response, netDelayMs: number): Response | Promise<Response> {
    const bytesHeader = response.headers.get(NET_BYTES_HEADER);
    response.headers.delete(NET_BYTES_HEADER);
    const bytes = bytesHeader !== null ? Number(bytesHeader) : 0;
    recordNetSample(classifyDemoRequest(url, method), Number.isFinite(bytes) ? bytes : 0);

    if (netDelayMs > 0 && url.hostname.endsWith('googleapis.com')) {
        return new Promise((resolve) => setTimeout(() => resolve(response), netDelayMs));
    }
    return response;
}

// ============================================================
// インストール
// ============================================================

export function installDemoFetchMock(): void {
    if (installed) return;
    installed = true;
    resetDemoDrivePermissions();
    resetNetStats();

    const netDelayMs = resolveNetDelayMs();
    globalThis.__tiabDemoNet = {
        snapshot: netSnapshot,
        reset: resetNetStats,
        setFailureMode: (mode) => { failureMode = mode; },
        getFailureMode: () => failureMode,
    };

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
                response = await routeGoogleApis(url.pathname, url, method, body);
            } else if (url.hostname === 'generativelanguage.googleapis.com') {
                response = routeGeminiApi(url.pathname, method, body);
            }

            if (response) return finalizeDemoResponse(url, method, response, netDelayMs);

            console.warn(`[demo] 未対応の外部リクエストです（デモモードのため実ネットワークへは出ません）: ${rawUrl}`);
            return finalizeDemoResponse(url, method, jsonResponse(404, { error: { code: 404, message: 'Demo mode: no network access for this endpoint' } }), netDelayMs);
        } catch (error) {
            console.error('[demo] fetch-mock internal error:', error);
            return jsonResponse(500, { error: { code: 500, message: 'demo fetch-mock internal error' } });
        }
    }) as typeof fetch;
}
