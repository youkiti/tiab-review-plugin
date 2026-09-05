// codecs.ts - References / Decisions タブのシート値（string[][]）とオブジェクトの相互変換
//
// Issue #153（sheets-api.ts の分割）で src/lib/sheets-api.ts から機械的に
// 切り出した。通信層は ./transport、シート定義は ./schema を参照。
// ここに置く関数は string[][] とオブジェクトの純変換のみで、通信・platform・DOM に依存しない。

import type { Reference, Decision } from '../types';

/**
 * References タブのシート値を Reference[] に変換
 */
export function parseReferenceValues(values: string[][]): Reference[] {
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
 * Decisions タブのシート値を判定一覧に変換
 */
export function parseDecisionValues(values: string[][]): { decision: Decision; rowIndex: number }[] {
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
