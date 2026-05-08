/**
 * LLM APIキー管理モジュール
 */

import { dom } from '../../dom';
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
} from '../../../lib/storage';
import { testApiKeyWithTier } from '../../../lib/gemini-api';
import { showToast } from '../../ui/feedback';
import { t } from '../../../lib/i18n';
import type { ManualTier } from '../../../lib/types';

/**
 * Tier セレクタの表示を最新の manualTier に同期
 */
export async function refreshTierSelector(): Promise<void> {
    const manualTier = await getManualTier();
    if (!manualTier) {
        dom.tierSection.classList.add('hidden');
        return;
    }

    dom.tierSection.classList.remove('hidden');

    if (manualTier === 'free') {
        dom.tierFixedDisplay.textContent = t('llm_tierFree');
        dom.tierFixedDisplay.classList.remove('hidden');
        dom.tierSelect.classList.add('hidden');
    } else {
        dom.tierFixedDisplay.classList.add('hidden');
        dom.tierSelect.classList.remove('hidden');
        dom.tierSelect.value = manualTier;
    }
}

/**
 * Tier セレクタの変更を保存
 */
export async function handleTierChange(): Promise<void> {
    const value = dom.tierSelect.value;
    if (value === 'tier1' || value === 'tier2' || value === 'tier3') {
        await saveManualTier(value as ManualTier);
        showToast(t('llm_tierSaved', value));
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

    // 手動 tier を初期化:
    // - free 検出 → 'free' に固定
    // - paid 検出 → 既存の手動指定があれば維持、無ければ tier1 をデフォルト
    const existingManual = await getManualTier();
    if (result.tier === 'free') {
        await saveManualTier('free');
    } else if (result.tier === 'paid') {
        if (!existingManual || existingManual === 'free') {
            await saveManualTier('tier1');
        }
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

    // 無料版の場合は警告を表示
    if (result.tier === 'free') {
        showToast(t('llm_freeTierWarning'), 5000);
        console.log(`[handleApiKeyAutoSave] Free tier detected. Available models: ${result.availableModels.join(', ')}`);
    }

    await refreshTierSelector();
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
}
