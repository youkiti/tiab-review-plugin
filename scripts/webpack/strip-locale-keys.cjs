'use strict';

// なぜ: Web 版（docs/app/）は拡張機能専用のフルテキスト判定ページ（src/fulltext/fulltext.ts）
// を持たないが、src/platform/web/i18n.ts が _locales/{ja,en}/messages.json を丸ごと import して
// バンドルに同梱していたため、同ページ専用の `ftPage_*` キー（各108件）の分だけ初期JSが増え、
// bundle-budget（scripts/check-bundle-budget.mjs）を超過した（PR #207）。このファイルは
// webpack.config.js の buildWebConfig 専用の JSON parser rule から呼ばれ、Web 版に同梱する
// messages.json から拡張専用キーだけを機械的に落とす。拡張版（buildExtensionConfig）は
// このファイルを経由しないため、全キーがそのまま同梱される。

/**
 * Web 版バンドルに同梱しないキーの接頭辞。
 * 現在はフルテキスト判定ページ専用の `ftPage_` のみ。将来 ML/LLM 設定画面など、他の
 * 拡張専用画面のキーが増えたときにここへ追記できるよう配列にしてある。
 */
const WEB_EXCLUDED_KEY_PREFIXES = ['ftPage_'];

/**
 * messages（chrome.i18n 形式の messages.json をパースしたオブジェクト）から、
 * prefixes のいずれかで始まるキーを除いた新しいオブジェクトを返す純粋関数。
 * 入力オブジェクトは変更せず、残るキーの順序は元のまま保つ。
 *
 * @param {Record<string, unknown>} messages
 * @param {string[]} [prefixes]
 * @returns {Record<string, unknown>}
 */
function stripLocaleKeys(messages, prefixes = WEB_EXCLUDED_KEY_PREFIXES) {
    const result = {};
    for (const [key, value] of Object.entries(messages)) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
        result[key] = value;
    }
    return result;
}

module.exports = { WEB_EXCLUDED_KEY_PREFIXES, stripLocaleKeys };
