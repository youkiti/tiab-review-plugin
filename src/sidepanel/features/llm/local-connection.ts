import { dom } from './dom';
import { populateModelSelect, setSelectedModel } from './model-combobox';
import { getLocalLlmEndpoint, saveLocalLlmEndpoint, saveLocalLlmModels } from '../../../lib/storage';
import { normalizeLocalLlmEndpoint, toLocalModelId } from '../../../lib/local-llm-model';
import { fetchLocalLlmModels, testLocalLlmChat } from '../../../lib/providers/local-llm';
import { t } from '../../../lib/i18n';
import { emitGuideEvent } from '../guide/lazy';
import { updateBatchTargetCount } from './batch/target-count';

function input(): HTMLInputElement {
    return document.getElementById('local-llm-endpoint') as HTMLInputElement;
}

function status(message: string, error = false): void {
    const element = document.getElementById('local-llm-status')!;
    element.textContent = message;
    element.className = error ? 'api-key-status error' : 'api-key-status';
}

export async function initializeLocalLlmConnection(): Promise<void> {
    input().value = await getLocalLlmEndpoint() ?? '';
}

export function wireLocalLlmConnection(refreshNote: () => Promise<void>): void {
    document.getElementById('local-llm-preset-ollama')!.addEventListener('click', () => {
        input().value = 'http://localhost:11434/v1/chat/completions';
    });
    document.getElementById('local-llm-preset-lmstudio')!.addEventListener('click', () => {
        input().value = 'http://localhost:1234/v1/chat/completions';
    });
    const button = document.getElementById('local-llm-save-test-btn') as HTMLButtonElement;
    button.addEventListener('click', async () => {
        if (button.disabled) {
            return;
        }
        try {
            const endpoint = normalizeLocalLlmEndpoint(input().value);
            const url = new URL(endpoint);
            // 権限要求をクリック直後に開始し、利用者の操作との関連を維持する。
            const permission = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
            button.disabled = true;
            if (!await permission) {
                status(t('llmExt_localPermissionDenied'), true);
                return;
            }
            await saveLocalLlmEndpoint(endpoint);
            status(t('llmExt_localFetching'));
            const models = await fetchLocalLlmModels(endpoint);
            await saveLocalLlmModels(models);
            await populateModelSelect();
            if (models.length === 0) {
                status(t('llmExt_localNoModels'), true);
                await refreshNote();
                return;
            }
            const current = dom.llmModelSelect.value;
            const model = models.map(toLocalModelId).includes(current) ? current : toLocalModelId(models[0]);
            setSelectedModel(model);
            await refreshNote();
            await updateBatchTargetCount();
            status(t('llmExt_localTesting'));
            await testLocalLlmChat(endpoint, model);
            status(t('llmExt_localSuccess', String(models.length)));
            emitGuideEvent('ai-key-saved');
        } catch (error) {
            status(error instanceof Error ? error.message : String(error), true);
        } finally {
            button.disabled = false;
        }
    });
}
