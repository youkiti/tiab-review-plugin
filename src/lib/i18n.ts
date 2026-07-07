/**
 * i18n ヘルパーモジュール
 * プラットフォームアダプタの i18n メッセージ取得のラッパーとHTML翻訳ユーティリティ
 */
import { platform } from '../platform';

/**
 * 翻訳キーからメッセージを取得する
 * platform().getMessage のラッパー
 */
export function t(key: string, substitutions?: string | string[]): string {
    const subs = substitutions
        ? (Array.isArray(substitutions) ? substitutions : [substitutions])
        : undefined;
    let message: string;
    try {
        message = platform().getMessage(key, subs);
    } catch {
        // 非拡張環境(Node.js等) では platform 未初期化のため空扱いにし、
        // キー名フォールバックへ委ねる（client-version.ts と同じ方針）
        message = '';
    }
    // キーが見つからない場合はキー名をそのまま返す（デバッグ用）
    return message || key;
}

/**
 * HTML要素のdata-i18n属性を読み取り、テキストを翻訳で置き換える
 * - data-i18n="key" → textContent を翻訳
 * - data-i18n-placeholder="key" → placeholder属性を翻訳
 * - data-i18n-title="key" → title属性を翻訳
 * - data-i18n-html="key" → innerHTML を翻訳（HTML含む場合）
 * - data-i18n-tooltip="key" → カスタムツールチップ要素 (.help-tooltip) を子に挿入
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

    // ツールチップの翻訳（ヘルプアイコンの子要素として .help-tooltip を挿入）
    root.querySelectorAll<HTMLElement>('[data-i18n-tooltip]').forEach(el => {
        const key = el.getAttribute('data-i18n-tooltip');
        if (!key) return;
        const text = t(key);
        // 既存のツールチップ要素があれば一度除去（再翻訳対応）
        const existing = el.querySelector(':scope > .help-tooltip');
        if (existing) existing.remove();
        const tip = document.createElement('span');
        tip.className = 'help-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.textContent = text;
        el.appendChild(tip);
        el.setAttribute('aria-label', text);

        // <label>や折りたたみヘッダ内に置いた場合の誤クリック防止
        // （初回のみ登録）
        if (!el.dataset.tooltipInit) {
            el.dataset.tooltipInit = '1';
            el.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        }
    });
}
