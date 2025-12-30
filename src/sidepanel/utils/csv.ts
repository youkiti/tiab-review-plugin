/**
 * CSV処理ユーティリティ
 */

/**
 * CSVフィールドをエスケープ
 */
export function escapeCSVField(value: string): string {
    if (!value) return '';
    // ダブルクォートをエスケープし、特殊文字を含む場合は全体をクォート
    const escaped = value.replace(/"/g, '""');
    if (escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')) {
        return `"${escaped}"`;
    }
    return escaped;
}
