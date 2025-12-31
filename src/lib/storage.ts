// storage.ts - ローカルストレージ管理（APIキー等）

const GEMINI_API_KEY_STORAGE_KEY = 'gemini_api_key';
const GEMINI_API_KEY_SAVE_PREFERENCE = 'gemini_api_key_save_preference';
const GEMINI_API_KEY_SALT_KEY = 'gemini_api_key_salt';

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) {
        binary += String.fromCharCode(b);
    }
    return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function getOrCreateSalt(): Promise<Uint8Array> {
    const result = await chrome.storage.local.get([GEMINI_API_KEY_SALT_KEY]);
    const existing = result[GEMINI_API_KEY_SALT_KEY];
    if (typeof existing === 'string' && existing.length > 0) {
        return base64ToBytes(existing);
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    await chrome.storage.local.set({ [GEMINI_API_KEY_SALT_KEY]: bytesToBase64(salt) });
    return salt;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const secret = chrome.runtime.id;
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt as BufferSource,
            iterations: 100000,
            hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptApiKey(apiKey: string): Promise<string> {
    const salt = await getOrCreateSalt();
    const key = await deriveKey(salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(apiKey)
    );

    const payload = {
        v: 1,
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(ciphertext)),
    };
    return JSON.stringify(payload);
}

async function decryptApiKey(encoded: string): Promise<string> {
    const parsed = JSON.parse(encoded) as { v: number; iv: string; data: string };
    if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.data) {
        throw new Error('Invalid encrypted payload');
    }

    const salt = await getOrCreateSalt();
    const key = await deriveKey(salt);
    const iv = base64ToBytes(parsed.iv);
    const data = base64ToBytes(parsed.data);

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        data as BufferSource
    );
    return new TextDecoder().decode(plaintext);
}

/**
 * Gemini APIキーを保存
 */
export async function saveGeminiApiKey(apiKey: string): Promise<void> {
    const encoded = await encryptApiKey(apiKey);
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
        return await decryptApiKey(encoded);
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

// API Tier関連

import type { ApiTier } from './types';

const GEMINI_API_TIER_KEY = 'gemini_api_tier';

/**
 * セッション用のAPI tier（メモリ保持）
 */
let sessionApiTier: ApiTier | null = null;

/**
 * API tierを保存
 */
export async function saveApiTier(tier: ApiTier): Promise<void> {
    await chrome.storage.local.set({ [GEMINI_API_TIER_KEY]: tier });
    sessionApiTier = tier;
}

/**
 * API tierを取得
 */
export async function getApiTier(): Promise<ApiTier | null> {
    // セッションtierがあればそれを返す
    if (sessionApiTier) {
        return sessionApiTier;
    }
    const result = await chrome.storage.local.get([GEMINI_API_TIER_KEY]);
    return result[GEMINI_API_TIER_KEY] as ApiTier | null;
}

/**
 * セッション用API tierを設定
 */
export function setSessionApiTier(tier: ApiTier): void {
    sessionApiTier = tier;
}

/**
 * セッション用API tierを取得
 */
export function getSessionApiTier(): ApiTier | null {
    return sessionApiTier;
}

/**
 * API tierをクリア
 */
export async function clearApiTier(): Promise<void> {
    await chrome.storage.local.remove([GEMINI_API_TIER_KEY]);
    sessionApiTier = null;
}
