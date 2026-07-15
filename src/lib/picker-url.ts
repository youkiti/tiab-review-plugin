/** Google Picker 許可ページのURLを組み立てるヘルパー。 */
export const PICKER_PAGE_URL = 'https://youkiti.github.io/tiab-review-plugin/app/picker.html';

export interface PickerUrlOptions {
    baseUrl?: string;
    spreadsheetId?: string;
    email?: string;
}

/**
 * メールアドレスを配信サーバーのログへ残さないため、パラメータはクエリではなく
 * URLフラグメントで渡す。
 */
export function buildPickerUrl(spreadsheetId?: string, email?: string, baseUrl = PICKER_PAGE_URL): string {
    const params = new URLSearchParams();
    if (spreadsheetId) params.set('fileId', spreadsheetId);
    if (email) params.set('email', email);
    const hash = params.toString();
    return hash ? `${baseUrl}#${hash}` : baseUrl;
}
