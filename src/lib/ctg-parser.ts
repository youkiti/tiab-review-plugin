// ClinicalTrials.gov CSV パーサー

import type { Reference } from './types';
import { truncateAbstract, truncateField, generateDedupeKey } from './import-helpers';

/**
 * abstract に合成するカラムの順序定義
 * 主要情報（Python版と同一順序）を先頭に、追加情報を末尾に配置
 * データを落とさない方針
 */
const ABSTRACT_COLUMNS_PRIMARY = [
    'Conditions', 'Interventions', 'Primary Outcome Measures', 'Brief Summary',
    'Sex', 'Age', 'Study Type', 'Study Design',
];

const ABSTRACT_COLUMNS_SECONDARY = [
    'Acronym', 'Study Status', 'Study Results',
    'Secondary Outcome Measures', 'Other Outcome Measures',
    'Sponsor', 'Collaborators', 'Phases', 'Enrollment', 'Funder Type',
    'Other IDs', 'Primary Completion Date', 'Completion Date',
    'First Posted', 'Results First Posted', 'Last Update Posted',
    'Locations', 'Study Documents',
];

/** 専用フィールドにマッピングされるカラム（abstractには含めない） */
const MAPPED_COLUMNS = new Set([
    'NCT Number', 'Study Title', 'Study URL', 'Start Date',
]);

/**
 * RFC 4180 準拠の簡易 CSV パーサー
 * クォート内のカンマ・改行・ダブルクォートに対応
 */
function parseCSVContent(content: string): Record<string, string>[] {
    // BOM 除去
    const text = content.replace(/^\uFEFF/, '');

    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
        const char = text[i];

        if (inQuotes) {
            if (char === '"') {
                // ダブルクォートのエスケープ（""）
                if (i + 1 < text.length && text[i + 1] === '"') {
                    currentField += '"';
                    i += 2;
                } else {
                    // クォート終了
                    inQuotes = false;
                    i++;
                }
            } else {
                currentField += char;
                i++;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
                i++;
            } else if (char === ',') {
                currentRow.push(currentField);
                currentField = '';
                i++;
            } else if (char === '\r') {
                // \r\n または \r
                currentRow.push(currentField);
                currentField = '';
                rows.push(currentRow);
                currentRow = [];
                i++;
                if (i < text.length && text[i] === '\n') i++;
            } else if (char === '\n') {
                currentRow.push(currentField);
                currentField = '';
                rows.push(currentRow);
                currentRow = [];
                i++;
            } else {
                currentField += char;
                i++;
            }
        }
    }

    // 最後のフィールド・行を処理
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField);
        rows.push(currentRow);
    }

    if (rows.length < 2) return [];

    // ヘッダー行からカラム名を取得
    const headers = rows[0];
    const records: Record<string, string>[] = [];

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        // 空行スキップ
        if (row.length === 1 && row[0].trim() === '') continue;

        const record: Record<string, string> = {};
        for (let c = 0; c < headers.length; c++) {
            record[headers[c]] = (row[c] || '').trim();
        }
        records.push(record);
    }

    return records;
}

/**
 * CSV行からReferenceに変換
 */
function csvRowToReference(row: Record<string, string>, sourceFile?: string): Reference | null {
    const title = row['Study Title'];
    if (!title?.trim()) return null;

    const nctNumber = row['NCT Number']?.trim() || undefined;
    const url = row['Study URL']?.trim() || undefined;

    // Start Date から年を抽出
    const yearMatch = (row['Start Date'] || '').match(/\d{4}/);

    // abstract 合成（データを落とさない方針）
    const abstractParts: string[] = [];

    // 主要情報（Python版と同一順序）
    for (const col of ABSTRACT_COLUMNS_PRIMARY) {
        const val = row[col]?.trim();
        if (val) abstractParts.push(`${col}: ${val}`);
    }

    // 追加情報
    for (const col of ABSTRACT_COLUMNS_SECONDARY) {
        const val = row[col]?.trim();
        if (val) abstractParts.push(`${col}: ${val}`);
    }

    // 定義済みリストにないカラムも追加（将来のカラム追加に対応）
    const knownColumns = new Set([
        ...ABSTRACT_COLUMNS_PRIMARY,
        ...ABSTRACT_COLUMNS_SECONDARY,
        ...MAPPED_COLUMNS,
    ]);
    for (const col of Object.keys(row)) {
        if (!knownColumns.has(col)) {
            const val = row[col]?.trim();
            if (val) abstractParts.push(`${col}: ${val}`);
        }
    }

    const abstractText = abstractParts.join(' | ');

    return {
        ref_id: crypto.randomUUID(),
        title: truncateField(title.trim())!,
        abstract: truncateAbstract(abstractText || undefined),
        year: yearMatch ? parseInt(yearMatch[0], 10) : undefined,
        pmid: nctNumber,
        url: truncateField(url),
        journal: 'ClinicalTrials.gov',
        source: 'ClinicalTrials.gov',
        source_file: truncateField(sourceFile),
        imported_at: new Date().toISOString(),
        dedupe_key: generateDedupeKey(title.trim(), nctNumber, undefined),
        record_type: 'registration',
    };
}

/**
 * ClinicalTrials.gov CSV コンテンツをパースして Reference 配列に変換
 */
export function parseCTG(content: string, sourceFile?: string): Reference[] {
    const records = parseCSVContent(content);
    const references: Reference[] = [];

    for (const record of records) {
        const ref = csvRowToReference(record, sourceFile);
        if (ref) references.push(ref);
    }

    return references;
}

/**
 * ClinicalTrials.gov CSV ファイルをパース
 */
export async function parseCTGFile(file: File): Promise<Reference[]> {
    const content = await file.text();
    return parseCTG(content, file.name);
}

/**
 * CSVコンテンツが ClinicalTrials.gov 形式かどうかを判定
 * ヘッダーに "Study Title" カラムが含まれているかチェック
 */
export function isCTGFormat(content: string): boolean {
    const firstLine = content.split(/\r?\n/)[0] || '';
    return firstLine.includes('Study Title');
}
