/**
 * JSON/文字列のBOM混入を吸収する共通ユーティリティ
 */

/**
 * 先頭のUTF-8 BOMを除去
 */
export function stripUtf8Bom(value: string | null | undefined): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/^\uFEFF+/, '');
}

/**
 * BOM混入を許容してJSONを安全にパース
 */
export function parseJsonWithBom<T>(value: string | null | undefined): T | null {
    const normalized = stripUtf8Bom(value);
    if (!normalized) {
        return null;
    }

    try {
        return JSON.parse(normalized) as T;
    } catch {
        return null;
    }
}
