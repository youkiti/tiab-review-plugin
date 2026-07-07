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
            // まず名前付きプレースホルダを content（"$1" 形式）へ展開する。
            // プレースホルダ名は大文字小文字を区別しない。置換値の $ が特殊解釈
            // されないよう関数形式で置換する。
            msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), () => def.content);
        }
    }
    // chrome.i18n.getMessage は placeholders 定義が無い $1〜$9 も substitutions で
    // 直接置換し、$$ はリテラル $ になる。同じ挙動を1パスで再現する。
    return msg.replace(/\$(\$|[1-9])/g, (_match, d: string) =>
        d === '$' ? '$' : (substitutions[Number(d) - 1] ?? ''));
}
