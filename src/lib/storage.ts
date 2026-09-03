// storage.ts - ローカルストレージ管理（APIキー等）

import { platform } from '../platform';
import { parseScreeningPosition, type ScreeningPosition } from './screening-position';

const GEMINI_API_KEY_STORAGE_KEY = 'gemini_api_key';
const GEMINI_API_KEY_SAVE_PREFERENCE = 'gemini_api_key_save_preference';
const GEMINI_API_KEY_SALT_KEY = 'gemini_api_key_salt';

// OpenRouter（追加プロバイダ）。暗号化ソルトは Gemini と同じ鍵を流用する
// （chrome.runtime.id 由来でデバイス固有のため、鍵を分けるメリットがなく管理コストが増える）。
const OPENROUTER_API_KEY_STORAGE_KEY = 'openrouter_api_key';
const OPENROUTER_API_KEY_SAVE_PREFERENCE = 'openrouter_api_key_save_preference';

// ユーザーが手動追加した OpenRouter モデル ID 一覧。実 API 試行に成功したもののみ保存する
const OPENROUTER_CUSTOM_MODELS_KEY = 'openrouter_custom_models';
/** カスタム OpenRouter モデルの上限（chrome.storage.local 5MB 制限に余裕を持たせた値） */
export const OPENROUTER_CUSTOM_MODELS_LIMIT = 20;

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
    // Node.js environment check (for local experiments)
    // types/chrome があるため、chromeオブジェクト自体の存在チェックが必要
    const isNodeEnv = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNodeEnv) {
        if (process.env.GEMINI_API_KEY) {
            return process.env.GEMINI_API_KEY;
        }
    }

    // 次に保存されているキーを確認
    // chrome environment check
    if (typeof chrome === 'undefined' || !chrome.storage) {
        return null; // Chrome拡張環境でもNode環境でもない、またはAPIキーがない
    }

    return await getGeminiApiKey();
}

// API Tier関連

import type { ApiTier, ManualTier } from './types';

const GEMINI_API_TIER_KEY = 'gemini_api_tier';
const GEMINI_MANUAL_TIER_KEY = 'gemini_manual_tier';

/**
 * セッション用のAPI tier（メモリ保持）
 */
let sessionApiTier: ApiTier | null = null;
let sessionManualTier: ManualTier | null = null;

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
    await clearManualTier();
}

/**
 * 手動 tier 設定を保存
 * - free: APIキー検証で free 判定された場合に固定
 * - tier1/tier2/tier3: paid のときユーザが選択
 */
export async function saveManualTier(tier: ManualTier): Promise<void> {
    await chrome.storage.local.set({ [GEMINI_MANUAL_TIER_KEY]: tier });
    sessionManualTier = tier;
}

/**
 * 手動 tier 設定を取得（未設定なら null）
 */
export async function getManualTier(): Promise<ManualTier | null> {
    if (sessionManualTier) return sessionManualTier;
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    const result = await chrome.storage.local.get([GEMINI_MANUAL_TIER_KEY]);
    const value = result[GEMINI_MANUAL_TIER_KEY];
    if (value === 'free' || value === 'tier1' || value === 'tier2' || value === 'tier3') {
        return value;
    }
    return null;
}

/**
 * 手動 tier 設定をクリア
 */
export async function clearManualTier(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage) {
        await chrome.storage.local.remove([GEMINI_MANUAL_TIER_KEY]);
    }
    sessionManualTier = null;
}

// ========== OpenRouter API キー ==========
// Gemini と同じ AES-GCM 暗号化を流用し、保存先キーだけを分離する

export async function saveOpenRouterApiKey(apiKey: string): Promise<void> {
    const encoded = await encryptApiKey(apiKey);
    await chrome.storage.local.set({ [OPENROUTER_API_KEY_STORAGE_KEY]: encoded });
}

export async function getOpenRouterApiKey(): Promise<string | null> {
    const result = await chrome.storage.local.get([OPENROUTER_API_KEY_STORAGE_KEY]);
    const encoded = result[OPENROUTER_API_KEY_STORAGE_KEY];
    if (!encoded) return null;
    try {
        return await decryptApiKey(encoded);
    } catch {
        return null;
    }
}

export async function removeOpenRouterApiKey(): Promise<void> {
    await chrome.storage.local.remove([OPENROUTER_API_KEY_STORAGE_KEY]);
}

export async function hasOpenRouterApiKey(): Promise<boolean> {
    const key = await getOpenRouterApiKey();
    return key !== null && key.length > 0;
}

export async function setOpenRouterApiKeySavePreference(save: boolean): Promise<void> {
    await chrome.storage.local.set({ [OPENROUTER_API_KEY_SAVE_PREFERENCE]: save });
}

export async function getOpenRouterApiKeySavePreference(): Promise<boolean> {
    const result = await chrome.storage.local.get([OPENROUTER_API_KEY_SAVE_PREFERENCE]);
    return result[OPENROUTER_API_KEY_SAVE_PREFERENCE] === true;
}

// セッション保持（保存しない設定時のメモリ保持）
let sessionOpenRouterApiKey: string | null = null;

export function setSessionOpenRouterApiKey(apiKey: string): void {
    sessionOpenRouterApiKey = apiKey;
}

export function getSessionOpenRouterApiKey(): string | null {
    return sessionOpenRouterApiKey;
}

export function clearSessionOpenRouterApiKey(): void {
    sessionOpenRouterApiKey = null;
}

/**
 * 有効な OpenRouter API キーを取得（セッション > 環境変数 > 保存値）
 */
export async function getEffectiveOpenRouterApiKey(): Promise<string | null> {
    if (sessionOpenRouterApiKey) {
        return sessionOpenRouterApiKey;
    }
    const isNodeEnv = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNodeEnv) {
        if (process.env.OPENROUTER_API_KEY) {
            return process.env.OPENROUTER_API_KEY;
        }
    }
    if (typeof chrome === 'undefined' || !chrome.storage) {
        return null;
    }
    return await getOpenRouterApiKey();
}

// ========== OpenAI API キー ==========
// Gemini と同じ AES-GCM 暗号化を流用し、保存先キーだけを分離する

const OPENAI_API_KEY_STORAGE_KEY = 'openai_api_key';
const OPENAI_API_KEY_SAVE_PREFERENCE = 'openai_api_key_save_preference';

export async function saveOpenAiApiKey(apiKey: string): Promise<void> {
    const encoded = await encryptApiKey(apiKey);
    await chrome.storage.local.set({ [OPENAI_API_KEY_STORAGE_KEY]: encoded });
}

export async function getOpenAiApiKey(): Promise<string | null> {
    const result = await chrome.storage.local.get([OPENAI_API_KEY_STORAGE_KEY]);
    const encoded = result[OPENAI_API_KEY_STORAGE_KEY];
    if (!encoded) return null;
    try {
        return await decryptApiKey(encoded);
    } catch {
        return null;
    }
}

export async function removeOpenAiApiKey(): Promise<void> {
    await chrome.storage.local.remove([OPENAI_API_KEY_STORAGE_KEY]);
}

export async function hasOpenAiApiKey(): Promise<boolean> {
    const key = await getOpenAiApiKey();
    return key !== null && key.length > 0;
}

export async function setOpenAiApiKeySavePreference(save: boolean): Promise<void> {
    await chrome.storage.local.set({ [OPENAI_API_KEY_SAVE_PREFERENCE]: save });
}

export async function getOpenAiApiKeySavePreference(): Promise<boolean> {
    const result = await chrome.storage.local.get([OPENAI_API_KEY_SAVE_PREFERENCE]);
    return result[OPENAI_API_KEY_SAVE_PREFERENCE] === true;
}

// セッション保持（保存しない設定時のメモリ保持）
let sessionOpenAiApiKey: string | null = null;

export function setSessionOpenAiApiKey(apiKey: string): void {
    sessionOpenAiApiKey = apiKey;
}

export function getSessionOpenAiApiKey(): string | null {
    return sessionOpenAiApiKey;
}

export function clearSessionOpenAiApiKey(): void {
    sessionOpenAiApiKey = null;
}

/**
 * 有効な OpenAI API キーを取得（セッション > 環境変数 > 保存値）
 */
export async function getEffectiveOpenAiApiKey(): Promise<string | null> {
    if (sessionOpenAiApiKey) {
        return sessionOpenAiApiKey;
    }
    const isNodeEnv = typeof process !== 'undefined' && process.versions && process.versions.node;
    if (isNodeEnv) {
        if (process.env.OPENAI_API_KEY) {
            return process.env.OPENAI_API_KEY;
        }
    }
    if (typeof chrome === 'undefined' || !chrome.storage) {
        return null;
    }
    return await getOpenAiApiKey();
}

// ========== OpenRouter カスタムモデル ==========
// ユーザーが手入力し、API 試行成功で永続化された OpenRouter モデルの管理。
// ビルトイン AVAILABLE_MODELS と合成して使うため、保存形式は最小限（id と任意のラベル）。

export interface CustomOpenRouterModel {
    id: string;
    label?: string;
    addedAt: string;
}

export type AddCustomOpenRouterModelResult =
    | { added: true }
    | { added: false; reason: 'invalid' | 'duplicate' | 'limit' };

export async function getCustomOpenRouterModels(): Promise<CustomOpenRouterModel[]> {
    if (typeof chrome === 'undefined' || !chrome.storage) return [];
    const result = await chrome.storage.local.get([OPENROUTER_CUSTOM_MODELS_KEY]);
    const raw = result[OPENROUTER_CUSTOM_MODELS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): CustomOpenRouterModel[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const obj = entry as { id?: unknown; label?: unknown; addedAt?: unknown };
        if (typeof obj.id !== 'string' || obj.id.length === 0) return [];
        return [{
            id: obj.id,
            label: typeof obj.label === 'string' && obj.label.length > 0 ? obj.label : undefined,
            addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : new Date().toISOString(),
        }];
    });
}

/**
 * カスタム OpenRouter モデルを追加する。
 * - id 空 or 形式不正 → invalid
 * - 既存と重複 → duplicate
 * - 上限超過 → limit
 */
export async function addCustomOpenRouterModel(input: { id: string; label?: string }): Promise<AddCustomOpenRouterModelResult> {
    const id = input.id.trim();
    if (!id) return { added: false, reason: 'invalid' };
    const existing = await getCustomOpenRouterModels();
    if (existing.some(m => m.id === id)) return { added: false, reason: 'duplicate' };
    if (existing.length >= OPENROUTER_CUSTOM_MODELS_LIMIT) return { added: false, reason: 'limit' };
    const entry: CustomOpenRouterModel = {
        id,
        label: input.label?.trim() || undefined,
        addedAt: new Date().toISOString(),
    };
    if (typeof chrome !== 'undefined' && chrome.storage) {
        await chrome.storage.local.set({ [OPENROUTER_CUSTOM_MODELS_KEY]: [...existing, entry] });
    }
    return { added: true };
}

export async function removeCustomOpenRouterModel(modelId: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    const existing = await getCustomOpenRouterModels();
    const next = existing.filter(m => m.id !== modelId);
    await chrome.storage.local.set({ [OPENROUTER_CUSTOM_MODELS_KEY]: next });
}

// ========== レビュー基準の既読マーカー ==========
// 「このプロジェクトのレビュー基準を、どの updated_at まで見たか」を端末ローカルに保持する。
// この機能は Web 版（docs/app/）でも動く必要があり、Web 版は localStorage 実装のため、
// chrome.storage.local を直接使わず platform() アダプタ（storageGet/storageSet）経由で読み書きする。

/** Record<spreadsheetId, updated_at> のマップとして1キーに保存する */
const CRITERIA_SEEN_STORAGE_KEY = 'criteria_seen';

/**
 * 指定プロジェクトのレビュー基準を見た時点の updated_at を返す（未読・壊れた値は null）。
 * 壊れた値・型が違う値は握りつぶして null を返す（getGeminiApiKey と同じ方針）。
 */
export async function getCriteriaSeenAt(spreadsheetId: string): Promise<string | null> {
    try {
        const result = await platform().storageGet([CRITERIA_SEEN_STORAGE_KEY]);
        const map = result[CRITERIA_SEEN_STORAGE_KEY];
        if (!map || typeof map !== 'object') return null;
        const value = (map as Record<string, unknown>)[spreadsheetId];
        return typeof value === 'string' ? value : null;
    } catch {
        return null;
    }
}

/** 指定プロジェクトのレビュー基準を見た時点の updated_at を記録する */
export async function setCriteriaSeenAt(spreadsheetId: string, updatedAt: string): Promise<void> {
    try {
        const result = await platform().storageGet([CRITERIA_SEEN_STORAGE_KEY]);
        const existing = result[CRITERIA_SEEN_STORAGE_KEY];
        const map: Record<string, string> = existing && typeof existing === 'object'
            ? { ...(existing as Record<string, string>) }
            : {};
        map[spreadsheetId] = updatedAt;
        await platform().storageSet({ [CRITERIA_SEEN_STORAGE_KEY]: map });
    } catch {
        // 既読マーカーは UX 補助であり、保存に失敗しても致命的ではないため握りつぶす
    }
}

// ========== TiAb 表示位置の記憶（Issue #140） ==========
// 「キー開封中に最後に表示していた文献」をプロジェクトごとにローカル保存し、
// 次回読み込み時にステータスフィルターごと復元するために使う。

/** Record<spreadsheetId, ScreeningPosition> のマップとして1キーに保存する */
const SCREENING_POSITION_STORAGE_KEY = 'tiab_last_position';

/**
 * 直前に保存した内容と同一かどうかを判定するための記録（モジュール内変数）。
 * 再描画のたびに setLastScreeningPosition が呼ばれても、内容が変わっていなければ
 * storageSet を走らせないようにするためのガード。
 */
let _lastSavedKey: string | null = null;

/**
 * setLastScreeningPosition の read-modify-write を直列化するためのキュー。
 * _lastSavedKey は await 完了後にしか更新されないため、直列化しないと短い間隔で2回呼ばれた
 * ときに両方が重複チェックを通過してしまい、read-modify-write が交錯して古い方が最後に
 * 書かれてしまうことがある。呼び出しのたびにこの Promise へ処理をつなげ、前の呼び出しの
 * 読み書きが完了してから次の読み書きを始めるようにする。
 */
let _writeChain: Promise<void> = Promise.resolve();

function buildScreeningPositionKey(spreadsheetId: string, position: ScreeningPosition): string {
    return `${spreadsheetId} ${position.filter} ${position.refId} ${position.index}`;
}

/**
 * 指定プロジェクトの最後の表示位置を返す（未保存・壊れた値は null）。
 * 壊れた値・型が違う値は握りつぶして null を返す（getCriteriaSeenAt と同じ方針）。
 */
export async function getLastScreeningPosition(spreadsheetId: string): Promise<ScreeningPosition | null> {
    try {
        const result = await platform().storageGet([SCREENING_POSITION_STORAGE_KEY]);
        const map = result[SCREENING_POSITION_STORAGE_KEY];
        if (!map || typeof map !== 'object') return null;
        const value = (map as Record<string, unknown>)[spreadsheetId];
        return parseScreeningPosition(value);
    } catch {
        return null;
    }
}

/**
 * 指定プロジェクトの最後の表示位置を記録する。
 * 直前に保存した内容と同一（spreadsheetId・filter・refId・index が全部同じ）なら
 * 書き込みをスキップする（文献表示のたびに storageSet が走るのを避けるため）。
 * 保存に失敗しても致命的ではないため握りつぶす（getCriteriaSeenAt / setCriteriaSeenAt と同じ方針）。
 * 呼び出しは _writeChain で直列化するため、await せず連続で呼んでも read-modify-write が
 * 交錯しない（重複チェックも直列化された処理の中で行うため、キュー待ち中に同一内容が
 * 先に書かれた場合もスキップできる）。
 */
export function setLastScreeningPosition(spreadsheetId: string, position: ScreeningPosition): Promise<void> {
    const key = buildScreeningPositionKey(spreadsheetId, position);

    _writeChain = _writeChain.then(async () => {
        if (key === _lastSavedKey) return;

        try {
            const result = await platform().storageGet([SCREENING_POSITION_STORAGE_KEY]);
            const existing = result[SCREENING_POSITION_STORAGE_KEY];
            const map: Record<string, ScreeningPosition> = existing && typeof existing === 'object'
                ? { ...(existing as Record<string, ScreeningPosition>) }
                : {};
            map[spreadsheetId] = position;
            await platform().storageSet({ [SCREENING_POSITION_STORAGE_KEY]: map });
            _lastSavedKey = key;
        } catch {
            // 表示位置の記憶は UX 補助であり、保存に失敗しても致命的ではないため握りつぶす
        }
    });

    return _writeChain;
}
