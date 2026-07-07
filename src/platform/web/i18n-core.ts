/**
 * i18n の純粋ロジック部分（Node からもテスト可能なように、
 * JSON の import や navigator への参照を含めない）。
 */

/** chrome.i18n.getMessage の messages.json エントリ相当の型 */
export type Entry = { message: string; placeholders?: Record<string, { content: string }> };
/** messages.json 全体（キー → エントリ）相当の型 */
export type Messages = Record<string, Entry>;

/**
 * chrome.i18n.getMessage 互換のメッセージ解決（純粋関数）。
 * lang を優先し、無ければ fallback を参照する。プレースホルダ ($name$) を substitutions で置換。
 */
export function resolveMessage(lang: Messages, fallback: Messages, key: string, substitutions: string[] = []): string {
    const entry = lang[key] ?? fallback[key];
    if (!entry) return '';
    let msg = entry.message;
    if (entry.placeholders) {
        for (const [name, def] of Object.entries(entry.placeholders)) {
            // content は "$1" 形式。プレースホルダ名は大文字小文字を区別しない。
            const idx = parseInt(def.content.replace('$', ''), 10) - 1;
            const value = substitutions[idx] ?? '';
            msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
        }
    }
    return msg;
}
