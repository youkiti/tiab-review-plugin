/**
 * LLM APIキー管理モジュール
 */

import { dom } from './dom';
import {
    getGeminiApiKey,
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
    saveOpenRouterApiKey,
    removeOpenRouterApiKey,
    hasOpenRouterApiKey,
    setSessionOpenRouterApiKey,
    getOpenRouterApiKeySavePreference,
    setOpenRouterApiKeySavePreference,
    // OpenAI
    getOpenAiApiKey,
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
import type { ManualTier } from '../../../lib/types';

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

/**
 * APIキーの状態を読み込み
 */
export async function loadApiKeyStatus() {
    const hasKey = await hasGeminiApiKey();
    const savePreference = await getApiKeySavePreference();

    dom.saveApiKeyCheckbox.checked = savePreference;

    if (hasKey) {
        const key = await getGeminiApiKey();
        if (key) {
            dom.geminiApiKeyInput.value = key;
            dom.apiKeyStatus.textContent = t('llm_apiKeySet');
            dom.apiKeyStatus.className = 'api-key-status success';

            // 保存済みの場合：確定状態のスタイルを適用し、折りたたむ
            dom.apiKeyCard.classList.add('confirmed', 'collapsed');
            dom.apiKeySummary.textContent = t('llm_apiKeySummarySet');
        }
    } else {
        dom.apiKeyStatus.textContent = '';
        dom.apiKeyStatus.className = 'api-key-status';

        // 未設定の場合：確定状態を解除し、展開
        dom.apiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.apiKeySummary.textContent = '';
    }

    await refreshTierSelector();
}

/**
 * APIキー表示/非表示切り替え
 */
export function toggleApiKeyVisibility() {
    if (dom.geminiApiKeyInput.type === 'password') {
        dom.geminiApiKeyInput.type = 'text';
        dom.toggleApiKeyVisibilityBtn.textContent = '🙈';
    } else {
        dom.geminiApiKeyInput.type = 'password';
        dom.toggleApiKeyVisibilityBtn.textContent = '👁';
    }
}

/**
 * APIキー入力時の自動保存（チェックボックスがONの場合）
 */
export async function handleApiKeyAutoSave() {
    const apiKey = dom.geminiApiKeyInput.value.trim();
    if (!apiKey) {
        dom.apiKeyStatus.textContent = '';
        dom.apiKeyStatus.className = 'api-key-status';

        // 未入力になった場合：確定状態を解除し、キー情報をクリア
        dom.apiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.apiKeySummary.textContent = '';

        await removeGeminiApiKey();
        setSessionApiKey('');
        await clearApiTier();
        await refreshTierSelector();
        await notifyApiKeyChanged();
        return;
    }

    dom.apiKeyStatus.textContent = t('llm_apiKeyVerifying');
    dom.apiKeyStatus.className = 'api-key-status';

    // APIキーを検証（tier検出含む）
    const result = await testApiKeyWithTier(apiKey);
    if (!result.isValid) {
        dom.apiKeyStatus.textContent = t('llm_apiKeyInvalid');
        dom.apiKeyStatus.className = 'api-key-status error';
        return;
    }

    // 手動 tier の初期化:
    // 自動判定の結果はあくまで「初期値の提案」。保存済みの手動設定がある場合は上書きせず、
    // 既存ユーザーの設定を維持する。未設定のときだけ初期値を入れる:
    // - paid → tier1
    // - free / unknown → free（unknown は判定不能なので安全側の無料として扱う）
    const existingManual = await getManualTier();
    if (!existingManual) {
        await saveManualTier(result.tier === 'paid' ? 'tier1' : 'free');
    }

    // 保存設定に応じて保存
    const shouldSave = dom.saveApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveGeminiApiKey(apiKey);
        await setApiKeySavePreference(true);
        await saveApiTier(result.tier);
        dom.apiKeyStatus.textContent = t('llm_apiKeySaved');

        // 保存済みの場合：確定状態のスタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        setSessionApiKey(apiKey);
        setSessionApiTier(result.tier);
        dom.apiKeyStatus.textContent = t('llm_apiKeySessionOnly');

        // セッション限りの場合：確定スタイルは適用するが、展開したまま
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = t('llm_apiKeySummarySession');
    }
    dom.apiKeyStatus.className = 'api-key-status success';

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
    console.log(`[handleApiKeyAutoSave] Detected tier: ${result.tier}. Available models: ${result.availableModels.join(', ')}`);

    await refreshTierSelector();
    await notifyApiKeyChanged();
}

/**
 * 保存設定チェックボックスの変更処理
 */
export async function handleSavePreferenceChange() {
    const shouldSave = dom.saveApiKeyCheckbox.checked;
    await setApiKeySavePreference(shouldSave);

    const apiKey = dom.geminiApiKeyInput.value.trim();
    if (!apiKey) return;

    if (shouldSave) {
        // 現在のAPIキーを保存
        await saveGeminiApiKey(apiKey);
        dom.apiKeyStatus.textContent = t('llm_apiKeySaved');
        dom.apiKeyStatus.className = 'api-key-status success';

        // 確定状態のスタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        // 保存済みキーを削除してセッションキーに切り替え
        await removeGeminiApiKey();
        setSessionApiKey(apiKey);
        dom.apiKeyStatus.textContent = t('llm_apiKeySessionChanged');
        dom.apiKeyStatus.className = 'api-key-status success';

        // セッション限りの場合：確定スタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = t('llm_apiKeySummarySession');
    }

    await notifyApiKeyChanged();
}

// ========== OpenRouter API キー ==========
// Gemini と同形のフローだが、tier 概念がない分シンプル。

/**
 * OpenRouter APIキーの状態を読み込み
 */
export async function loadOpenRouterApiKeyStatus() {
    const hasKey = await hasOpenRouterApiKey();
    const savePreference = await getOpenRouterApiKeySavePreference();

    dom.saveOpenRouterApiKeyCheckbox.checked = savePreference;

    if (hasKey) {
        const key = await getOpenRouterApiKey();
        if (key) {
            dom.openRouterApiKeyInput.value = key;
            dom.openRouterApiKeyStatus.textContent = t('llm_apiKeySet');
            dom.openRouterApiKeyStatus.className = 'api-key-status success';
            dom.openRouterApiKeyCard.classList.add('confirmed', 'collapsed');
            dom.openRouterApiKeySummary.textContent = t('llm_apiKeySummarySet');
        }
    } else {
        dom.openRouterApiKeyStatus.textContent = '';
        dom.openRouterApiKeyStatus.className = 'api-key-status';
        dom.openRouterApiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.openRouterApiKeySummary.textContent = '';
    }
}

/**
 * OpenRouter APIキー表示/非表示切り替え
 */
export function toggleOpenRouterApiKeyVisibility() {
    if (dom.openRouterApiKeyInput.type === 'password') {
        dom.openRouterApiKeyInput.type = 'text';
        dom.toggleOpenRouterApiKeyVisibilityBtn.textContent = '🙈';
    } else {
        dom.openRouterApiKeyInput.type = 'password';
        dom.toggleOpenRouterApiKeyVisibilityBtn.textContent = '👁';
    }
}

/**
 * OpenRouter APIキー入力時の自動保存
 */
export async function handleOpenRouterApiKeyAutoSave() {
    const apiKey = dom.openRouterApiKeyInput.value.trim();
    if (!apiKey) {
        dom.openRouterApiKeyStatus.textContent = '';
        dom.openRouterApiKeyStatus.className = 'api-key-status';
        dom.openRouterApiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.openRouterApiKeySummary.textContent = '';

        await removeOpenRouterApiKey();
        setSessionOpenRouterApiKey('');
        await notifyApiKeyChanged();
        return;
    }

    dom.openRouterApiKeyStatus.textContent = t('llm_apiKeyVerifying');
    dom.openRouterApiKeyStatus.className = 'api-key-status';

    const result = await testOpenRouterApiKey(apiKey);
    if (!result.isValid) {
        dom.openRouterApiKeyStatus.textContent = t('llm_apiKeyInvalid');
        dom.openRouterApiKeyStatus.className = 'api-key-status error';
        return;
    }

    const shouldSave = dom.saveOpenRouterApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveOpenRouterApiKey(apiKey);
        await setOpenRouterApiKeySavePreference(true);
        dom.openRouterApiKeyStatus.textContent = t('llm_apiKeySaved');
        dom.openRouterApiKeyCard.classList.add('confirmed');
        dom.openRouterApiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        setSessionOpenRouterApiKey(apiKey);
        dom.openRouterApiKeyStatus.textContent = t('llm_apiKeySessionOnly');
        dom.openRouterApiKeyCard.classList.add('confirmed');
        dom.openRouterApiKeySummary.textContent = t('llm_apiKeySummarySession');
    }
    dom.openRouterApiKeyStatus.className = 'api-key-status success';
    await notifyApiKeyChanged();
}

/**
 * OpenRouter 保存設定チェックボックスの変更処理
 */
export async function handleOpenRouterSavePreferenceChange() {
    const shouldSave = dom.saveOpenRouterApiKeyCheckbox.checked;
    await setOpenRouterApiKeySavePreference(shouldSave);

    const apiKey = dom.openRouterApiKeyInput.value.trim();
    if (!apiKey) return;

    if (shouldSave) {
        await saveOpenRouterApiKey(apiKey);
        dom.openRouterApiKeyStatus.textContent = t('llm_apiKeySaved');
        dom.openRouterApiKeyStatus.className = 'api-key-status success';
        dom.openRouterApiKeyCard.classList.add('confirmed');
        dom.openRouterApiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        await removeOpenRouterApiKey();
        setSessionOpenRouterApiKey(apiKey);
        dom.openRouterApiKeyStatus.textContent = t('llm_apiKeySessionChanged');
        dom.openRouterApiKeyStatus.className = 'api-key-status success';
        dom.openRouterApiKeyCard.classList.add('confirmed');
        dom.openRouterApiKeySummary.textContent = t('llm_apiKeySummarySession');
    }

    await notifyApiKeyChanged();
}

// ========== OpenAI API キー ==========
// OpenRouter と同形のフローだが、tier 概念がない分シンプル。

/**
 * OpenAI APIキーの状態を読み込み
 */
export async function loadOpenAiApiKeyStatus() {
    const hasKey = await hasOpenAiApiKey();
    const savePreference = await getOpenAiApiKeySavePreference();

    dom.saveOpenAiApiKeyCheckbox.checked = savePreference;

    if (hasKey) {
        const key = await getOpenAiApiKey();
        if (key) {
            dom.openAiApiKeyInput.value = key;
            dom.openAiApiKeyStatus.textContent = t('llm_apiKeySet');
            dom.openAiApiKeyStatus.className = 'api-key-status success';
            dom.openAiApiKeyCard.classList.add('confirmed', 'collapsed');
            dom.openAiApiKeySummary.textContent = t('llm_apiKeySummarySet');
        }
    } else {
        dom.openAiApiKeyStatus.textContent = '';
        dom.openAiApiKeyStatus.className = 'api-key-status';
        dom.openAiApiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.openAiApiKeySummary.textContent = '';
    }
}

/**
 * OpenAI APIキー表示/非表示切り替え
 */
export function toggleOpenAiApiKeyVisibility() {
    if (dom.openAiApiKeyInput.type === 'password') {
        dom.openAiApiKeyInput.type = 'text';
        dom.toggleOpenAiApiKeyVisibilityBtn.textContent = '🙈';
    } else {
        dom.openAiApiKeyInput.type = 'password';
        dom.toggleOpenAiApiKeyVisibilityBtn.textContent = '👁';
    }
}

/**
 * OpenAI APIキー入力時の自動保存
 */
export async function handleOpenAiApiKeyAutoSave() {
    const apiKey = dom.openAiApiKeyInput.value.trim();
    if (!apiKey) {
        dom.openAiApiKeyStatus.textContent = '';
        dom.openAiApiKeyStatus.className = 'api-key-status';
        dom.openAiApiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.openAiApiKeySummary.textContent = '';

        await removeOpenAiApiKey();
        setSessionOpenAiApiKey('');
        await notifyApiKeyChanged();
        return;
    }

    dom.openAiApiKeyStatus.textContent = t('llm_apiKeyVerifying');
    dom.openAiApiKeyStatus.className = 'api-key-status';

    const result = await testOpenAiApiKey(apiKey);
    if (!result.isValid) {
        dom.openAiApiKeyStatus.textContent = t('llm_apiKeyInvalid');
        dom.openAiApiKeyStatus.className = 'api-key-status error';
        return;
    }

    const shouldSave = dom.saveOpenAiApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveOpenAiApiKey(apiKey);
        await setOpenAiApiKeySavePreference(true);
        dom.openAiApiKeyStatus.textContent = t('llm_apiKeySaved');
        dom.openAiApiKeyCard.classList.add('confirmed');
        dom.openAiApiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        setSessionOpenAiApiKey(apiKey);
        dom.openAiApiKeyStatus.textContent = t('llm_apiKeySessionOnly');
        dom.openAiApiKeyCard.classList.add('confirmed');
        dom.openAiApiKeySummary.textContent = t('llm_apiKeySummarySession');
    }
    dom.openAiApiKeyStatus.className = 'api-key-status success';
    await notifyApiKeyChanged();
}

/**
 * OpenAI 保存設定チェックボックスの変更処理
 */
export async function handleOpenAiSavePreferenceChange() {
    const shouldSave = dom.saveOpenAiApiKeyCheckbox.checked;
    await setOpenAiApiKeySavePreference(shouldSave);

    const apiKey = dom.openAiApiKeyInput.value.trim();
    if (!apiKey) return;

    if (shouldSave) {
        await saveOpenAiApiKey(apiKey);
        dom.openAiApiKeyStatus.textContent = t('llm_apiKeySaved');
        dom.openAiApiKeyStatus.className = 'api-key-status success';
        dom.openAiApiKeyCard.classList.add('confirmed');
        dom.openAiApiKeySummary.textContent = t('llm_apiKeySummarySet');
    } else {
        await removeOpenAiApiKey();
        setSessionOpenAiApiKey(apiKey);
        dom.openAiApiKeyStatus.textContent = t('llm_apiKeySessionChanged');
        dom.openAiApiKeyStatus.className = 'api-key-status success';
        dom.openAiApiKeyCard.classList.add('confirmed');
        dom.openAiApiKeySummary.textContent = t('llm_apiKeySummarySession');
    }

    await notifyApiKeyChanged();
}

/**
 * 選択中モデルの provider に応じて API キーカードの強調表示を切り替える。
 * 該当カードを強調し、他の2つの強調を解除する。
 */
export function refreshApiKeyCardEmphasis(providerId: 'gemini' | 'openrouter' | 'openai'): void {
    dom.apiKeyCard.classList.toggle('emphasized', providerId === 'gemini');
    dom.openRouterApiKeyCard.classList.toggle('emphasized', providerId === 'openrouter');
    dom.openAiApiKeyCard.classList.toggle('emphasized', providerId === 'openai');
}
