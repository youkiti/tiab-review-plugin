// api-key-store.ts - API キーの暗号化保存（プロバイダ共通）
//
// 保存キー名・保存設定のキー名・ソルトのキー名・暗号文の形式（{ v: 1, iv, data }）は既存利用者の
// 保存済みキーを読むために固定されている。変えると復号できなくなるため、変更しない。
// chrome.storage.local は platform() を介さず直接使う（Web 版に API キーの画面は無い）。

/**
 * 暗号化ソルトの保存キー。全プロバイダで共用する
 * （chrome.runtime.id 由来でデバイス固有のため、鍵を分けるメリットがなく管理コストが増える）。
 */
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

export interface ApiKeyStoreDefinition {
    /** chrome.storage.local の保存キー（既存のキー名をそのまま渡す。変えない） */
    storageKey: string;
    /** 保存設定（端末に保存するか）の保存キー */
    savePreferenceKey: string;
    /** Node 実行時（実験・テスト）に読む環境変数名 */
    envVar: string;
}

export interface ApiKeyStore {
    /** 暗号化して端末に保存 */
    saveKey(apiKey: string): Promise<void>;
    /** 保存値を復号して取得。未保存・復号失敗は null（例外を投げない） */
    getKey(): Promise<string | null>;
    removeKey(): Promise<void>;
    hasKey(): Promise<boolean>;
    /** @param save true = 端末に保存する、false = 毎回入力 */
    setSavePreference(save: boolean): Promise<void>;
    /** 既定は false（毎回入力） */
    getSavePreference(): Promise<boolean>;
    /** セッション用のキー（保存しない場合のメモリ保持用）を設定 */
    setSessionKey(apiKey: string): void;
    getSessionKey(): string | null;
    clearSessionKey(): void;
    /** 有効なキーを取得（セッション > 環境変数 > 保存値） */
    getEffectiveKey(): Promise<string | null>;
}

/**
 * API キー1つ分の保存処理を作る。メソッドは this を使わないので、分割代入して単独の関数として呼べる。
 * セッションのキーは作った store ごとに別の変数で持つ。
 */
export function createApiKeyStore(def: ApiKeyStoreDefinition): ApiKeyStore {
    const { storageKey, savePreferenceKey, envVar } = def;
    let sessionKey: string | null = null;

    async function saveKey(apiKey: string): Promise<void> {
        const encoded = await encryptApiKey(apiKey);
        await chrome.storage.local.set({ [storageKey]: encoded });
    }

    async function getKey(): Promise<string | null> {
        const result = await chrome.storage.local.get([storageKey]);
        const encoded = result[storageKey];
        if (!encoded) return null;
        try {
            return await decryptApiKey(encoded);
        } catch {
            return null;
        }
    }

    async function removeKey(): Promise<void> {
        await chrome.storage.local.remove([storageKey]);
    }

    async function hasKey(): Promise<boolean> {
        const key = await getKey();
        return key !== null && key.length > 0;
    }

    async function setSavePreference(save: boolean): Promise<void> {
        await chrome.storage.local.set({ [savePreferenceKey]: save });
    }

    async function getSavePreference(): Promise<boolean> {
        const result = await chrome.storage.local.get([savePreferenceKey]);
        return result[savePreferenceKey] === true;
    }

    function setSessionKey(apiKey: string): void {
        sessionKey = apiKey;
    }

    function getSessionKey(): string | null {
        return sessionKey;
    }

    function clearSessionKey(): void {
        sessionKey = null;
    }

    async function getEffectiveKey(): Promise<string | null> {
        if (sessionKey) {
            return sessionKey;
        }
        // Node.js 実行時（ローカル実験・テスト）の環境変数
        const isNodeEnv = typeof process !== 'undefined' && process.versions && process.versions.node;
        if (isNodeEnv) {
            if (process.env[envVar]) {
                return process.env[envVar] as string;
            }
        }
        // types/chrome があるため、chrome オブジェクト自体の存在チェックが必要
        if (typeof chrome === 'undefined' || !chrome.storage) {
            return null;
        }
        return await getKey();
    }

    return {
        saveKey, getKey, removeKey, hasKey,
        setSavePreference, getSavePreference,
        setSessionKey, getSessionKey, clearSessionKey,
        getEffectiveKey,
    };
}
