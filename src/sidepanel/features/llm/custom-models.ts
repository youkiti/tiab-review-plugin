/**
 * OpenRouter カスタムモデル管理モジュール
 *
 * - ユーザーが手入力したモデルIDを実際に OpenRouter API へ問い合わせて試行
 * - 試行成功時のみ chrome.storage へ永続化
 * - 登録済みカスタムモデルの一覧表示・削除
 *
 * モデルセレクトの再構築は呼び出し側 (index.ts) のコールバックで行う。
 */

import { dom } from '../../dom';
import { t } from '../../../lib/i18n';
import {
    addCustomOpenRouterModel,
    getCustomOpenRouterModels,
    OPENROUTER_CUSTOM_MODELS_LIMIT,
    removeCustomOpenRouterModel,
    getEffectiveOpenRouterApiKey,
    type CustomOpenRouterModel,
} from '../../../lib/storage';
import { testOpenRouterModel } from '../../../lib/providers/openrouter';
import { AVAILABLE_MODELS } from '../../../lib/gemini-api';

/**
 * モデルリスト変更時のフック（モデルセレクト再構築用）。
 * index.ts 側から `setOnCustomModelsChanged()` で注入する。
 */
type CustomModelsChangedHandler = () => void | Promise<void>;
let onCustomModelsChanged: CustomModelsChangedHandler | null = null;

export function setOnCustomModelsChanged(handler: CustomModelsChangedHandler): void {
    onCustomModelsChanged = handler;
}

async function notifyCustomModelsChanged(): Promise<void> {
    if (!onCustomModelsChanged) return;
    try {
        await onCustomModelsChanged();
    } catch (err) {
        console.error('[notifyCustomModelsChanged] Error:', err);
    }
}

function setStatus(text: string, kind: 'loading' | 'success' | 'error' | ''): void {
    const el = dom.customModelStatus;
    el.textContent = text;
    el.className = kind ? `api-key-status ${kind}` : 'api-key-status';
}

function clearStatusInputs(): void {
    dom.customModelIdInput.value = '';
    dom.customModelLabelInput.value = '';
}

/**
 * 登録済みカスタムモデルを描画
 */
export async function loadCustomModelsList(): Promise<void> {
    const models = await getCustomOpenRouterModels();
    const ul = dom.customModelsList;
    ul.innerHTML = '';

    if (models.length === 0) {
        dom.customModelsEmpty.classList.remove('hidden');
        return;
    }
    dom.customModelsEmpty.classList.add('hidden');

    for (const model of models) {
        ul.appendChild(buildCustomModelListItem(model));
    }
}

function buildCustomModelListItem(model: CustomOpenRouterModel): HTMLLIElement {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.style.cssText = 'display:flex; flex-direction:column; gap:2px; min-width:0;';

    const idSpan = document.createElement('span');
    idSpan.className = 'custom-model-id';
    idSpan.textContent = model.id;
    info.appendChild(idSpan);

    if (model.label) {
        const labelSpan = document.createElement('span');
        labelSpan.className = 'custom-model-label-text';
        labelSpan.textContent = model.label;
        info.appendChild(labelSpan);
    }
    li.appendChild(info);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-custom-model';
    removeBtn.textContent = t('llm_customModelRemoveBtn');
    removeBtn.addEventListener('click', async () => {
        if (!window.confirm(t('llm_customModelRemoveConfirm', model.id))) return;
        await removeCustomOpenRouterModel(model.id);
        await loadCustomModelsList();
        await notifyCustomModelsChanged();
    });
    li.appendChild(removeBtn);

    return li;
}

/**
 * テスト + 保存ハンドラ
 *
 * 1. モデルIDのバリデーション（形式・重複・上限）
 * 2. OpenRouter API キーの存在確認
 * 3. 実 API 呼び出しでテスト
 * 4. 成功時のみ chrome.storage に保存
 */
export async function handleTestSaveCustomModel(): Promise<void> {
    const id = dom.customModelIdInput.value.trim();
    const label = dom.customModelLabelInput.value.trim() || undefined;

    if (!id) {
        setStatus(t('llm_customModelIdRequired'), 'error');
        return;
    }
    if (!id.includes('/') || id.startsWith('/') || id.endsWith('/')) {
        setStatus(t('llm_customModelIdInvalid'), 'error');
        return;
    }

    // ビルトイン重複チェック
    if (AVAILABLE_MODELS.some(m => m.id === id)) {
        setStatus(t('llm_customModelDuplicateBuiltIn'), 'error');
        return;
    }

    // 既存カスタム重複・上限チェック
    const existing = await getCustomOpenRouterModels();
    if (existing.some(m => m.id === id)) {
        setStatus(t('llm_customModelDuplicate'), 'error');
        return;
    }
    if (existing.length >= OPENROUTER_CUSTOM_MODELS_LIMIT) {
        setStatus(t('llm_customModelLimitReached', String(OPENROUTER_CUSTOM_MODELS_LIMIT)), 'error');
        return;
    }

    // API キー確認
    const apiKey = await getEffectiveOpenRouterApiKey();
    if (!apiKey) {
        setStatus(t('llm_customModelRequiresApiKey'), 'error');
        return;
    }

    // 実 API テスト
    dom.testSaveCustomModelBtn.disabled = true;
    setStatus(t('llm_customModelTesting'), 'loading');

    const testResult = await testOpenRouterModel(id);

    if (!testResult.ok) {
        dom.testSaveCustomModelBtn.disabled = false;
        setStatus(t('llm_customModelTestFailed', testResult.error || ''), 'error');
        return;
    }

    // テスト成功 → 保存
    const addResult = await addCustomOpenRouterModel({ id, label });
    dom.testSaveCustomModelBtn.disabled = false;

    if (!addResult.added) {
        // 競合（直前に同 ID が追加された等）。理由別にメッセージ。
        const key = addResult.reason === 'duplicate'
            ? 'llm_customModelDuplicate'
            : addResult.reason === 'limit'
                ? 'llm_customModelLimitReached'
                : 'llm_customModelIdInvalid';
        const arg = addResult.reason === 'limit' ? String(OPENROUTER_CUSTOM_MODELS_LIMIT) : undefined;
        setStatus(arg ? t(key, arg) : t(key), 'error');
        return;
    }

    setStatus(t('llm_customModelTestSuccess', id), 'success');
    clearStatusInputs();
    await loadCustomModelsList();
    await notifyCustomModelsChanged();
}
