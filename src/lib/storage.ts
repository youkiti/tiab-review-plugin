// storage.ts - ローカルストレージ管理（APIキー等）

const GEMINI_API_KEY_STORAGE_KEY = 'gemini_api_key';
const GEMINI_API_KEY_SAVE_PREFERENCE = 'gemini_api_key_save_preference';

/**
 * 簡易的なエンコード（Base64 + 簡単な難読化）
 * 注: これはセキュリティ目的ではなく、ストレージを覗いた時に
 * 平文で見えないようにするための措置です
 */
function encodeApiKey(apiKey: string): string {
    // 文字列を反転してからBase64エンコード
    const reversed = apiKey.split('').reverse().join('');
    return btoa(reversed);
}

/**
 * デコード
 */
function decodeApiKey(encoded: string): string {
    const reversed = atob(encoded);
    return reversed.split('').reverse().join('');
}

/**
 * Gemini APIキーを保存
 */
export async function saveGeminiApiKey(apiKey: string): Promise<void> {
    const encoded = encodeApiKey(apiKey);
    await chrome.storage.local.set({ [GEMINI_API_KEY_STORAGE_KEY]: encoded });
}

/**
 * Gemini APIキーを取得
 */
export async function getGeminiApiKey(): Promise<string | null> {
    const result = await chrome.storage.local.get([GEMINI_API_KEY_STORAGE_KEY]);
    const encoded = result[GEMINI_API_KEY_STORAGE_KEY];
    if (!encoded) return null;
    try {
        return decodeApiKey(encoded);
    } catch {
        return null;
    }
}

/**
 * Gemini APIキーを削除
 */
export async function removeGeminiApiKey(): Promise<void> {
    await chrome.storage.local.remove([GEMINI_API_KEY_STORAGE_KEY]);
}

/**
 * APIキーが保存されているか確認
 */
export async function hasGeminiApiKey(): Promise<boolean> {
    const key = await getGeminiApiKey();
    return key !== null && key.length > 0;
}

/**
 * APIキー保存設定を保存
 * @param save true = 端末に保存する、false = 毎回入力
 */
export async function setApiKeySavePreference(save: boolean): Promise<void> {
    await chrome.storage.local.set({ [GEMINI_API_KEY_SAVE_PREFERENCE]: save });
}

/**
 * APIキー保存設定を取得
 */
export async function getApiKeySavePreference(): Promise<boolean> {
    const result = await chrome.storage.local.get([GEMINI_API_KEY_SAVE_PREFERENCE]);
    // デフォルトはfalse（毎回入力）
    return result[GEMINI_API_KEY_SAVE_PREFERENCE] === true;
}

/**
 * セッション用のAPIキー（保存しない場合のメモリ保持用）
 */
let sessionApiKey: string | null = null;

/**
 * セッション用APIキーを設定（保存しない場合）
 */
export function setSessionApiKey(apiKey: string): void {
    sessionApiKey = apiKey;
}

/**
 * セッション用APIキーを取得
 */
export function getSessionApiKey(): string | null {
    return sessionApiKey;
}

/**
 * セッション用APIキーをクリア
 */
export function clearSessionApiKey(): void {
    sessionApiKey = null;
}

/**
 * 有効なAPIキーを取得（保存されているか、セッションに設定されているか）
 */
export async function getEffectiveApiKey(): Promise<string | null> {
    // まずセッションキーを確認
    if (sessionApiKey) {
        return sessionApiKey;
    }
    // 次に保存されているキーを確認
    return await getGeminiApiKey();
}
