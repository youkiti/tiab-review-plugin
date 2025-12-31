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
} from '../../../lib/storage';
import { testApiKeyWithTier } from '../../../lib/gemini-api';
import { showToast } from '../../ui/feedback';

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
            dom.apiKeyStatus.textContent = '✓ APIキーが設定されています';
            dom.apiKeyStatus.className = 'api-key-status success';

            // 保存済みの場合：確定状態のスタイルを適用し、折りたたむ
            dom.apiKeyCard.classList.add('confirmed', 'collapsed');
            dom.apiKeySummary.textContent = '✓ 設定済み';
        }
    } else {
        dom.apiKeyStatus.textContent = '';
        dom.apiKeyStatus.className = 'api-key-status';

        // 未設定の場合：確定状態を解除し、展開
        dom.apiKeyCard.classList.remove('confirmed', 'collapsed');
        dom.apiKeySummary.textContent = '';
    }
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
        return;
    }

    dom.apiKeyStatus.textContent = '検証中...';
    dom.apiKeyStatus.className = 'api-key-status';

    // APIキーを検証（tier検出含む）
    const result = await testApiKeyWithTier(apiKey);
    if (!result.isValid) {
        dom.apiKeyStatus.textContent = '✕ 無効なAPIキーです';
        dom.apiKeyStatus.className = 'api-key-status error';
        return;
    }

    // 保存設定に応じて保存
    const shouldSave = dom.saveApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveGeminiApiKey(apiKey);
        await setApiKeySavePreference(true);
        await saveApiTier(result.tier);
        dom.apiKeyStatus.textContent = '✓ APIキーを保存しました';

        // 保存済みの場合：確定状態のスタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = '✓ 設定済み';
    } else {
        setSessionApiKey(apiKey);
        setSessionApiTier(result.tier);
        dom.apiKeyStatus.textContent = '✓ APIキーを設定しました（セッション限り）';

        // セッション限りの場合：確定スタイルは適用するが、展開したまま
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = '✓ セッション';
    }
    dom.apiKeyStatus.className = 'api-key-status success';

    // 無料版の場合は警告を表示
    if (result.tier === 'free') {
        showToast('無料版APIキーを検出しました。処理速度が制限されます（約13秒/件）', 5000);
        console.log(`[handleApiKeyAutoSave] Free tier detected. Available models: ${result.availableModels.join(', ')}`);
    }
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
        dom.apiKeyStatus.textContent = '✓ APIキーを保存しました';
        dom.apiKeyStatus.className = 'api-key-status success';

        // 確定状態のスタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = '✓ 設定済み';
    } else {
        // 保存済みキーを削除してセッションキーに切り替え
        await removeGeminiApiKey();
        setSessionApiKey(apiKey);
        dom.apiKeyStatus.textContent = '✓ セッション限りの設定に変更しました';
        dom.apiKeyStatus.className = 'api-key-status success';

        // セッション限りの場合：確定スタイルを適用
        dom.apiKeyCard.classList.add('confirmed');
        dom.apiKeySummary.textContent = '✓ セッション';
    }
}
