// storage.ts - ローカルストレージ管理（APIキー等）

import { platform } from '../platform';
import { normalizeLocalLlmEndpoint } from './local-llm-model';
import type { OpenRouterModel, OpenRouterModelsCache } from './openrouter-models';
import { createApiKeyStore } from './api-key-store';
import { parseScreeningPosition, type ScreeningPosition } from './screening-position';

export async function saveLocalLlmEndpoint(endpoint: string): Promise<void> {
    await chrome.storage.local.set({ local_llm_endpoint: normalizeLocalLlmEndpoint(endpoint) });
}
export async function getLocalLlmEndpoint(): Promise<string | null> {
    const result = await chrome.storage.local.get('local_llm_endpoint');
    return typeof result.local_llm_endpoint === 'string' ? result.local_llm_endpoint : null;
}

export async function saveLocalLlmModels(models: string[]): Promise<void> {
    await chrome.storage.local.set({ local_llm_models: models });
}
export async function getLocalLlmModels(): Promise<string[]> {
    const result = await chrome.storage.local.get('local_llm_models');
    return Array.isArray(result.local_llm_models)
        ? result.local_llm_models.filter((id: unknown): id is string => typeof id === 'string') : [];
}

// ユーザーが手動追加した OpenRouter モデル ID 一覧。実 API 試行に成功したもののみ保存する
const OPENROUTER_CUSTOM_MODELS_KEY = 'openrouter_custom_models';
const OPENROUTER_MODELS_CACHE_KEY = 'openrouter_models_cache';
/** カスタム OpenRouter モデルの上限（chrome.storage.local 5MB 制限に余裕を持たせた値） */
export const OPENROUTER_CUSTOM_MODELS_LIMIT = 20;

// ========== API キー ==========
// 保存処理は api-key-store.ts の createApiKeyStore() が持つ。保存キー名は一度決めたら変えない
// （変えると既存利用者の保存値が読めなくなる）。暗号化ソルトは全プロバイダで共用する。

export const apiKeyStores = {
    gemini: createApiKeyStore({
        storageKey: 'gemini_api_key',
        savePreferenceKey: 'gemini_api_key_save_preference',
        envVar: 'GEMINI_API_KEY',
    }),
    openrouter: createApiKeyStore({
        storageKey: 'openrouter_api_key',
        savePreferenceKey: 'openrouter_api_key_save_preference',
        envVar: 'OPENROUTER_API_KEY',
    }),
    openai: createApiKeyStore({
        storageKey: 'openai_api_key',
        savePreferenceKey: 'openai_api_key_save_preference',
        envVar: 'OPENAI_API_KEY',
    }),
    anthropic: createApiKeyStore({
        storageKey: 'anthropic_api_key',
        savePreferenceKey: 'anthropic_api_key_save_preference',
        envVar: 'ANTHROPIC_API_KEY',
    }),
    typesafe: createApiKeyStore({
        storageKey: 'typesafe_api_key',
        savePreferenceKey: 'typesafe_api_key_save_preference',
        envVar: 'TYPE_SAFE_API_KEY',
    }),
} as const;

export const saveGeminiApiKey = apiKeyStores.gemini.saveKey;
export const getGeminiApiKey = apiKeyStores.gemini.getKey;
export const removeGeminiApiKey = apiKeyStores.gemini.removeKey;
export const hasGeminiApiKey = apiKeyStores.gemini.hasKey;
export const setApiKeySavePreference = apiKeyStores.gemini.setSavePreference;
export const getApiKeySavePreference = apiKeyStores.gemini.getSavePreference;
export const setSessionApiKey = apiKeyStores.gemini.setSessionKey;
export const getSessionApiKey = apiKeyStores.gemini.getSessionKey;
export const clearSessionApiKey = apiKeyStores.gemini.clearSessionKey;
export const getEffectiveApiKey = apiKeyStores.gemini.getEffectiveKey;

export const saveOpenRouterApiKey = apiKeyStores.openrouter.saveKey;
export const getOpenRouterApiKey = apiKeyStores.openrouter.getKey;
export const removeOpenRouterApiKey = apiKeyStores.openrouter.removeKey;
export const hasOpenRouterApiKey = apiKeyStores.openrouter.hasKey;
export const setOpenRouterApiKeySavePreference = apiKeyStores.openrouter.setSavePreference;
export const getOpenRouterApiKeySavePreference = apiKeyStores.openrouter.getSavePreference;
export const setSessionOpenRouterApiKey = apiKeyStores.openrouter.setSessionKey;
export const getSessionOpenRouterApiKey = apiKeyStores.openrouter.getSessionKey;
export const clearSessionOpenRouterApiKey = apiKeyStores.openrouter.clearSessionKey;
export const getEffectiveOpenRouterApiKey = apiKeyStores.openrouter.getEffectiveKey;

export const saveOpenAiApiKey = apiKeyStores.openai.saveKey;
export const getOpenAiApiKey = apiKeyStores.openai.getKey;
export const removeOpenAiApiKey = apiKeyStores.openai.removeKey;
export const hasOpenAiApiKey = apiKeyStores.openai.hasKey;
export const setOpenAiApiKeySavePreference = apiKeyStores.openai.setSavePreference;
export const getOpenAiApiKeySavePreference = apiKeyStores.openai.getSavePreference;
export const setSessionOpenAiApiKey = apiKeyStores.openai.setSessionKey;
export const getSessionOpenAiApiKey = apiKeyStores.openai.getSessionKey;
export const clearSessionOpenAiApiKey = apiKeyStores.openai.clearSessionKey;
export const getEffectiveOpenAiApiKey = apiKeyStores.openai.getEffectiveKey;

export const saveAnthropicApiKey = apiKeyStores.anthropic.saveKey;
export const getAnthropicApiKey = apiKeyStores.anthropic.getKey;
export const removeAnthropicApiKey = apiKeyStores.anthropic.removeKey;
export const hasAnthropicApiKey = apiKeyStores.anthropic.hasKey;
export const setAnthropicApiKeySavePreference = apiKeyStores.anthropic.setSavePreference;
export const getAnthropicApiKeySavePreference = apiKeyStores.anthropic.getSavePreference;
export const setSessionAnthropicApiKey = apiKeyStores.anthropic.setSessionKey;
export const getSessionAnthropicApiKey = apiKeyStores.anthropic.getSessionKey;
export const clearSessionAnthropicApiKey = apiKeyStores.anthropic.clearSessionKey;
export const getEffectiveAnthropicApiKey = apiKeyStores.anthropic.getEffectiveKey;

export const saveTypeSafeApiKey = apiKeyStores.typesafe.saveKey;
export const getTypeSafeApiKey = apiKeyStores.typesafe.getKey;
export const removeTypeSafeApiKey = apiKeyStores.typesafe.removeKey;
export const hasTypeSafeApiKey = apiKeyStores.typesafe.hasKey;
export const setTypeSafeApiKeySavePreference = apiKeyStores.typesafe.setSavePreference;
export const getTypeSafeApiKeySavePreference = apiKeyStores.typesafe.getSavePreference;
export const setSessionTypeSafeApiKey = apiKeyStores.typesafe.setSessionKey;
export const getSessionTypeSafeApiKey = apiKeyStores.typesafe.getSessionKey;
export const clearSessionTypeSafeApiKey = apiKeyStores.typesafe.clearSessionKey;
export const getEffectiveTypeSafeApiKey = apiKeyStores.typesafe.getEffectiveKey;

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

/** 公開モデル一覧は取得時刻と一緒に保存する。 */
export async function saveOpenRouterModels(models: OpenRouterModel[], fetchedAt = Date.now()): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) {
        return;
    }
    await chrome.storage.local.set({ [OPENROUTER_MODELS_CACHE_KEY]: { models, fetchedAt } });
}

export async function getOpenRouterModels(): Promise<OpenRouterModelsCache | null> {
    if (typeof chrome === 'undefined' || !chrome.storage) {
        return null;
    }
    const result = await chrome.storage.local.get([OPENROUTER_MODELS_CACHE_KEY]);
    const raw = result[OPENROUTER_MODELS_CACHE_KEY] as Partial<OpenRouterModelsCache> | null;
    if (!raw || !Array.isArray(raw.models) || typeof raw.fetchedAt !== 'number' || !Number.isFinite(raw.fetchedAt)) {
        return null;
    }
    const models = raw.models.filter(model => model && typeof model.id === 'string' && model.id.length > 0);
    return { models, fetchedAt: raw.fetchedAt };
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
