/**
 * i18n ヘルパーモジュール
 * chrome.i18n API のラッパーとHTML翻訳ユーティリティ
 */

/**
 * 翻訳キーからメッセージを取得する
 * chrome.i18n.getMessage のラッパー
 */
export function t(key: string, substitutions?: string | string[]): string {
    const subs = substitutions
        ? (Array.isArray(substitutions) ? substitutions : [substitutions])
        : undefined;
    const message = chrome.i18n.getMessage(key, subs);
    // キーが見つからない場合はキー名をそのまま返す（デバッグ用）
    return message || key;
}

/**
 * HTML要素のdata-i18n属性を読み取り、テキストを翻訳で置き換える
 * - data-i18n="key" → textContent を翻訳
 * - data-i18n-placeholder="key" → placeholder属性を翻訳
 * - data-i18n-title="key" → title属性を翻訳
 * - data-i18n-html="key" → innerHTML を翻訳（HTML含む場合）
 */
export function localizeHtml(root: Document | HTMLElement = document): void {
    // textContent の翻訳
    root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) {
            el.textContent = t(key);
        }
    });

    // placeholder の翻訳
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) {
            (el as HTMLInputElement).placeholder = t(key);
        }
    });

    // title の翻訳
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (key) {
            (el as HTMLElement).title = t(key);
        }
    });

    // innerHTML の翻訳
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html');
        if (key) {
            el.innerHTML = t(key);
        }
    });
}
