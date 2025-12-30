/**
 * テキスト処理ユーティリティ
 */

/**
 * HTML エスケープ
 */
export function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 正規表現のエスケープ
 */
export function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * スマートな正規表現作成（英単語は完全一致、それ以外は部分一致）
 */
export function createSmartRegex(keyword: string): RegExp {
    const escaped = escapeRegex(keyword);

    // 英単語のみの場合、単語境界を使用
    if (/^[a-zA-Z0-9]+$/.test(keyword)) {
        return new RegExp(`\\b${escaped}\\b`, 'gi');
    }

    // それ以外は部分一致
    return new RegExp(escaped, 'gi');
}
