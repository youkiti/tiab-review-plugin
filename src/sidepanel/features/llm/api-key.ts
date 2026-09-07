/**
 * LLM APIキー管理モジュール
 */

import { dom } from './dom';
import {
    getGeminiApiKey,
    getSessionApiKey,
    saveGeminiApiKey,
    removeGeminiApiKey,
    hasGeminiApiKey,
    setSessionApiKey,
    getApiKeySavePreference,
    setApiKeySavePreference,
    saveApiTier,
    setSessionApiTier,
    clearApiTier,
    getManualTier,
    saveManualTier,
    // OpenRouter
    getOpenRouterApiKey,
    getSessionOpenRouterApiKey,
    saveOpenRouterApiKey,
    removeOpenRouterApiKey,
    hasOpenRouterApiKey,
    setSessionOpenRouterApiKey,
    getOpenRouterApiKeySavePreference,
    setOpenRouterApiKeySavePreference,
    // OpenAI
    getOpenAiApiKey,
    getSessionOpenAiApiKey,
    saveOpenAiApiKey,
    removeOpenAiApiKey,
    hasOpenAiApiKey,
    setSessionOpenAiApiKey,
    getOpenAiApiKeySavePreference,
    setOpenAiApiKeySavePreference,
} from '../../../lib/storage';
import { testApiKeyWithTier } from '../../../lib/gemini-api';
import { testOpenRouterApiKey } from '../../../lib/providers/openrouter';
import { testOpenAiApiKey } from '../../../lib/providers/openai';
import { showToast } from '../../ui/feedback';
import { t } from '../../../lib/i18n';
import type { ApiTier, ManualTier } from '../../../lib/types';
import type { LlmProviderId } from '../../../lib/llm-provider';
import { isImeComposing } from '../../../lib/ime-composition';

/**
 * API キー変更時にモデル選択肢を再構築するためのコールバック。
 * 循環 import を避けるため、index.ts 側から `setOnApiKeyChanged()` 経由で注入する。
 */
type ApiKeyChangedHandler = () => void | Promise<void>;
let onApiKeyChanged: ApiKeyChangedHandler | null = null;

export function setOnApiKeyChanged(handler: ApiKeyChangedHandler): void {
    onApiKeyChanged = handler;
}

async function notifyApiKeyChanged(): Promise<void> {
    if (onApiKeyChanged) {
        try {
            await onApiKeyChanged();
        } catch (error) {
            console.error('[notifyApiKeyChanged] Error:', error);
        }
    }
}

/**
 * Tier セレクタの表示を最新の manualTier に同期
 * free / tier1 / tier2 / tier3 いずれも常にセレクタで表示し、手動で上書きできるようにする
 * （Tier 1/2/3 は APIキーだけでは自動判定できないため、自動判定はあくまで初期値の提案）
 */
export async function refreshTierSelector(): Promise<void> {
    const manualTier = await getManualTier();
    if (!manualTier) {
        dom.tierSection.classList.add('hidden');
        return;
    }

    dom.tierSection.classList.remove('hidden');
    dom.tierSelect.classList.remove('hidden');
    dom.tierSelect.value = manualTier;
}

/** ManualTier ごとのローカライズ表示名 i18n キー */
const TIER_LABEL_KEYS: Record<ManualTier, string> = {
    free: 'llm_tierFree',
    tier1: 'llm_tierTier1',
    tier2: 'llm_tierTier2',
    tier3: 'llm_tierTier3',
};

/**
 * Tier セレクタの変更を保存
 */
export async function handleTierChange(): Promise<void> {
    const value = dom.tierSelect.value;
    if (value === 'free' || value === 'tier1' || value === 'tier2' || value === 'tier3') {
        await saveManualTier(value as ManualTier);
        showToast(t('llm_tierSaved', t(TIER_LABEL_KEYS[value as ManualTier])));
    }
}

interface KeyTestResult {
    isValid: boolean;
    tier?: ApiTier;
    availableModels?: string[];
}

interface ProviderKeyAdapter {
    input: () => HTMLInputElement;
    toggleBtn: () => HTMLButtonElement;
    status: () => HTMLElement;
    hasKey: () => Promise<boolean>;
    getKey: () => Promise<string | null>;
    getSessionKey: () => string | null;
    saveKey: (key: string) => Promise<void>;
    removeKey: () => Promise<void>;
    setSessionKey: (key: string) => void;
    getSavePreference: () => Promise<boolean>;
    setSavePreference: (value: boolean) => Promise<void>;
    test: (key: string) => Promise<KeyTestResult>;
    afterValid?: (result: KeyTestResult, shouldSave: boolean) => Promise<void>;
    afterClear?: () => Promise<void>;
}

async function afterValidGemini(result: KeyTestResult, shouldSave: boolean): Promise<void> {
    if (!result.tier) return;
    // 手動 tier の初期化:
    // 自動判定の結果はあくまで「初期値の提案」。保存済みの手動設定がある場合は上書きせず、
    // 既存ユーザーの設定を維持する。未設定のときだけ初期値を入れる:
    // - paid → tier1
    // - free / unknown → free（unknown は判定不能なので安全側の無料として扱う）
    const existingManual = await getManualTier();
    if (!existingManual) {
        await saveManualTier(result.tier === 'paid' ? 'tier1' : 'free');
    }

    if (shouldSave) {
        await saveApiTier(result.tier);
    } else {
        setSessionApiTier(result.tier);
    }

    // トーストは「検出結果」ではなく「実際に適用される手動設定」に合わせて出す。
    // existingManual が設定済みなら、上の初期化では上書きしていない（＝それがそのまま適用される）ので、
    // 検出結果とは無関係に existingManual の速度で実行される。ここで検出結果だけを見て
    // 「制限されます」等と言い切ると、保存済み設定と食い違うときに嘘の案内になる（#88 の再発防止）。
    if (result.tier === 'free') {
        if (!existingManual || existingManual === 'free') {
            // 今回 free が適用される（新規保存 or 既に free 設定済み）→ 従来通りの速度警告で正しい
            showToast(t('llm_freeTierWarning'), 5000);
        } else {
            // 無料キーなのに手動設定（tier1/2/3）が優先され、そちらのまま維持される
            showToast(t('llm_freeTierManualOverrideWarning', t(TIER_LABEL_KEYS[existingManual])), 6000);
        }
    } else if (result.tier === 'unknown') {
        if (!existingManual) {
            // 今回 free が適用される（安全側のデフォルト）→ 従来通り
            showToast(t('llm_tierUnknownWarning'), 5000);
        } else {
            // 既存の手動設定がそのまま維持される。速度への言及はしない（判定不能なので誤解を招く）
            showToast(t('llm_tierUnknownManualKeptWarning', t(TIER_LABEL_KEYS[existingManual])), 5000);
        }
    }
    await refreshTierSelector();
}

const providers: LlmProviderId[] = ['gemini', 'openrouter', 'openai'];
const adapters: Record<LlmProviderId, ProviderKeyAdapter> = {
    gemini: {
        input: () => dom.geminiApiKeyInput,
        toggleBtn: () => dom.toggleApiKeyVisibilityBtn,
        status: () => dom.apiKeyStatus,
        hasKey: hasGeminiApiKey,
        getKey: getGeminiApiKey,
        getSessionKey: getSessionApiKey,
        saveKey: saveGeminiApiKey,
        removeKey: removeGeminiApiKey,
        setSessionKey: setSessionApiKey,
        getSavePreference: getApiKeySavePreference,
        setSavePreference: setApiKeySavePreference,
        test: testApiKeyWithTier,
        afterValid: afterValidGemini,
        afterClear: async () => {
            await clearApiTier();
            await refreshTierSelector();
        },
    },
    openrouter: {
        input: () => dom.openRouterApiKeyInput,
        toggleBtn: () => dom.toggleOpenRouterApiKeyVisibilityBtn,
        status: () => dom.openRouterApiKeyStatus,
        hasKey: hasOpenRouterApiKey,
        getKey: getOpenRouterApiKey,
        getSessionKey: getSessionOpenRouterApiKey,
        saveKey: saveOpenRouterApiKey,
        removeKey: removeOpenRouterApiKey,
        setSessionKey: setSessionOpenRouterApiKey,
        getSavePreference: getOpenRouterApiKeySavePreference,
        setSavePreference: setOpenRouterApiKeySavePreference,
        test: testOpenRouterApiKey,
    },
    openai: {
        input: () => dom.openAiApiKeyInput,
        toggleBtn: () => dom.toggleOpenAiApiKeyVisibilityBtn,
        status: () => dom.openAiApiKeyStatus,
        hasKey: hasOpenAiApiKey,
        getKey: getOpenAiApiKey,
        getSessionKey: getSessionOpenAiApiKey,
        saveKey: saveOpenAiApiKey,
        removeKey: removeOpenAiApiKey,
        setSessionKey: setSessionOpenAiApiKey,
        getSavePreference: getOpenAiApiKeySavePreference,
        setSavePreference: setOpenAiApiKeySavePreference,
        test: testOpenAiApiKey,
    },
};

const inFlight: Record<LlmProviderId, boolean> = { gemini: false, openrouter: false, openai: false };
const lastValidKeys: Record<LlmProviderId, string | null> = { gemini: null, openrouter: null, openai: null };
const sessionOnly: Record<LlmProviderId, boolean> = { gemini: false, openrouter: false, openai: false };

export function setProviderRowOpen(provider: LlmProviderId, open: boolean): void {
    dom.providerRow(provider).classList.toggle('open', open);
    dom.providerHead(provider).setAttribute('aria-expanded', String(open));
}

function updateProviderChip(provider: LlmProviderId, configured: boolean, needed = false): void {
    const chip = dom.providerChip(provider);
    chip.className = 'provider-chip' + (configured ? ' ok' : needed ? ' need' : '');
    chip.textContent = t(configured
        ? sessionOnly[provider] ? 'llm_apiKeySummarySession' : 'llm_apiKeySummarySet'
        : needed ? 'llm_providerChipNeeded' : 'llm_providerChipUnset');
}

export function refreshProviderEmphasis(selected: LlmProviderId, configured: Set<LlmProviderId>): void {
    for (const provider of providers) {
        dom.providerRow(provider).classList.toggle('emphasized', provider === selected);
        updateProviderChip(provider, configured.has(provider), provider === selected);
    }
    if (!configured.has(selected)) setProviderRowOpen(selected, true);
}

export async function loadAllProviderStatus(): Promise<void> {
    const preferences = await Promise.all(providers.map(provider => adapters[provider].getSavePreference()));
    dom.saveApiKeyCheckbox.checked = preferences.some(Boolean);
    for (const provider of providers) {
        const adapter = adapters[provider];
        const savedKey = await adapter.hasKey() ? await adapter.getKey() : null;
        const sessionKey = adapter.getSessionKey();
        const key = sessionKey || savedKey;
        adapter.input().value = key || '';
        lastValidKeys[provider] = key || null;
        sessionOnly[provider] = !!sessionKey && sessionKey !== savedKey;
        adapter.status().textContent = key ? t(sessionOnly[provider] ? 'llm_apiKeySessionOnly' : 'llm_apiKeySet') : '';
        adapter.status().className = key ? 'api-key-status success' : 'api-key-status';
        updateProviderChip(provider, !!key);
        setProviderRowOpen(provider, false);
    }
    await refreshTierSelector();
}

export function toggleProviderKeyVisibility(provider: LlmProviderId): void {
    const adapter = adapters[provider];
    const show = adapter.input().type === 'password';
    adapter.input().type = show ? 'text' : 'password';
    adapter.toggleBtn().textContent = show ? '🙈' : '👁';
}

export async function verifyProviderKey(provider: LlmProviderId): Promise<void> {
    const adapter = adapters[provider];
    const apiKey = adapter.input().value.trim();
    if (inFlight[provider] || (apiKey && lastValidKeys[provider] === apiKey)) return;

    inFlight[provider] = true;
    dom.verifyApiKeyBtn(provider).disabled = true;
    try {
        if (!apiKey) {
            await adapter.removeKey();
            adapter.setSessionKey('');
            lastValidKeys[provider] = null;
            sessionOnly[provider] = false;
            adapter.status().textContent = '';
            adapter.status().className = 'api-key-status';
            await adapter.afterClear?.();
            await notifyApiKeyChanged();
            return;
        }

        adapter.status().textContent = t('llm_apiKeyVerifying');
        adapter.status().className = 'api-key-status';
        const result = await adapter.test(apiKey);
        // 検証中に入力が変わった場合、古い値は保存しない。
        if (adapter.input().value.trim() !== apiKey) return;
        if (!result.isValid) {
            adapter.status().textContent = t('llm_apiKeyInvalid');
            adapter.status().className = 'api-key-status error';
            return;
        }

        const shouldSave = dom.saveApiKeyCheckbox.checked;
        await adapter.setSavePreference(shouldSave);
        if (shouldSave) {
            await adapter.saveKey(apiKey);
            adapter.setSessionKey('');
        } else {
            await adapter.removeKey();
            adapter.setSessionKey(apiKey);
        }
        await adapter.afterValid?.(result, shouldSave);
        lastValidKeys[provider] = apiKey;
        sessionOnly[provider] = !shouldSave;
        adapter.status().textContent = t(shouldSave ? 'llm_apiKeySaved' : 'llm_apiKeySessionOnly');
        adapter.status().className = 'api-key-status success';
        await notifyApiKeyChanged();
    } catch {
        adapter.status().textContent = t('llm_apiKeyInvalid');
        adapter.status().className = 'api-key-status error';
    } finally {
        inFlight[provider] = false;
        dom.verifyApiKeyBtn(provider).disabled = false;
        if (adapter.input().value.trim() !== apiKey) {
            await verifyProviderKey(provider);
        }
    }
}

/**
 * 保存設定の切替は検証済みのキーにだけ適用する。
 * 未検証の入力を保存すると無効なキーが設定済み扱いになるため。
 */
export async function handleSavePreferenceChange(): Promise<void> {
    const shouldSave = dom.saveApiKeyCheckbox.checked;
    for (const provider of providers) {
        const adapter = adapters[provider];
        await adapter.setSavePreference(shouldSave);
        const apiKey = adapter.input().value.trim();
        if (!apiKey || inFlight[provider] || lastValidKeys[provider] !== apiKey) continue;
        if (shouldSave) {
            await adapter.saveKey(apiKey);
            adapter.setSessionKey('');
        } else {
            await adapter.removeKey();
            adapter.setSessionKey(apiKey);
        }
        sessionOnly[provider] = !shouldSave;
        adapter.status().textContent = t(shouldSave ? 'llm_apiKeySaved' : 'llm_apiKeySessionChanged');
        adapter.status().className = 'api-key-status success';
    }
    await notifyApiKeyChanged();
}

export function wireProviderRows(): void {
    for (const provider of providers) {
        const adapter = adapters[provider];
        dom.providerHead(provider).addEventListener('click', () => {
            setProviderRowOpen(provider, !dom.providerRow(provider).classList.contains('open'));
        });
        dom.verifyApiKeyBtn(provider).addEventListener('click', () => { void verifyProviderKey(provider); });
        adapter.input().addEventListener('change', () => { void verifyProviderKey(provider); });
        adapter.input().addEventListener('keydown', event => {
            if (event.key !== 'Enter' || isImeComposing(event)) return;
            event.preventDefault();
            void verifyProviderKey(provider);
        });
        adapter.toggleBtn().addEventListener('click', () => toggleProviderKeyVisibility(provider));
    }
}
