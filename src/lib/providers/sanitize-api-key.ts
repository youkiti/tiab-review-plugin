// sanitize-api-key.ts - API キーを HTTP ヘッダーで送れる形に正規化する（プロバイダ共通）

/**
 * API キー文字列を HTTP ヘッダーで送れる形に正規化する。
 *
 * - 前後空白除去
 * - 不可視 Unicode（zero-width space, BOM 等）を除去
 * - ISO-8859-1 範囲外の文字が残れば例外（fetch がヘッダー構築で失敗する前にユーザー向けエラーへ）
 *
 * 想定ケース: ユーザーがブラウザの保存値や Markdown からコピペした際に
 * U+200B (ZWSP) や U+FEFF (BOM)、全角文字などが混入し、fetch が
 * "String contains non ISO-8859-1 code point." を投げる。
 *
 * @param providerLabel 例外文の先頭に付けるプロバイダ名（例: 'OpenRouter'）
 */
export function sanitizeApiKey(rawKey: string, providerLabel: string): string {
    let out = '';
    for (const ch of rawKey.trim()) {
        const cp = ch.codePointAt(0);
        if (cp === undefined) continue;
        // 不可視 Unicode を除去: ZWSP系/Word joiner/BOM/NBSP
        if (cp === 0x200B || cp === 0x200C || cp === 0x200D ||
            cp === 0x2060 || cp === 0xFEFF || cp === 0x00A0) continue;
        if (cp > 255) {
            // 送り直しても同じキーで必ず失敗するので、一括判定の再試行対象から外す。
            throw Object.assign(new Error(
                `${providerLabel} APIキーに ISO-8859-1 範囲外の文字が含まれています。`
                + 'APIキーカードで再入力してください（コピペ時に全角文字や不可視文字が混入した可能性があります）。'
            ), { retryable: false });
        }
        out += ch;
    }
    return out;
}
