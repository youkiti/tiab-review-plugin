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
} from '../../../lib/storage';
import { testApiKey } from '../../../lib/gemini-api';

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
        }
    } else {
        dom.apiKeyStatus.textContent = '';
        dom.apiKeyStatus.className = 'api-key-status';
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
        return;
    }

    dom.apiKeyStatus.textContent = '検証中...';
    dom.apiKeyStatus.className = 'api-key-status';

    // APIキーを検証
    const isValid = await testApiKey(apiKey);
    if (!isValid) {
        dom.apiKeyStatus.textContent = '✕ 無効なAPIキーです';
        dom.apiKeyStatus.className = 'api-key-status error';
        return;
    }

    // 保存設定に応じて保存
    const shouldSave = dom.saveApiKeyCheckbox.checked;
    if (shouldSave) {
        await saveGeminiApiKey(apiKey);
        await setApiKeySavePreference(true);
        dom.apiKeyStatus.textContent = '✓ APIキーを保存しました';
    } else {
        setSessionApiKey(apiKey);
        dom.apiKeyStatus.textContent = '✓ APIキーを設定しました（セッション限り）';
    }
    dom.apiKeyStatus.className = 'api-key-status success';
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
    } else {
        // 保存済みキーを削除してセッションキーに切り替え
        await removeGeminiApiKey();
        setSessionApiKey(apiKey);
        dom.apiKeyStatus.textContent = '✓ セッション限りの設定に変更しました';
        dom.apiKeyStatus.className = 'api-key-status success';
    }
}
