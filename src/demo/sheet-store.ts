// デモモード用インメモリ「スプレッドシート」ストア
//
// Google Sheets API のレスポンス形状を模すため、シート名 → 行データ（ヘッダー行含む、
// 各行は string[]）の形で状態を保持し、A1形式のレンジ指定（"Sheet!A1:Z1" 等）を
// 解釈して読み書きする。fetch-mock.ts から呼び出される、副作用を持つ唯一のモジュール。
// ページセッション中は状態を保持するため、判定保存→再読込でも内容が残る。

/** ストア全体の状態。resetDemoStore() でのみ丸ごと差し替える */
interface DemoSheetState {
    title: string;
    /** シート名 → 行データ（0番目の要素がスプレッドシートの1行目 = ヘッダー行想定） */
    sheets: Map<string, string[][]>;
    /** シート名 → addSheet で払い出した sheetId（sheets.properties 一覧・addSheet応答用） */
    sheetIds: Map<string, number>;
    nextSheetId: number;
}

let store: DemoSheetState = {
    title: '',
    sheets: new Map(),
    sheetIds: new Map(),
    nextSheetId: 0,
};

/**
 * シード時にストア全体を初期化する（既存の状態は破棄する）。
 * 渡した行配列は複製して保持するため、呼び出し側が後から同じ配列を書き換えても
 * ストアの内容には影響しない。
 */
export function resetDemoStore(title: string, sheets: Record<string, string[][]>): void {
    const sheetsMap = new Map<string, string[][]>();
    const sheetIds = new Map<string, number>();
    let id = 0;
    for (const [name, rows] of Object.entries(sheets)) {
        sheetsMap.set(name, rows.map((row) => [...row]));
        sheetIds.set(name, id);
        id += 1;
    }
    store = { title, sheets: sheetsMap, sheetIds, nextSheetId: id };
}

export function getStoreSpreadsheetTitle(): string {
    return store.title;
}

export function hasSheet(name: string): boolean {
    return store.sheets.has(name);
}

/** スプレッドシートメタデータ（fields=sheets.properties）応答用の一覧 */
export function listSheets(): { title: string; sheetId: number }[] {
    return Array.from(store.sheets.keys()).map((title) => ({
        title,
        sheetId: store.sheetIds.get(title) ?? 0,
    }));
}

/**
 * シートを追加する（spreadsheets.batchUpdate の addSheet 相当）。
 * 既に同名シートがあれば何もせず既存の sheetId を返す（Google Sheets は本来エラーだが、
 * デモではヘッダー未整備時の「無ければ作る」再試行フローを壊さないための安全策）。
 */
export function addSheetToStore(title: string): number {
    const existing = store.sheetIds.get(title);
    if (existing !== undefined) return existing;
    const sheetId = store.nextSheetId;
    store.sheets.set(title, []);
    store.sheetIds.set(title, sheetId);
    store.nextSheetId += 1;
    return sheetId;
}

// ---------------------------------------------------------------------------
// A1形式レンジのパース
// ---------------------------------------------------------------------------

function columnLettersToNumber(letters: string): number {
    let result = 0;
    for (const ch of letters.toUpperCase()) {
        result = result * 26 + (ch.charCodeAt(0) - 64);
    }
    return result;
}

interface ParsedCell {
    col: number | null;
    row: number | null;
}

function parseCellRef(part: string): ParsedCell {
    const m = part.match(/^([A-Za-z]*)(\d*)$/);
    if (!m) return { col: null, row: null };
    const [, colLetters, rowDigits] = m;
    return {
        col: colLetters ? columnLettersToNumber(colLetters) : null,
        row: rowDigits ? parseInt(rowDigits, 10) : null,
    };
}

interface ParsedRange {
    sheet: string;
    colStart: number | null;
    colEnd: number | null;
    rowStart: number | null;
    rowEnd: number | null;
}

/**
 * "Sheet!A1:Z1" 形式のレンジをパースする。
 * - "!" が無い場合はシート名のみ（シート全体）とみなす
 * - 列・行の一方だけを省略した指定（"A:V" や "1:1"）にも対応する
 * - コロン無し単一セル（"B12"）にも対応する
 */
function parseA1Range(range: string): ParsedRange {
    const bangIndex = range.lastIndexOf('!');
    const sheet = bangIndex === -1 ? range : range.slice(0, bangIndex);
    const rangePart = bangIndex === -1 ? '' : range.slice(bangIndex + 1);
    if (!rangePart) {
        return { sheet, colStart: null, colEnd: null, rowStart: null, rowEnd: null };
    }
    const [startPart, endPart] = rangePart.split(':');
    const start = parseCellRef(startPart);
    const end = endPart !== undefined ? parseCellRef(endPart) : start;
    return { sheet, colStart: start.col, colEnd: end.col, rowStart: start.row, rowEnd: end.row };
}

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

/** 指定レンジの値を取得する。シートが存在しない場合は null（呼び出し側で404相当に変換する） */
export function readRange(range: string): string[][] | null {
    const parsed = parseA1Range(range);
    const rows = store.sheets.get(parsed.sheet);
    if (!rows) return null;

    const rowStart = parsed.rowStart ?? 1;
    const rowEnd = Math.min(parsed.rowEnd ?? rows.length, rows.length);
    if (rowStart > rowEnd) return [];

    const colStart = parsed.colStart ?? 1;
    return rows.slice(rowStart - 1, rowEnd).map((row) => {
        const colEnd = parsed.colEnd ?? row.length;
        return row.slice(colStart - 1, colEnd);
    });
}

/** 複数レンジをまとめて取得する（values:batchGet 相当）。いずれかのシートが無ければ null */
export function readRanges(ranges: string[]): string[][][] | null {
    const results: string[][][] = [];
    for (const range of ranges) {
        const values = readRange(range);
        if (values === null) return null;
        results.push(values);
    }
    return results;
}

/** 指定レンジへ値を書き込む（values.update / values:batchUpdate 相当）。シートが無ければ false */
export function writeRange(range: string, values: string[][]): boolean {
    const parsed = parseA1Range(range);
    const rows = store.sheets.get(parsed.sheet);
    if (!rows) return false;

    const rowStart = parsed.rowStart ?? 1;
    const colStart = parsed.colStart ?? 1;
    values.forEach((rowValues, i) => {
        const targetRowIndex = rowStart - 1 + i;
        while (rows.length <= targetRowIndex) rows.push([]);
        const row = rows[targetRowIndex];
        rowValues.forEach((cell, j) => {
            const targetColIndex = colStart - 1 + j;
            while (row.length <= targetColIndex) row.push('');
            row[targetColIndex] = cell === undefined || cell === null ? '' : String(cell);
        });
    });
    return true;
}

/**
 * 指定シートの末尾へ行を追記する（values.append 相当）。
 * 戻り値の firstRowIndex / lastRowIndex は追記した行のシート行番号（1始まり）。
 * シートが存在しない場合は null。
 */
export function appendRowsTo(
    sheetName: string,
    rowsToAppend: string[][]
): { firstRowIndex: number; lastRowIndex: number } | null {
    const rows = store.sheets.get(sheetName);
    if (!rows) return null;
    const firstRowIndex = rows.length + 1;
    rowsToAppend.forEach((row) => {
        rows.push(row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))));
    });
    return { firstRowIndex, lastRowIndex: rows.length };
}
